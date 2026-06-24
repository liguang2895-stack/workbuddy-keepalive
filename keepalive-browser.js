/**
 * WorkBuddy KeepAlive - 二维码登录 + 持续保活
 * ============================================
 * 阶段1: 打开页面 → 展示微信二维码 → 等待扫码登录
 * 阶段2: 登录成功 → 提取 cookies → 持续心跳保活
 * 阶段3: 5小时后自动触发 GitHub Actions 接力
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const https = require('https');

const BASE_URL = 'https://www.workbuddy.cn';
const CHROME_PATHS = [
  '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
];

function findChrome() {
  for (const p of CHROME_PATHS) { if (fs.existsSync(p)) return p; }
  return '/usr/bin/chromium-browser';
}

/** GitHub API 触发下一轮保活 */
function triggerNextRun() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  if (!token || !repo) { return false; }
  const postData = JSON.stringify({ ref: 'master' });
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${repo}/actions/workflows/keepalive.yml/dispatches`,
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'workbuddy-keepalive' },
  };
  const req = https.request(options);
  req.on('error', () => {});
  req.write(postData);
  req.end();
  return true;
}

const GLOBAL_START = Date.now();
let wsConnected = false;
let restartTriggered = false;
let freshCookies = null;

async function waitForLogin(page, targetUrl, taskId) {
  const QR_POLL_INTERVAL = 2000;
  const LOGIN_TIMEOUT = 30 * 60 * 1000; // 最长等30分钟

  console.log('\n========================================');
  console.log('  阶段1: 等待微信扫码登录');
  console.log('========================================\n');

  // 导航到目标页（会被重定向到登录页）
  console.log(`导航到: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  const startTime = Date.now();

  while (Date.now() - startTime < LOGIN_TIMEOUT) {
    // 检查是否已经登录成功（URL 包含 /task/）
    const currentUrl = page.url();
    if (currentUrl.includes('/task/')) {
      console.log(`\n✅ 检测到登录成功！`);
      console.log(`   当前 URL: ${currentUrl}`);

      // 提取新鲜 cookies
      freshCookies = await page.cookies();
      console.log(`   已提取 ${freshCookies.length} 个 cookies`);

      // 保存到文件
      const sessionData = {
        createdAt: new Date().toISOString(),
        cookies: freshCookies,
        taskId: taskId,
      };
      fs.writeFileSync('session-data.json', JSON.stringify(sessionData, null, 2));
      console.log('   已保存 session-data.json');

      return true;
    }

    // 截图二维码
    const qrImg = await page.$('img[class*="qrcode"], .qrcode img, [class*="qrcode"] img');
    if (qrImg) {
      const src = await qrImg.evaluate(el => el.src);
      // 打印二维码 URL 到日志（用户可立即看到）
      const fullQrUrl = src.startsWith('http') ? src : `https://www.workbuddy.cn${src}`;
      console.log(`\n========================================`);
      console.log(`  请用微信扫描下方二维码登录`);
      console.log(`  二维码 URL: ${fullQrUrl}`);
      console.log(`  （如果无法直接扫描，请下载 qrcode.png artifact）`);
      console.log(`========================================\n`);
      // 保存二维码 URL 到文件
      fs.writeFileSync('qrcode-url.txt', fullQrUrl);

      // 截图保存二维码图片
      try {
        await page.screenshot({ path: 'qrcode.png', clip: await qrImg.boundingBox() });
        console.log(`  二维码已截图保存到 qrcode.png`);
      } catch (e) {
        // 兜底: 截全屏
        await page.screenshot({ path: 'qrcode.png' });
      }
    } else {
      // 如果没有找到二维码元素，截全屏
      await page.screenshot({ path: 'qrcode.png' });
      process.stdout.write('.');
    }

    process.stdout.write('.');
    await new Promise(r => setTimeout(r, QR_POLL_INTERVAL));
  }

  console.error('\n❌ 登录超时（30分钟），请重新触发 workflow');
  await page.screenshot({ path: 'login-timeout.png' });
  return false;
}

