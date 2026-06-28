/**
 * WorkBuddy KeepAlive - 自动接力版
 * ==================================
 * 1. 优先从 session-data.json 恢复登录（由 GitHub Actions Cache 保存）
 * 2. 如果恢复失败，再展示微信二维码，用户扫码登录
 * 3. 登录成功后持续保活 5 小时
 * 4. 5 小时时先触发下一轮 workflow，本轮继续保活 3 分钟再退出
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const { Buffer } = require('buffer');

const BASE_URL = 'https://www.workbuddy.cn';
const SESSION_FILE = 'session-data.json';
const CHROME_PATHS = ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];

const GLOBAL_START = Date.now();
const RENEW_INTERVAL = 5 * 60 * 60 * 1000;
const OVERLAP_INTERVAL = 3 * 60 * 1000;
const HEARTBEAT_INTERVAL = 20000;
let wsConnected = false;

function findChrome() {
  for (const p of CHROME_PATHS) if (fs.existsSync(p)) return p;
  return '/usr/bin/chromium-browser';
}

function loginFeatures(text) {
  return text.includes('出其东门') ||
    text.includes('最近') ||
    text.includes('新建任务') ||
    text.includes('查看所有变更') ||
    text.includes('怎么打不开了') ||
    text.includes('已经恢复了');
}

async function isReallyLoggedIn(page) {
  const url = page.url();
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  return url.includes('/app/task/') && loginFeatures(text);
}

async function saveSession(page, taskId) {
  const cookies = await page.cookies();
  const sessionData = {
    createdAt: new Date().toISOString(),
    cookies,
    taskId,
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2));
  console.log(`已保存 ${SESSION_FILE}，cookies: ${cookies.length} 个`);
}

async function restoreSession(page, targetUrl) {
  if (!fs.existsSync(SESSION_FILE)) {
    console.log('未发现缓存 session-data.json，需要扫码登录');
    return false;
  }

  console.log('发现缓存 session-data.json，尝试恢复登录...');
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    if (!data.cookies?.length) return false;

    const valid = data.cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '.workbuddy.cn',
      path: c.path || '/',
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? true,
      sameSite: c.sameSite || 'Lax',
    }));

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.setCookie(...valid);
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));

    const ok = await isReallyLoggedIn(page);
    if (ok) {
      const text = await page.evaluate(() => document.body?.innerText?.substring(0, 160) || '');
      console.log('✅ 缓存 session 恢复成功');
      console.log(`页面特征: ${text.replace(/\n/g, ' ')}`);
      return true;
    }

    console.log('⚠️ 缓存 session 无效，需要重新扫码');
    return false;
  } catch (e) {
    console.log(`⚠️ 恢复 session 失败: ${e.message}`);
    return false;
  }
}

async function waitForLogin(page, targetUrl, taskId) {
  const QR_POLL_INTERVAL = 2000;
  const LOGIN_TIMEOUT = 30 * 60 * 1000;

  console.log('\n========================================');
  console.log('  阶段1: 等待微信扫码登录');
  console.log('========================================\n');

  let capturedQrUrl = '';
  page.on('request', req => {
    const url = req.url();
    if (url.includes('open.weixin.qq.com/connect/qrcode/')) capturedQrUrl = url;
  });
  page.on('response', res => {
    const url = res.url();
    if (url.includes('open.weixin.qq.com/connect/qrcode/')) capturedQrUrl = url;
  });

  const loginUrl = `${BASE_URL}/login/?platform=agents&state=0&redirect_uri=${encodeURIComponent(targetUrl)}`;
  console.log(`打开微信登录页: ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  console.log('尝试勾选协议...');
  await page.waitForSelector('label.t-checkbox, .bottom-tip .t-checkbox, input[type="checkbox"]', { timeout: 15000 }).catch(() => {});

  const beforeAgree = await page.evaluate(() => ({
    checkboxClass: document.querySelector('.t-checkbox')?.className || '',
    inputChecked: document.querySelector('input[type="checkbox"]')?.checked ?? null,
    iframeCount: document.querySelectorAll('iframe').length,
    bodyText: document.body?.innerText?.substring(0, 200) || '',
  })).catch(() => null);
  console.log('勾选前:', JSON.stringify(beforeAgree));

  const checkboxHandle = await page.$('label.t-checkbox, .bottom-tip .t-checkbox, .t-checkbox__input');
  if (checkboxHandle) await checkboxHandle.click({ delay: 100 });
  else await page.mouse.click(520, 760);

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
    if (await isReallyLoggedIn(page)) {
      const currentUrl = page.url();
      const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      console.log('\n✅ 检测到真实登录成功！');
      console.log(`   当前 URL: ${currentUrl}`);
      console.log(`   页面特征: ${bodyText.substring(0, 120).replace(/\n/g, ' ')}`);
      await saveSession(page, taskId);
      return true;
    }

    if (!printedQr) {
      let qrUrl = capturedQrUrl;
      if (!qrUrl) {
        for (const frame of page.frames()) {
          const frameUrl = frame.url();
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
        console.log('\n========================================');
        console.log('  请用微信扫描二维码登录');
        console.log(`  二维码 URL: ${qrUrl}`);
        console.log('  打开这个 URL 就是二维码图片，可用微信扫码');
        console.log('========================================\n');
      } else {
        const frames = page.frames().map(f => f.url()).filter(Boolean).slice(0, 5);
        console.log(`[${new Date().toLocaleTimeString()}] 未找到二维码，继续等待...`);
        console.log(`  frames: ${frames.join(' | ')}`);
      }
    } else {
      process.stdout.write('.');
    }

    await new Promise(r => setTimeout(r, QR_POLL_INTERVAL));
  }

  console.error('\n❌ 登录超时（30分钟），请重新触发 workflow');
  await page.screenshot({ path: 'login-timeout.png' }).catch(() => {});
  return false;
}

async function triggerNextWorkflow() {
  const token = process.env.GH_TOKEN;
  const repo = process.env.GH_REPO;
  const ref = process.env.GH_REF || 'master';

  if (!token || !repo) {
    console.log('[接力] 未提供 GH_TOKEN/GH_REPO，交给 workflow 结束步骤兜底触发');
    fs.writeFileSync('trigger-fallback.txt', new Date().toISOString());
    return false;
  }

  const url = `https://api.github.com/repos/${repo}/actions/workflows/keepalive.yml/dispatches`;
  const sessionDataB64 = fs.existsSync(SESSION_FILE)
    ? Buffer.from(fs.readFileSync(SESSION_FILE, 'utf-8'), 'utf-8').toString('base64')
    : '';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'workbuddy-keepalive',
    },
    body: JSON.stringify({
      ref,
      inputs: sessionDataB64 ? { session_data_b64: sessionDataB64 } : {},
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }

  fs.writeFileSync('trigger-next.txt', new Date().toISOString());
  console.log('[接力] 已触发下一轮 workflow，本轮继续保活3分钟');
  return true;
}

async function startKeepalive(page, targetUrl, taskId) {
  console.log('\n========================================');
  console.log('  阶段2: 开始持续保活');
  console.log('========================================\n');

  if (!page.url().includes('/task/')) {
    console.log(`重新导航到: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  }

  console.log('\n等待 WebSocket 连接...');
  for (let i = 0; i < 30; i++) {
    if (wsConnected) break;
    await new Promise(r => setTimeout(r, 1000));
    process.stdout.write('.');
  }
  console.log(`\nWebSocket: ${wsConnected ? '已连接 ✓' : '未检测到'}`);

  const text = await page.evaluate(() => document.body?.innerText?.substring(0, 300) || '');
  console.log(`页面内容: "${text.replace(/\n/g, ' ').substring(0, 120)}..."`);

  let beatNum = 0;
  let nextTriggered = false;
  let overlapStartedAt = 0;

  console.log('\n开始心跳保活 (每20秒)，5小时后先触发下一轮，本轮继续保活3分钟再退出\n');

  while (true) {
    beatNum++;
    const elapsedMs = Date.now() - GLOBAL_START;
    const elapsedHr = Math.floor(elapsedMs / 3600000);
    const elapsedMin = Math.floor(elapsedMs / 60000) % 60;

    try {
      await page.evaluate(() => fetch(window.location.pathname, { method: 'HEAD' }).catch(() => {}));
      await page.keyboard.press('Shift');

      if (beatNum % 15 === 0) {
        await saveSession(page, taskId);
      }
    } catch (e) {}

    const overlapText = nextTriggered ? ` | 重叠 ${Math.floor((Date.now() - overlapStartedAt) / 60000)}m/3m` : '';
    process.stdout.write(`\r  心跳 #${beatNum} | 运行 ${elapsedHr}h${elapsedMin}m | WS:${wsConnected ? '✓' : '✗'}${overlapText}`);

    if (!nextTriggered && elapsedMs >= RENEW_INTERVAL) {
      console.log('\n\n[接力] 已运行5小时，保存 session 并立即触发下一轮...');
      await saveSession(page, taskId).catch(() => {});
      try {
        await triggerNextWorkflow();
      } catch (e) {
        console.log(`[接力] 触发下一轮失败: ${e.message}`);
        fs.writeFileSync('trigger-fallback.txt', new Date().toISOString());
      }
      nextTriggered = true;
      overlapStartedAt = Date.now();
    }

    if (nextTriggered && Date.now() - overlapStartedAt >= OVERLAP_INTERVAL) {
      console.log('\n\n[接力] 重叠保活3分钟已完成，本轮退出');
      await saveSession(page, taskId).catch(() => {});
      return;
    }

    await new Promise(r => setTimeout(r, HEARTBEAT_INTERVAL));
  }
}

async function main() {
  console.log('========================================');
  console.log('  WorkBuddy KeepAlive - 自动接力版');
  console.log('========================================\n');

  const taskId = process.env.TASK_ID || '2069611353750118400';
  const targetUrl = `${BASE_URL}/app/task/${taskId}`;
  console.log(`目标: ${targetUrl}`);

  const chromePath = findChrome();
  console.log(`Chrome: ${chromePath}`);
  console.log(`xvfb: ${process.env.DISPLAY || '无'}\n`);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.DISPLAY ? false : 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--window-size=1280,900'],
    defaultViewport: { width: 1280, height: 900 },
  });

  console.log('浏览器已启动\n');
  const page = await browser.newPage();

  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', ({ url }) => {
    if (!wsConnected) {
      wsConnected = true;
      console.log(`[WebSocket] 连接: ${url.substring(0, 80)}`);
    }
  });
  cdp.on('Network.webSocketClosed', () => { wsConnected = false; });

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');

  let loggedIn = await restoreSession(page, targetUrl);
  if (!loggedIn) {
    loggedIn = await waitForLogin(page, targetUrl, taskId);
  }

  if (!loggedIn) {
    await browser.close();
    process.exit(1);
  }

  await startKeepalive(page, targetUrl, taskId);
  await browser.close();
}

main().catch(err => {
  console.error(`\n[错误] ${err.message}`);
  process.exit(1);
});
