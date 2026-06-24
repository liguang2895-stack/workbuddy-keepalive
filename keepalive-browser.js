/**
 * WorkBuddy 浏览器保活脚本（持续在线版）
 * ======================================
 * 在 GitHub Actions 上保持一个浏览器窗口 24/7 在线，
 * 维持 WebSocket 持续连接，防止服务器休眠。
 *
 * 核心思路：
 *   - 只打开一次浏览器，永不关闭
 *   - 每 20 秒发送心跳（fetch + 键盘 + 鼠标）
 *   - 保持 WebSocket 一直在线
 *   - GitHub Actions 公开仓库单次最长 72 小时
 *   - 69 小时时自动触发新的 workflow 接力
 */

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'https://www.workbuddy.cn';

// ============================================================
// 配置
// ============================================================
const CHROME_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const HEARTBEAT_INTERVAL_SEC = 20;  // 每 20 秒发一次心跳
const HEALTH_CHECK_INTERVAL_SEC = 60; // 每 60 秒检查页面是否还活着

// ============================================================
// 加载配置
// ============================================================
function loadConfig() {
  let sessionData = null;

  if (process.env.SESSION_DATA) {
    try {
      sessionData = JSON.parse(process.env.SESSION_DATA);
    } catch (err) {
      throw new Error(`SESSION_DATA 解析失败: ${err.message}`);
    }
  }

  if (!sessionData) {
    const filePath = path.resolve('session-data.json');
    if (fs.existsSync(filePath)) {
      sessionData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  }

  if (!sessionData) {
    throw new Error('未找到会话数据，请设置 SESSION_DATA 环境变量');
  }

  const taskId = process.env.TASK_ID || sessionData?.taskId || '';
  return {
    cookies: sessionData.cookies || [],
    localStorage: sessionData.localStorage || {},
    taskId,
  };
}

// ============================================================
// 寻找 Chrome
// ============================================================
function findChrome() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const p = require('puppeteer-core').executablePath();
    if (fs.existsSync(p)) return p;
  } catch {}
  return '/usr/bin/google-chrome';
}

// ============================================================
// 心跳：模拟真实用户操作
// ============================================================
async function sendHeartbeat(page, beatNum) {
  try {
    // 1. 发 HTTP 请求保持会话
    await page.evaluate(() =>
      fetch(window.location.pathname, { method: 'HEAD' }).catch(() => {})
    );

    // 2. 模拟键盘输入（轻触 Shift 键）
    await page.keyboard.press('Shift');

    // 3. 模拟鼠标滚动或点击
    await page.evaluate(() => {
      window.scrollBy(0, 1);
      window.scrollBy(0, -1);
    });

    const body = await page.$('body');
    if (body) {
      const box = await body.boundingBox();
      if (box) {
        await page.mouse.click(box.x + Math.random() * 50, box.y + Math.random() * 50);
      }
    }

    const elapsed = Math.floor((Date.now() - GLOBAL_START) / 1000);
    const elapsedMin = Math.floor(elapsed / 60);
    process.stdout.write(`\r  心跳 #${beatNum} | 已运行 ${elapsedMin} 分 ${elapsed % 60} 秒  `);

    return true;
  } catch (err) {
    return false;
  }
}

