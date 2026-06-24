/**
 * WorkBuddy 浏览器保活脚本（诊断版）
 * ==================================
 * 打开 AI 对话页面，保持 WebSocket 持续在线。
 * 每次启动时截图，保存页面内容，用于诊断登录状态。
 */

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'https://www.workbuddy.cn';

const CHROME_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

const HEARTBEAT_INTERVAL_SEC = 20;
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/workbuddy-screenshots';
const DEBUG = process.env.DEBUG === 'true';

function loadConfig() {
  let sessionData = null;
  if (process.env.SESSION_DATA) {
    try { sessionData = JSON.parse(process.env.SESSION_DATA); }
    catch (e) { throw new Error(`SESSION_DATA 解析失败: ${e.message}`); }
  }
  if (!sessionData) {
    const fp = path.resolve('session-data.json');
    if (fs.existsSync(fp)) sessionData = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  }
  if (!sessionData) throw new Error('未找到会话数据');
  const taskId = process.env.TASK_ID || sessionData?.taskId || '';
  return { cookies: sessionData.cookies || [], localStorage: sessionData.localStorage || {}, taskId };
}

function findChrome() {
  for (const p of CHROME_PATHS) { if (fs.existsSync(p)) return p; }
  try { const p = require('puppeteer-core').executablePath(); if (fs.existsSync(p)) return p; } catch {}
  return '/usr/bin/google-chrome';
}

async function diagnosePage(page, tag) {
  try {
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const ts = Date.now();

    // 截图
    await page.screenshot({ path: `${SCREENSHOT_DIR}/${tag}-${ts}.png`, fullPage: false });

    // 页面文本内容
    const text = await page.evaluate(() => document.body?.innerText?.substring(0, 2000) || '');
    console.log(`[诊断:${tag}] 页面文本:\n${text}\n`);

    // 页面标题
    const title = await page.title();
    console.log(`[诊断:${tag}] 标题: "${title}"`);

    // URL
    console.log(`[诊断:${tag}] URL: ${page.url()}`);

    // 检测特定元素
    const hasLoginForm = await page.evaluate(() => {
      return !!document.querySelector('input[type="text"], input[type="password"], button:contains("登录"), .qr-code, img[alt*="二维码"]');
    }).catch(() => false);

    const hasChatUI = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      return body.includes('AI') || body.includes('对话') || body.includes('消息') || body.includes('task');
    }).catch(() => false);

    console.log(`[诊断:${tag}] 检测到登录表单: ${hasLoginForm}, 检测到对话UI: ${hasChatUI}`);

    // cookies 状态
    const cookies = await page.cookies();
    const sessionCookie = cookies.find(c => c.name === 'session');
    console.log(`[诊断:${tag}] cookies: ${cookies.length} 个, session cookie: ${sessionCookie ? '存在' : '不存在'}`);

    return { title, text, hasLoginForm, hasChatUI, cookies: cookies.length };
  } catch (err) {
    console.error(`[诊断:${tag}] 失败: ${err.message}`);
    return null;
  }
}

const GLOBAL_START = Date.now();

