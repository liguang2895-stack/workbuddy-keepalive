/**
 * WorkBuddy KeepAlive - 云端保活服务
 * ===================================
 * 在云端（Railway/Fly.io/VPS）运行，保持 WorkBuddy AI 会话服务器不因空闲而休眠。
 *
 * 工作原理：
 * 1. 读取 session-data.json（由 login.js 生成，包含 cookies、localStorage 和 taskId）
 * 2. 启动无头 Chromium 浏览器
 * 3. 打开具体的 task 会话页面 https://www.workbuddy.cn/app/task/{taskId}
 * 4. 每隔 5 分钟发送心跳（HTTP 请求 + 模拟操作）
 * 5. 监控页面健康状态，崩溃自动重启
 */

const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ============================================================
// 环境变量配置
// ============================================================
const BASE_URL = 'https://www.workbuddy.cn';
const TASK_ID = process.env.TASK_ID || '';                    // 优先从环境变量读取
const INTERVAL_MS = (parseInt(process.env.INTERVAL_MINUTES) || 5) * 60 * 1000;
const PORT = process.env.PORT || 3000;
const SESSION_FILE = path.join(__dirname, 'session-data.json');

// ============================================================
// 健康检查 HTTP 服务器
// ============================================================
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WorkBuddy KeepAlive is running.\n');
});
server.listen(PORT, () => {
  console.log(`[Server] 健康检查端口已启动: ${PORT}`);
});

// ============================================================
// 全局状态
// ============================================================
let browser = null;
let page = null;
let keepAliveTimer = null;
let restarting = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// 构建目标 URL
// ============================================================
function buildTargetUrl(taskId) {
  if (taskId) {
    return `${BASE_URL}/app/task/${taskId}`;
  }
  return `${BASE_URL}/app`;
}

// ============================================================
// 启动无头浏览器
// ============================================================
async function launchBrowser() {
  console.log('[Browser] 启动无头浏览器...');

  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-first-run',
      '--mute-audio',
    ],
  });

  console.log('[Browser] 浏览器已启动');
  return browser;
}

// ============================================================
// 读取并恢复登录会话
// ============================================================
function loadSession() {
  if (!fs.existsSync(SESSION_FILE)) {
    console.warn(`[Session] 未找到会话文件: ${SESSION_FILE}`);
    return null;
  }

  try {
    const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
    const data = JSON.parse(raw);
    console.log(`[Session] 已加载会话数据`);
    console.log(`[Session] cookies: ${data.cookies?.length || 0} 个`);
    console.log(`[Session] localStorage: ${Object.keys(data.localStorage || {}).length} 项`);
    if (data.taskId) {
      console.log(`[Session] 保存的 taskId: ${data.taskId}`);
    }
    return data;
  } catch (err) {
    console.error('[Session] 读取会话文件失败:', err.message);
    return null;
  }
}

// ============================================================
// 获取最终要使用的 taskId（环境变量 > session 文件 > 空）
// ============================================================
function resolveTaskId(session) {
  if (TASK_ID) {
    console.log(`[Task] 使用环境变量 TASK_ID: ${TASK_ID}`);
    return TASK_ID;
  }
  if (session?.taskId) {
    console.log(`[Task] 使用会话文件中保存的 taskId: ${session.taskId}`);
    return session.taskId;
  }
  console.warn('[Task] 未指定 TASK_ID，将打开通用页面');
  return '';
}