async function startKeepalive(page, targetUrl) {
  console.log('\n========================================');
  console.log('  阶段2: 开始持续保活');
  console.log('========================================\n');

  // 确保在正确的页面上
  const currentUrl = page.url();
  if (!currentUrl.includes('/task/')) {
    console.log(`重新导航到: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  }

  // 等待 WebSocket 建立
  console.log('\n等待 WebSocket 连接...');
  for (let i = 0; i < 60; i++) {
    if (wsConnected) break;
    await new Promise(r => setTimeout(r, 1000));
    process.stdout.write('.');
  }
  console.log(`\nWebSocket: ${wsConnected ? '已连接 ✓' : '未检测到'}`);

  // 获取对话记录以确认登录
  const text = await page.evaluate(() => document.body?.innerText?.substring(0, 300) || '');
  console.log(`页面内容: "${text.replace(/\n/g, ' ').substring(0, 100)}..."`);

  // 心跳循环
  const RESTART_INTERVAL = 5 * 60 * 60 * 1000;
  const HEARTBEAT_INTERVAL = 20000;
  let beatNum = 0;

  console.log('\n开始心跳保活 (每20秒)\n');

  while (true) {
    beatNum++;
    const elapsedMs = Date.now() - GLOBAL_START;
    const elapsedHr = Math.floor(elapsedMs / 3600000);
    const elapsedMin = Math.floor(elapsedMs / 60000) % 60;

    try {
      await page.evaluate(() => {
        fetch(window.location.pathname, { method: 'HEAD' }).catch(() => {});
      });
      await page.keyboard.press('Shift');
    } catch (e) {}

    process.stdout.write(`\r  心跳 #${beatNum} | 运行 ${elapsedHr}h${elapsedMin}m | WS:${wsConnected ? '✓' : '✗'}`);

    // 5小时自动触发接力
    if (!restartTriggered && elapsedMs >= RESTART_INTERVAL) {
      restartTriggered = true;
      console.log(`\n\n[接力] 运行 ${elapsedHr} 小时，触发下一轮...`);
      triggerNextRun();
    }

    await new Promise(r => setTimeout(r, HEARTBEAT_INTERVAL));
  }
}

async function main() {
  console.log('========================================');
  console.log('  WorkBuddy KeepAlive - 二维码登录版');
  console.log('========================================\n');

  const taskId = process.env.TASK_ID || '2069611353750118400';
  const targetUrl = `${BASE_URL}/app/task/${taskId}`;
  console.log(`目标: ${targetUrl}`);

  const chromePath = findChrome();
  console.log(`Chrome: ${chromePath}`);
  console.log(`xvfb: ${process.env.DISPLAY || '无'}\n`);

  // 启动浏览器
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.DISPLAY ? false : 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--no-first-run',
      '--window-size=1280,900',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  console.log('浏览器已启动\n');

  const page = await browser.newPage();

  // 监听 WebSocket
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', ({ url }) => {
    if (!wsConnected) {
      wsConnected = true;
      console.log(`[WebSocket] 连接: ${url.substring(0, 80)}`);
    }
  });
  cdp.on('Network.webSocketClosed', () => {
    wsConnected = false;
  });

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  );

  // ===== 阶段1: 登录 =====
  let loggedIn = false;
  // 先尝试使用之前的 session-data.json（如果有）
  if (fs.existsSync('session-data.json')) {
    try {
      const saved = JSON.parse(fs.readFileSync('session-data.json', 'utf-8'));
      if (saved.cookies && saved.cookies.length > 0) {
        console.log('[尝试] 使用已保存的 cookies 恢复登录...');
        const valid = saved.cookies.map(c => ({
          name: c.name, value: c.value,
          domain: c.domain || '.workbuddy.cn', path: c.path || '/',
          httpOnly: c.httpOnly ?? false, secure: c.secure ?? true,
          sameSite: c.sameSite || 'Lax',
        }));
        await page.setCookie(...valid);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        const url = page.url();
        if (url.includes('/task/')) {
          console.log('  ✅ 旧 cookies 仍有效，直接进入保活\n');
          freshCookies = saved.cookies;
          loggedIn = true;
        } else {
          console.log('  ⚠️ 旧 cookies 已过期，需要重新扫码\n');
        }
      }
    } catch (e) {}
  }

  if (!loggedIn) {
    loggedIn = await waitForLogin(page, targetUrl, taskId);
    if (!loggedIn) {
      await browser.close();
      process.exit(1);
    }
  }

  // ===== 阶段2: 保活 =====
  await startKeepalive(page, targetUrl);
}

main().catch(err => {
  console.error(`\n[错误] ${err.message}`);
  triggerNextRun();
  process.exit(1);
});