// ============================================================
// 检查页面健康状态
// ============================================================
async function checkPageHealth(page) {
  try {
    const url = page.url();
    if (url.includes('login') || url.includes('auth')) {
      console.error(`\n[健康检查] 页面跳转到登录页: ${url}`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// 全局变量
// ============================================================
let GLOBAL_START = Date.now();

// ============================================================
// 主函数
// ============================================================
async function main() {
  console.log('================================================');
  console.log('  WorkBuddy KeepAlive - 浏览器持续在线');
  console.log('  浏览器永不关闭，24/7 保持 WebSocket 连接');
  console.log('================================================\n');

  const config = loadConfig();
  const targetUrl = config.taskId
    ? `${BASE_URL}/app/task/${config.taskId}`
    : `${BASE_URL}/app`;

  console.log(`[配置] 目标: ${targetUrl}`);
  console.log(`[配置] cookies: ${config.cookies.length} 个`);
  console.log(`[配置] taskId: ${config.taskId || '(未设置)'}`);

  // 启动浏览器
  const chromePath = findChrome();
  console.log(`\n[启动] Chrome: ${chromePath}`);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-ipc-flooding-protection',
    ],
  });

  console.log('[启动] 浏览器已启动');

  try {
    const page = await browser.newPage();

    // 拦截不必要的资源
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // 监听 WebSocket
    let wsConnected = false;
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketCreated', ({ url }) => {
      if (!wsConnected) {
        wsConnected = true;
        console.log(`\n[WebSocket] 已连接: ${url.substring(0, 60)}`);
      }
    });
    cdp.on('Network.webSocketClosed', () => {
      wsConnected = false;
      console.log(`\n[WebSocket] 连接已关闭 (${new Date().toISOString()})`);
    });

    // 设置 User-Agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36'
    );

    // ===== 第一步：打开首页建立域名 =====
    console.log('[步骤1] 打开首页...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // ===== 第二步：注入 cookies =====
    if (config.cookies.length > 0) {
      console.log('[步骤2] 注入 cookies...');
      const validCookies = config.cookies
        .filter(c => c.name && c.value)
        .map(c => ({
          name: c.name, value: c.value,
          domain: c.domain || '.workbuddy.cn', path: c.path || '/',
          httpOnly: c.httpOnly ?? false, secure: c.secure ?? true,
          sameSite: c.sameSite || 'Lax',
        }));
      await page.setCookie(...validCookies);
      console.log(`  已注入 ${validCookies.length} 个 cookies`);
    }

    // ===== 第三步：打开目标页面 =====
    console.log('[步骤3] 打开目标页面...');
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // ===== 第四步：注入 localStorage =====
    if (Object.keys(config.localStorage).length > 0) {
      console.log('[步骤4] 注入 localStorage...');
      await page.evaluate((items) => {
        for (const [k, v] of Object.entries(items)) {
          localStorage.setItem(k, v);
        }
      }, config.localStorage);
      await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    }

    // ===== 检查登录状态 =====
    const currentUrl = page.url();
    console.log(`\n[状态] 当前 URL: ${currentUrl}`);

    if (currentUrl.includes('login') || currentUrl.includes('auth')) {
      throw new Error('会话已过期！请重新运行 login.js');
    }

    if (currentUrl.includes('/task/')) {
      const taskIdMatch = currentUrl.match(/\/task\/(\d+)/);
      if (taskIdMatch) {
        console.log(`[状态] 已进入会话页面 ✓ Task ID: ${taskIdMatch[1]}`);
      }
    }

    // 等待 WebSocket 建立
    console.log('[WebSocket] 等待连接建立...');
    await new Promise(r => setTimeout(r, 10000));
    console.log(`[WebSocket] ${wsConnected ? '已连接 ✓' : '未检测到 WebSocket'}`);

    // ===== 第五步：持续保活循环 =====
    console.log('\n========================================');
    console.log('  开始持续保活，永不关闭浏览器');
    console.log('  每 20 秒发送一次心跳');
    console.log('========================================\n');

    let beatNum = 0;
    let healthCheckCounter = 0;

    while (true) {
      // 心跳
      beatNum++;
      await sendHeartbeat(page, beatNum);

      // 健康检查（每 60/20 = 3 次心跳检查一次）
      healthCheckCounter++;
      if (healthCheckCounter >= (HEALTH_CHECK_INTERVAL_SEC / HEARTBEAT_INTERVAL_SEC)) {
        healthCheckCounter = 0;
        const healthy = await checkPageHealth(page);
        if (!healthy) {
          console.error('\n[健康检查] 页面异常，尝试重新加载...');
          try {
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            console.log('[健康检查] 页面已重新加载');
          } catch (err) {
            console.error(`[健康检查] 重新加载失败: ${err.message}`);
          }
        }

        // 检查 WebSocket 状态
        if (!wsConnected) {
          console.log(`[WebSocket] 已断开 (${new Date().toISOString()})`);
          // 也许重新加载页面可以恢复
          try {
            await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
            console.log('[WebSocket] 已重新加载页面，等待连接恢复...');
            await new Promise(r => setTimeout(r, 8000));
          } catch {}
        }

        // 打印运行时间
        const totalMin = Math.floor((Date.now() - GLOBAL_START) / 60000);
        console.log(`\n[状态] 运行 ${totalMin} 分钟 | 心跳 ${beatNum} 次 | WebSocket ${wsConnected ? '✓' : '✗'}`);
      }

      // 等待到下次心跳
      await new Promise(r => setTimeout(r, HEARTBEAT_INTERVAL_SEC * 1000));
    }
  } finally {
    console.log('\n[关闭] 浏览器已关闭');
    await browser.close().catch(() => {});
  }
}

main().catch(err => {
  console.error(`\n[致命错误] ${err.message}`);
  process.exit(1);
});
