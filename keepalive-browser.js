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

  let capturedQrUrl = '';
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('open.weixin.qq.com/connect/qrcode/')) {
      capturedQrUrl = url;
    }
  });
  page.on('response', (res) => {
    const url = res.url();
    if (url.includes('open.weixin.qq.com/connect/qrcode/')) {
      capturedQrUrl = url;
    }
  });

  // 强制打开登录页，不能只访问 task 页；未登录时 task 页也可能保持原 URL，容易误判
  const loginUrl = `${BASE_URL}/login/?platform=agents&state=0&redirect_uri=${encodeURIComponent(targetUrl)}`;
  console.log(`打开微信登录页: ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  // 勾选“我已阅读并同意《服务条款》和《隐私协议》”，二维码会在勾选后出现
  console.log('尝试勾选协议...');
  await page.waitForSelector('label.t-checkbox, .bottom-tip .t-checkbox, input[type="checkbox"]', { timeout: 15000 }).catch(() => {});

  const beforeAgree = await page.evaluate(() => ({
    checkboxClass: document.querySelector('.t-checkbox')?.className || '',
    inputChecked: document.querySelector('input[type="checkbox"]')?.checked ?? null,
    iframeCount: document.querySelectorAll('iframe').length,
    bodyText: document.body?.innerText?.substring(0, 200) || '',
  })).catch(() => null);
  console.log('勾选前:', JSON.stringify(beforeAgree));

  // 必须使用真实鼠标点击，React/TDesign 的隐藏 input 直接 click 可能不触发状态更新
  const checkboxHandle = await page.$('label.t-checkbox, .bottom-tip .t-checkbox, .t-checkbox__input');
  if (checkboxHandle) {
    await checkboxHandle.click({ delay: 100 });
  } else {
    // 兜底：点击页面下方协议区域的大概位置
    await page.mouse.click(520, 760);
  }

  await new Promise(r => setTimeout(r, 5000));

  const afterAgree = await page.evaluate(() => ({
    checkboxClass: document.querySelector('.t-checkbox')?.className || '',
    inputChecked: document.querySelector('input[type="checkbox"]')?.checked ?? null,
    iframeCount: document.querySelectorAll('iframe').length,
    iframeSrc: document.querySelector('iframe')?.src || '',
    bodyText: document.body?.innerText?.substring(0, 200) || '',
  })).catch(() => null);
  console.log('勾选后:', JSON.stringify(afterAgree));

  fs.writeFileSync('login-debug.html', await page.content());
  await page.waitForSelector('iframe#wechat-iframe, iframe', { timeout: 15000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  const startTime = Date.now();
  let printedQr = false;

  while (Date.now() - startTime < LOGIN_TIMEOUT) {
    const currentUrl = page.url();
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');

    // 真正登录成功的特征：左侧历史/用户名/对话内容出现，而不是仅仅 URL 是 /task/
    const loggedIn = currentUrl.includes('/app/task/') && (
      bodyText.includes('出其东门') ||
      bodyText.includes('最近') ||
      bodyText.includes('新建任务') ||
      bodyText.includes('查看所有变更') ||
      bodyText.includes('怎么打不开了') ||
      bodyText.includes('已经恢复了')
    );

    if (loggedIn) {
      console.log(`\n✅ 检测到真实登录成功！`);
      console.log(`   当前 URL: ${currentUrl}`);
      console.log(`   页面特征: ${bodyText.substring(0, 120).replace(/\n/g, ' ')}`);

      freshCookies = await page.cookies();
      console.log(`   已提取 ${freshCookies.length} 个 cookies`);

      const sessionData = {
        createdAt: new Date().toISOString(),
        cookies: freshCookies,
        taskId: taskId,
      };
      fs.writeFileSync('session-data.json', JSON.stringify(sessionData, null, 2));
      console.log('   已保存 session-data.json');
      return true;
    }

    // 从网络请求或微信 iframe 中找二维码
    if (!printedQr) {
      let qrUrl = capturedQrUrl;

      if (!qrUrl) {
        for (const frame of page.frames()) {
          const frameUrl = frame.url();
          if (frameUrl.includes('open.weixin.qq.com/connect/qrconnect')) {
            console.log(`微信 iframe: ${frameUrl.substring(0, 180)}...`);
          }
          const img = await frame.$('img.qrcode, img[class*="qrcode"], .qrcode img').catch(() => null);
          if (img) {
            const src = await img.evaluate(el => el.getAttribute('src') || el.src).catch(() => '');
            if (src) {
              const origin = new URL(frameUrl).origin;
              qrUrl = src.startsWith('http') ? src : `${origin}${src}`;
              break;
            }
          }
        }
      }

      await page.screenshot({ path: 'qrcode.png', fullPage: false }).catch(() => {});

      if (qrUrl) {
        printedQr = true;
        fs.writeFileSync('qrcode-url.txt', qrUrl);
        console.log(`\n========================================`);
        console.log(`  请用微信扫描二维码登录`);
        console.log(`  二维码 URL: ${qrUrl}`);
        console.log(`  打开这个 URL 就是二维码图片，可用微信扫码`);
        console.log(`========================================\n`);
      } else {
        const frames = page.frames().map(f => f.url()).filter(Boolean).slice(0, 5);
        console.log(`[${new Date().toLocaleTimeString()}] 未找到二维码，继续等待... 当前URL: ${currentUrl}`);
        console.log(`  frames: ${frames.join(' | ')}`);
      }
    } else {
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
  // 不再使用旧 cookies 自动判断，避免未登录页面 URL 仍是 /task/ 导致误判。
  const loggedIn = await waitForLogin(page, targetUrl, taskId);
  if (!loggedIn) {
    await browser.close();
    process.exit(1);
  }

  // ===== 阶段2: 保活 =====
  await startKeepalive(page, targetUrl);
}

main().catch(err => {
  console.error(`\n[错误] ${err.message}`);
  triggerNextRun();
  process.exit(1);
});