// ============================================================
// 打开页面并注入登录态
// ============================================================
async function openPage(session, taskId) {
  if (!browser) await launchBrowser();

  const targetUrl = buildTargetUrl(taskId);
  page = await browser.newPage();

  // 拦截不必要的资源（节省带宽）
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // 打印页面控制台日志（帮助调试登录问题）
  page.on('console', (msg) => {
    if (msg.type() === 'error') return; // 忽略 JS 错误噪音
    console.log(`[Page:console] ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.error('[Page:pageerror]', err.message));
  page.on('close', () => console.warn('[Page] 页面被关闭'));

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36'
  );

  // ===== 第一步：先打开首页（同域名才能设置 cookies） =====
  console.log('[Page] 首次加载首页（建立域名上下文）...');
  await page.goto(BASE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  // ===== 第二步：注入 cookies =====
  if (session?.cookies?.length > 0) {
    console.log(`[Page] 注入 ${session.cookies.length} 个 cookies...`);
    const validCookies = session.cookies
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
    console.log('[Page] Cookies 注入完成');
  }

  // ===== 第三步：导航到目标 task URL =====
  console.log(`[Page] 导航到目标页面: ${targetUrl}`);
  await page.goto(targetUrl, {
    waitUntil: 'networkidle2',
    timeout: 60000,
  });

  // ===== 第四步：注入 localStorage =====
  if (session?.localStorage && Object.keys(session.localStorage).length > 0) {
    console.log(`[Page] 注入 ${Object.keys(session.localStorage).length} 条 localStorage...`);
    await page.evaluate((items) => {
      for (const [key, value] of Object.entries(items)) {
        localStorage.setItem(key, value);
      }
    }, session.localStorage);
    console.log('[Page] localStorage 注入完成');

    // 刷新页面使 localStorage 生效
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
  }

  // ===== 检查状态 =====
  const pageTitle = await page.title();
  const pageUrl = page.url();
  console.log(`[Page] 页面标题: "${pageTitle}"`);
  console.log(`[Page] 当前 URL: ${pageUrl}`);

  if (pageUrl.includes('login') || pageUrl.includes('auth') || pageTitle.includes('登录')) {
    console.warn('[Page] 会话已过期！请重新运行 node login.js');
  } else if (pageUrl.includes('/task/')) {
    console.log(`[Page] 已进入会话页面 ✓  taskId=${pageUrl.split('/task/')[1]}`);
  } else {
    console.log('[Page] 页面加载完成');
  }

  return page;
}

// ============================================================
// 发送心跳（保持服务器活跃）
// ============================================================
async function sendKeepAlive() {
  try {
    if (!page || page.isClosed()) {
      console.warn('[KeepAlive] 页面已关闭，跳过');
      return false;
    }

    console.log(`[KeepAlive] ${new Date().toISOString()}`);

    // 1. 在页面内发 fetch 请求保持 HTTP 会话
    await page.evaluate(() => {
      const currentPath = window.location.pathname;
      return fetch(currentPath, { method: 'HEAD' }).catch(() => {});
    });

    // 2. 模拟键盘操作保持 WebSocket
    await page.keyboard.press('Shift');

    // 3. 模拟鼠标点击页面
    const body = await page.$('body');
    if (body) {
      const box = await body.boundingBox();
      if (box) await page.mouse.click(box.x + 10, box.y + 10);
    }

    console.log('[KeepAlive] OK');
    return true;
  } catch (err) {
    console.error('[KeepAlive] 失败:', err.message);
    return false;
  }
}

// ============================================================
// 心跳循环 & 监控
// ============================================================
async function startKeepAlive() {
  console.log(`[KeepAlive] 心跳间隔: ${INTERVAL_MS / 1000}s`);
  await sendKeepAlive();

  keepAliveTimer = setInterval(async () => {
    if (restarting) return;
    const ok = await sendKeepAlive();
    if (!ok) {
      console.warn('[KeepAlive] 失败，准备重启会话...');
      clearInterval(keepAliveTimer);
      await restartSession();
    }
  }, INTERVAL_MS);
}

async function monitorPage() {
  setInterval(async () => {
    if (restarting) return;
    if (!page || page.isClosed() || !browser?.isConnected()) {
      console.warn('[Monitor] 检测到异常，重启会话');
      clearInterval(keepAliveTimer);
      await restartSession();
    }
  }, 30 * 1000);
}

async function restartSession() {
  if (restarting) return;
  restarting = true;
  console.log('[Restart] 正在重启...');

  try {
    if (page && !page.isClosed()) await page.close().catch(() => {});
    page = null;
    if (browser?.isConnected()) await browser.close().catch(() => {});
    browser = null;

    await sleep(5000);

    const session = loadSession();
    const taskId = resolveTaskId(session);
    await launchBrowser();
    await openPage(session, taskId);
    await startKeepAlive();

    console.log('[Restart] 重启完成');
  } catch (err) {
    console.error('[Restart] 重启失败:', err.message);
    await sleep(60000);
  } finally {
    restarting = false;
  }
}

// ============================================================
// 启动入口
// ============================================================
(async () => {
  const session = loadSession();
  const taskId = resolveTaskId(session);
  const targetUrl = buildTargetUrl(taskId);

  console.log('========================================');
  console.log('  WorkBuddy KeepAlive - 云端保活服务');
  console.log('  目标: ' + targetUrl);
  console.log('  心跳间隔: ' + (INTERVAL_MS / 1000) + ' 秒');
  console.log('  会话文件: ' + (fs.existsSync(SESSION_FILE) ? '已找到' : '未找到'));
  console.log('========================================');

  if (!taskId) {
    console.warn('');
    console.warn('⚠ 警告: 未设置 TASK_ID！');
    console.warn('  请在环境变量中设置 TASK_ID，例如:');
    console.warn('    TASK_ID=2069611353750118400');
    console.warn('  或在本地运行 login.js 时输入 task ID');
    console.warn('');
  }

  // 注册优雅退出
  process.on('SIGINT', async () => {
    console.log('\n[Shutdown] SIGINT');
    clearInterval(keepAliveTimer);
    if (page && !page.isClosed()) await page.close().catch(() => {});
    if (browser?.isConnected()) await browser.close().catch(() => {});
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    console.log('\n[Shutdown] SIGTERM');
    clearInterval(keepAliveTimer);
    if (page && !page.isClosed()) await page.close().catch(() => {});
    if (browser?.isConnected()) await browser.close().catch(() => {});
    process.exit(0);
  });

  try {
    await launchBrowser();
    await openPage(session, taskId);
    await startKeepAlive();
    await monitorPage();
  } catch (err) {
    console.error('[Fatal] 启动失败:', err);
    process.exit(1);
  }
})();