async function main() {
  console.log('========================================');
  console.log('  WorkBuddy KeepAlive - 浏览器持续在线');
  console.log('========================================\n');

  const config = loadConfig();
  const targetUrl = config.taskId
    ? `${BASE_URL}/app/task/${config.taskId}`
    : `${BASE_URL}/app`;

  console.log(`目标: ${targetUrl}`);
  console.log(`cookies: ${config.cookies.length} 个`);

  const chromePath = findChrome();
  console.log(`Chrome: ${chromePath}`);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--mute-audio',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    ],
  });

  try {
    const page = await browser.newPage();

    let wsConnected = false;
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketCreated', ({ url }) => {
      if (!wsConnected) {
        wsConnected = true;
        console.log(`\n[WebSocket] 已连接: ${url.substring(0, 80)}`);
      }
    });
    cdp.on('Network.webSocketClosed', () => {
      wsConnected = false;
      console.log(`\n[WebSocket] 连接已关闭`);

      // WebSocket 断开可能是登录过期，记录诊断
      setTimeout(() => {
        diagnosePage(page, 'ws-closed');
      }, 2000);
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'
    );

    // 拦截请求，检查 API 返回
    const failedApiCalls = [];
    if (DEBUG) {
      page.on('response', async (resp) => {
        if (resp.status() === 401 || resp.status() === 403) {
          failedApiCalls.push(`${resp.url()} -> ${resp.status()}`);
        }
      });
    }

    // === 步骤1: 打开首页 ===
    console.log('\n[1/5] 打开首页...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await diagnosePage(page, 'step1-homepage');

    // === 步骤2: 注入 cookies ===
    console.log('\n[2/5] 注入 cookies...');
    if (config.cookies.length > 0) {
      const valid = config.cookies.filter(c => c.name && c.value).map(c => ({
        name: c.name, value: c.value,
        domain: c.domain || '.workbuddy.cn', path: c.path || '/',
        httpOnly: c.httpOnly ?? false, secure: c.secure ?? true,
        sameSite: c.sameSite || 'Lax',
      }));
      await page.setCookie(...valid);
      console.log(`  已注入 ${valid.length} 个 cookies`);
    }

    // === 步骤3: 打开目标页面 ===
    console.log('\n[3/5] 打开目标页面...');
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await diagnosePage(page, 'step3-after-cookies');

    // === 步骤4: 注入 localStorage ===
    if (Object.keys(config.localStorage).length > 0) {
      console.log('\n[4/5] 注入 localStorage...');
      await page.evaluate((items) => {
        for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
      }, config.localStorage);
      await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
      await diagnosePage(page, 'step4-after-localstorage');
    }

    // === 分析登录状态 ===
    console.log('\n========== 登录状态分析 ==========');
    const finalUrl = page.url();
    const finalTitle = await page.title();
    const finalText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');

    console.log(`URL: ${finalUrl}`);
    console.log(`标题: "${finalTitle}"`);

    if (finalUrl.includes('login') || finalTitle.includes('登录') || finalTitle.includes('Login')) {
      console.error('❌ 诊断结论: 页面在登录页面，登录失败！');
      console.error('可能原因: cookie 已过期，或 WorkBuddy 需要完整的浏览器指纹');
    } else if (finalText.includes('AI') || finalText.includes('对话') || finalUrl.includes('/task/')) {
      console.log('✅ 诊断结论: 看起来已登录成功！');
    } else {
      console.log('⚠️ 诊断结论: 不确定，检查截图确认');
    }

    if (failedApiCalls.length > 0) {
      console.log(`\nAPI 鉴权失败 (401/403):`);
      failedApiCalls.forEach(u => console.log(`  ${u}`));
    }
    console.log('================================\n');

    // 立即截图一张，保存在工作目录（会被 GitHub Actions 保留）
    await page.screenshot({ path: 'diagnosis.png', fullPage: false });
    console.log('[诊断] 已保存 diagnosis.png\n');

    // 如果页面在登录页，直接退出不继续保活
    if (finalUrl.includes('login') || finalTitle.includes('登录')) {
      throw new Error('登录失败！cookie 无效或已过期。请重新运行: npm run login');
    }

    // === 步骤5: 持续保活 ===
    console.log('[5/5] 开始持续保活...');
    console.log('每 20 秒心跳，浏览器永不关闭\n');

    let beatNum = 0;
    let lastDiagnosis = Date.now();

    while (true) {
      beatNum++;

      try {
        await page.evaluate(() => fetch(window.location.pathname, { method: 'HEAD' }).catch(() => {}));
        await page.keyboard.press('Shift');
        await page.evaluate(() => { window.scrollBy(0, 1); window.scrollBy(0, -1); });
        const body = await page.$('body');
        if (body) {
          const box = await body.boundingBox();
          if (box) await page.mouse.click(box.x + Math.random() * 50, box.y + Math.random() * 50);
        }
      } catch {}

      const min = Math.floor((Date.now() - GLOBAL_START) / 60000);
      const sec = Math.floor((Date.now() - GLOBAL_START) / 1000) % 60;
      process.stdout.write(`\r  心跳 #${beatNum} | 运行 ${min}分${sec}秒 | WebSocket ${wsConnected ? '✓' : '✗'}  `);

      // 每 10 分钟诊断一次
      if (Date.now() - lastDiagnosis > 10 * 60 * 1000) {
        lastDiagnosis = Date.now();
        console.log('\n');
        await diagnosePage(page, `periodic-${Math.floor(min / 10)}`);
      }

      await new Promise(r => setTimeout(r, HEARTBEAT_INTERVAL_SEC * 1000));
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(err => {
  console.error(`\n[致命] ${err.message}`);
  process.exit(1);
});
