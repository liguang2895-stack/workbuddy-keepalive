/**
 * WorkBuddy KeepAlive - 浏览器持续在线保活
 * =========================================
 * 不拦截任何资源，让页面完全加载。
 * 浏览器永不关闭，持续保持 WebSocket 连接。
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');

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

const GLOBAL_START = Date.now();
let wsConnected = false;

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
  console.log(`Chrome: ${chromePath}\n`);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--no-first-run',
    ],
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
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'
  );

  // ===== 步骤1: 打开首页 =====
  console.log('[1/4] 打开首页...');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log(`  首页标题: "${await page.title()}"`);
  console.log(`  首页URL: ${page.url()}`);

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

  // ===== 步骤3: 打开目标页面（不拦截任何资源）=====
  console.log('\n[3/4] 打开目标页面...');
  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (err) {
    console.warn(`  加载警告: ${err.message} (继续)`);
  }

  const currentTitle = await page.title();
  const currentUrl = page.url();
  console.log(`  标题: "${currentTitle}"`);
  console.log(`  URL: ${currentUrl}`);

  // 等待 WebSocket 建立
  console.log('\n[WebSocket] 等待连接建立...');
  for (let i = 0; i < 30; i++) {
    if (wsConnected) break;
    await new Promise(r => setTimeout(r, 1000));
    process.stdout.write('.');
  }
  console.log(`\n[WebSocket] 状态: ${wsConnected ? '已连接 ✓' : '未检测到'}`);

  // 检查登录状态
  if (currentUrl.includes('login') || currentTitle.includes('登录')) {
    console.error('\n❌ 页面在登录页！cookie 可能已过期。');
    console.error('请在本地重新运行: npm run login');
    process.exit(1);
  }

  // ===== 步骤4: 持续保活 =====
  console.log('\n[4/4] 开始持续保活 (浏览器永不关闭)\n');

  let beatNum = 0;

  while (true) {
    beatNum++;
    const elapsedMin = Math.floor((Date.now() - GLOBAL_START) / 60000);
    const elapsedSec = Math.floor((Date.now() - GLOBAL_START) / 1000) % 60;

    try {
      // 心跳
      await page.evaluate(() => fetch(window.location.pathname, { method: 'HEAD' }).catch(() => {}));
      await page.keyboard.press('Shift');
      // 检查页面状态
      const url = page.url();
      if (url.includes('login')) {
        console.log(`\n[警告] 页面跳转到登录页! 尝试回退...`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
    } catch (err) {
      console.log(`\n[心跳错误] ${err.message}`);
    }

    process.stdout.write(`\r  心跳 #${beatNum} | 运行 ${elapsedMin}分${elapsedSec}秒 | WebSocket ${wsConnected ? '✓' : '✗'}`);

    await new Promise(r => setTimeout(r, 20000));
  }
}

main().catch(err => {
  console.error(`\n[致命] ${err.message}`);
  process.exit(1);
});
