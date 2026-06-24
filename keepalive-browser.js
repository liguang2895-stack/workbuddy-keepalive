/**
 * WorkBuddy 浏览器保活脚本（GitHub Actions 版）
 * ============================================
 * 使用 Puppeteer 打开真实的 Chromium 浏览器，保持 WebSocket 连接，
 * 防止服务器因空闲而休眠。
 *
 * 运行周期：
 *   - 每 10 分钟由 GitHub Actions 触发一次
 *   - 打开页面，等待 WebSocket 连接建立
 *   - 保持活跃约 2 分钟，模拟人工操作
 *   - 关闭浏览器退出
 *   - 服务器 15 分钟无连接才会休眠 → 10 分钟间隔绰绰有余
 *
 * 环境变量（通过 GitHub Secrets 传入）：
 *   SESSION_DATA  = session-data.json 的完整内容（JSON字符串）
 *   TASK_ID       = 任务 ID（纯数字）
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

const ACTIVE_SECONDS = 120;  // 保持页面活跃 2 分钟
const CHECK_INTERVAL = 15;    // 每 15 秒检查并发送心跳

// ============================================================
// 读取配置
// ============================================================
function loadConfig() {
  let sessionData = null;

  // 优先从环境变量读取（GitHub Actions）
  if (process.env.SESSION_DATA) {
    try {
      sessionData = JSON.parse(process.env.SESSION_DATA);
      console.log('[Config] 从环境变量 SESSION_DATA 加载');
    } catch (err) {
      console.error('[Config] SESSION_DATA 解析失败:', err.message);
    }
  }

  // 回退：从本地文件读取（本地测试用）
  if (!sessionData) {
    const filePath = path.resolve('session-data.json');
    if (fs.existsSync(filePath)) {
      sessionData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      console.log(`[Config] 从 ${filePath} 加载`);
    }
  }

  const taskId = process.env.TASK_ID || sessionData?.taskId || '';
  const cookies = sessionData?.cookies || [];
  const localStorage_ = sessionData?.localStorage || {};

  return { cookies, localStorage: localStorage_, taskId };
}

// ============================================================
// 检测 Chrome 路径
// ============================================================
function findChrome() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) {
      console.log(`[Chrome] 找到: ${p}`);
      return p;
    }
  }

  // 尝试从 Puppeteer 自动检测
  try {
    const p = require('puppeteer-core').executablePath();
    if (fs.existsSync(p)) {
      console.log(`[Chrome] Puppeteer 检测到: ${p}`);
      return p;
    }
  } catch {}

  throw new Error('未找到 Chrome 浏览器');
}

// ============================================================
// 主流程
// ============================================================
async function run() {
  console.log('==============================');
  console.log(' WorkBuddy Browser KeepAlive');
  console.log('==============================\n');

  const { cookies, localStorage, taskId } = loadConfig();
  const targetUrl = taskId ? `${BASE_URL}/app/task/${taskId}` : `${BASE_URL}/app`;

  console.log(`[Target] ${targetUrl}`);
  console.log(`[Cookies] ${cookies.length} 个`);
  console.log(`[localStorage] ${Object.keys(localStorage).length} 条`);
  console.log(`[Active] ${ACTIVE_SECONDS} 秒\n`);

  // 启动 Chrome
  const chromePath = findChrome();
  console.log('[Browser] 启动...');

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
    ],
  });

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

    // 监听 WebSocket 连接
    let wsConnected = false;
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('ws') || text.includes('WebSocket') || text.includes('socket')) {
        console.log(`[Page] ${text.substring(0, 100)}`);
      }
    });

    // CDP 监听 WebSocket
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketCreated', ({ url }) => {
      wsConnected = true;
      console.log(`[WebSocket] 已连接: ${url.substring(0, 80)}`);
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36'
    );

    // ===== 第一步：先打开首页建立域名 =====
    console.log('\n[Step 1] 打开首页...');
    await page.goto(BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // ===== 第二步：注入 cookies =====
    if (cookies.length > 0) {
      console.log('[Step 2] 注入 cookies...');
      const validCookies = cookies
        .filter(c => c.name && c.value)
        .map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain || '.workbuddy.cn',
          path: c.path || '/',
          httpOnly: c.httpOnly ?? false,
          secure: c.secure ?? true,
          sameSite: c.sameSite || 'Lax',
        }));
      await page.setCookie(...validCookies);
      console.log(`  已注入 ${validCookies.length} 个 cookies`);
    }

    // ===== 第三步：导航到目标页面 =====
    console.log(`[Step 3] 打开任务页面...`);
    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    // ===== 第四步：注入 localStorage =====
    if (Object.keys(localStorage).length > 0) {
      console.log('[Step 4] 注入 localStorage...');
      await page.evaluate((items) => {
        for (const [key, value] of Object.entries(items)) {
          localStorage.setItem(key, value);
        }
      }, localStorage);
      await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
      console.log('  已注入并刷新');
    }

    // ===== 检查状态 =====
    const pageUrl = page.url();
    console.log(`\n[Status] URL: ${pageUrl}`);

    if (pageUrl.includes('login') || pageUrl.includes('auth')) {
      throw new Error('会话已过期！请重新运行 login.js');
    }

    if (wsConnected) {
      console.log('[Status] WebSocket 已连接 ✓');
    } else {
      console.log('[Status] WebSocket 未检测到（等待连接中）...');
      // 等待几秒让 WebSocket 建立
      await new Promise(r => setTimeout(r, 5000));
    }

    // ===== 第五步：保持活跃 2 分钟 =====
    console.log(`\n[Step 5] 保持活跃 ${ACTIVE_SECONDS} 秒...`);

    const startTime = Date.now();
    let loopCount = 0;

    while (Date.now() - startTime < ACTIVE_SECONDS * 1000) {
      loopCount++;

      // 发请求保持 HTTP 会话
      await page.evaluate(() =>
        fetch(window.location.pathname, { method: 'HEAD' }).catch(() => {})
      );

      // 模拟键盘操作
      await page.keyboard.press('Shift');

      // 模拟鼠标点击
      try {
        const body = await page.$('body');
        if (body) {
          const box = await body.boundingBox();
          if (box) await page.mouse.click(box.x + 10, box.y + 10);
        }
      } catch {}

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`  [Heartbeat #${loopCount}] +${elapsed}s`);

      // 等待下次心跳
      await new Promise(r => setTimeout(r, CHECK_INTERVAL * 1000));
    }

    console.log(`\n[Complete] 保活完成，共 ${loopCount} 次心跳`);

  } finally {
    await browser.close();
    console.log('[Browser] 已关闭');
  }
}

run().catch(err => {
  console.error(`\n[Error] ${err.message}`);
  process.exit(1);
});
