/**
 * WorkBuddy KeepAlive - 浏览器持续在线保活
 * =========================================
 * - xvfb 虚拟桌面 + 非 headless 模式（渲染完整，避免反爬检测）
 * - 浏览器永不关闭，持续保持 WebSocket 连接
 * - 5小时自动触发新的 workflow run（接力保活）
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const https = require('https');

const BASE_URL = 'https://www.workbuddy.cn';
const CHROME_PATHS = [
  '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
];

function loadConfig() {
  let data = null;
  if (process.env.SESSION_DATA) {
    try { data = JSON.parse(process.env.SESSION_DATA); } catch (e) { console.error('SESSION_DATA 解析失败:', e.message); }
  }
  const fp = require('path').resolve('session-data.json');
  if (!data && fs.existsSync(fp)) { data = JSON.parse(fs.readFileSync(fp, 'utf-8')); }
  if (!data) throw new Error('未找到会话数据');
  return {
    cookies: data.cookies || [],
    taskId: process.env.TASK_ID || data.taskId || '',
  };
}

function findChrome() {
  for (const p of CHROME_PATHS) { if (fs.existsSync(p)) return p; }
  try { const p = require('puppeteer-core').executablePath(); if (fs.existsSync(p)) return p; } catch {}
  return '/usr/bin/google-chrome';
}

/** 通过 GitHub API 触发新的 workflow run（接力保活） */
function triggerNextRun() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.log('  跳过自动重启: 缺少 GH_TOKEN 或 GH_REPO');
    return false;
  }

  const postData = JSON.stringify({ ref: 'master' });
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${repo}/actions/workflows/keepalive.yml/dispatches`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'workbuddy-keepalive',
    },
  };

  const req = https.request(options, (res) => {
    console.log(`  触发结果: HTTP ${res.statusCode} ${res.statusMessage}`);
  });
  req.on('error', (e) => console.error('  触发失败:', e.message));
  req.write(postData);
  req.end();
  return true;
}

const GLOBAL_START = Date.now();
let wsConnected = false;
let restartTriggered = false;

async function main() {
  console.log('========================================');
  console.log('  WorkBuddy KeepAlive');
  console.log('========================================\n');

  const config = loadConfig();
  const targetUrl = config.taskId
    ? `${BASE_URL}/app/task/${config.taskId}`
    : `${BASE_URL}/app`;

  console.log(`目标: ${targetUrl}`);
  console.log(`Cookies: ${config.cookies.length} 个`);

  const chromePath = findChrome();
  console.log(`Chrome: ${chromePath}`);

  // 检测是否在 xvfb 环境中
  const hasDisplay = !!process.env.DISPLAY;
  console.log(`xvfb 显示: ${hasDisplay ? `${process.env.DISPLAY}` : '无 (使用 headless)'}\n`);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: hasDisplay ? false : 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-notifications',
      '--window-size=1280,800',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });

  console.log('浏览器已启动\n');

  const page = await browser.newPage();

  // 监听 WebSocket
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', ({ url }) => {
    if (!wsConnected) {
      wsConnected = true;
      console.log(`[WebSocket] 已连接: ${url.substring(0, 80)}`);
    }
  });
  cdp.on('Network.webSocketClosed', () => {
    wsConnected = false;
    console.log(`\n[WebSocket] 连接已关闭 (${new Date().toISOString()})`);
  });

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  );

  // ===== 步骤1: 打开首页 =====
  console.log('[1/4] 打开首页...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  console.log(`  首页标题: "${await page.title()}"`);

  // ===== 步骤2: 注入 cookies =====
  console.log('\n[2/4] 注入 cookies...');
  if (config.cookies.length > 0) {
    const valid = config.cookies.map(c => ({
      name: c.name, value: c.value,
      domain: c.domain || '.workbuddy.cn',
      path: c.path || '/',
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? true,
      sameSite: c.sameSite || 'Lax',
    }));
    await page.setCookie(...valid);
    console.log(`  已注入 ${valid.length} 个 cookies`);
  }

  // ===== 步骤3: 打开目标页面 =====
  console.log('\n[3/4] 打开目标页面...');
  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (err) {
    console.warn(`  加载警告: ${err.message} (继续)`);
  }
  await new Promise(r => setTimeout(r, 3000)); // 等 JS 执行

  const currentTitle = await page.title();
  const currentUrl = page.url();
  console.log(`  标题: "${currentTitle}"`);
  console.log(`  URL: ${currentUrl}`);

  // 检查登录页文本
  const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
  if (currentUrl.includes('login') || currentTitle.includes('登录') || bodyText.includes('微信扫码登录')) {
    console.error('\n❌ 页面在登录页！cookie 已过期或反爬检测。');
    console.error('请在本地重新运行: npm run login');
    // 截一张图辅助诊断
    await page.screenshot({ path: '/tmp/login-fail.png' }).catch(() => {});
    process.exit(1);
  }
  console.log('  ✅ 登录验证通过');

  // 等待 WebSocket 建立（最多60秒）
  console.log('\n[WebSocket] 等待连接建立...');
  for (let i = 0; i < 60; i++) {
    if (wsConnected) break;
    await new Promise(r => setTimeout(r, 1000));
    process.stdout.write('.');
  }
  console.log(`\n[WebSocket] 状态: ${wsConnected ? '已连接 ✓' : '未检测到'}`);

  // ===== 步骤4: 持续保活 =====
  console.log('\n[4/4] 开始持续保活 (浏览器永不关闭)\n');

  let beatNum = 0;
  const RESTART_INTERVAL = 5 * 60 * 60 * 1000; // 5小时触发重启
  const HEARTBEAT_INTERVAL = 20000; // 20秒心跳

  while (true) {
    beatNum++;
    const elapsedMs = Date.now() - GLOBAL_START;
    const elapsedMin = Math.floor(elapsedMs / 60000);
    const elapsedSec = Math.floor(elapsedMs / 1000) % 60;
    const elapsedHr = Math.floor(elapsedMs / 3600000);

    // -- 心跳 --
    try {
      await page.evaluate(() => {
        fetch(window.location.pathname, { method: 'HEAD' }).catch(() => {});
      });
      await page.keyboard.press('Shift');
      // 检查页面是否跳转到登录页
      const url = page.url();
      if (url.includes('login')) {
        console.log(`\n[警告] 页面跳转到登录页! 尝试恢复...`);
        // 重新注入 cookies 并导航回去
        if (config.cookies.length > 0) {
          const valid = config.cookies.map(c => ({name: c.name, value: c.value, domain: c.domain || '.workbuddy.cn', path: c.path || '/', httpOnly: c.httpOnly ?? false, secure: c.secure ?? true, sameSite: c.sameSite || 'Lax'}));
          await page.setCookie(...valid);
        }
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log('  已尝试恢复');
      }
    } catch (err) {
      // 页面可能崩溃了，但浏览器还在
    }

    process.stdout.write(`\r  心跳 #${beatNum} | 运行 ${elapsedHr}时${elapsedMin}分 | WebSocket ${wsConnected ? '✓' : '✗'}`);

    // -- 5小时自动触发重启接力 --
    if (!restartTriggered && elapsedMs >= RESTART_INTERVAL) {
      restartTriggered = true;
      console.log(`\n\n[重启] 运行 ${elapsedHr} 小时，触发下一轮保活...`);
      triggerNextRun();
    }

    await new Promise(r => setTimeout(r, HEARTBEAT_INTERVAL));
  }
}

main().catch(err => {
  console.error(`\n[致命] ${err.message}`);
  // 触发重启
  triggerNextRun();
  process.exit(1);
});
