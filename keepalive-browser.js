/**
 * WorkBuddy 浏览器保活脚本（自循环版）
 * =====================================
 * 在 GitHub Actions 上长时间运行，每 10 分钟启动一次 Chrome 浏览器，
 * 打开 AI 对话页面保持 WebSocket 活跃，防止服务器休眠。
 *
 * 模式：
 *   - 不需要 GitHub schedule 定时器
 *   - 脚本内部自循环：打开页面 → 保持 2 分钟 → 关闭 → 等 8 分钟 → 重复
 *   - 单个 GitHub Actions 运行最长 72 小时（公开仓库免费）
 *   - 如果挂了，手动点一次 Run workflow 即可再跑 72 小时
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

const CYCLE_INTERVAL_SEC = 10 * 60;  // 循环间隔 10 分钟
const ACTIVE_SECONDS = 150;          // 每次保持页面活跃 2.5 分钟
const HEARTBEAT_INTERVAL = 15;       // 每 15 秒发一次心跳

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
  // Ubuntu GitHub Actions 默认位置
  return '/usr/bin/google-chrome';
}

// ============================================================
// 心跳循环（连接页面并保持活跃）
// ============================================================
async function runKeepAliveCycle(cycleNum, config) {
  const targetUrl = config.taskId
    ? `${BASE_URL}/app/task/${config.taskId}`
    : `${BASE_URL}/app`;

  console.log(`\n========== 第 ${cycleNum} 次保活 ==========`);
  console.log(`[目标] ${targetUrl}`);

  const chromePath = findChrome();
  console.log(`[Chrome] ${chromePath}`);

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
    ],
  });

  try {
    const page = await browser.newPage();

    // 拦截资源
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
      wsConnected = true;
      console.log(`[WebSocket] 已连接: ${url.substring(0, 60)}`);
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36'
    );

    // 第一步：打开首页
    console.log('[步骤1] 打开首页...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 第二步：注入 cookies
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
      console.log(`  已注入 ${validCookies.length} 个`);
    }

    // 第三步：打开目标页面
    console.log('[步骤3] 打开任务页...');
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // 第四步：注入 localStorage
    if (Object.keys(config.localStorage).length > 0) {
      console.log('[步骤4] 注入 localStorage...');
      await page.evaluate((items) => {
        for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
      }, config.localStorage);
      await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    }

    // 检查状态
    const currentUrl = page.url();
    console.log(`[状态] URL: ${currentUrl}`);
    if (currentUrl.includes('login')) {
      throw new Error('会话已过期！请重新运行 login.js');
    }

    // 等待 WebSocket
    if (!wsConnected) {
      console.log('[WebSocket] 等待连接...');
      await new Promise(r => setTimeout(r, 8000));
    }
    console.log(`[WebSocket] ${wsConnected ? '已连接 ✓' : '未检测到'}`);

    // 第五步：保持活跃
    console.log(`[步骤5] 保持活跃 ${ACTIVE_SECONDS} 秒...`);
    const startTime = Date.now();
    let beats = 0;

    while (Date.now() - startTime < ACTIVE_SECONDS * 1000) {
      beats++;
      try {
        await page.evaluate(() =>
          fetch(window.location.pathname, { method: 'HEAD' }).catch(() => {})
        );
        await page.keyboard.press('Shift');
        const body = await page.$('body');
        if (body) {
          const box = await body.boundingBox();
          if (box) await page.mouse.click(box.x + 10, box.y + 10);
        }
      } catch {}

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      process.stdout.write(`\r  心跳 #${beats} | +${elapsed}s  `);

      // 动态等待：先快后慢
      const waitTime = beats <= 3 ? 5000 : HEARTBEAT_INTERVAL * 1000;
      await new Promise(r => setTimeout(r, waitTime));
    }

    console.log(`\n[完成] 保活历时 ${Math.floor((Date.now() - startTime) / 1000)} 秒`);
    return true;
  } finally {
    await browser.close();
    console.log('[浏览器] 已关闭');
  }
}

// ============================================================
// 主循环
// ============================================================
async function main() {
  console.log('================================================');
  console.log('  WorkBuddy KeepAlive - 浏览器自循环保活');
  console.log('  公开仓库: 单次运行最长 72 小时');
  console.log('  循环: 每 10 分钟连接一次，活跃 2.5 分钟');
  console.log('================================================\n');

  const config = loadConfig();
  console.log(`[配置] cookies: ${config.cookies.length} 个`);
  console.log(`[配置] localStorage: ${Object.keys(config.localStorage).length} 条`);
  console.log(`[配置] taskId: ${config.taskId || '(未设置)'}`);
  console.log('');

  let cycleNum = 0;
  const startTime = Date.now();

  while (true) {
    cycleNum++;
    const totalElapsed = Math.floor((Date.now() - startTime) / 60000);
    console.log(`\n[总运行] ${totalElapsed} 分钟 | 已执行 ${cycleNum - 1} 次`);

    try {
      await runKeepAliveCycle(cycleNum, config);
    } catch (err) {
      console.error(`\n[错误] ${err.message}`);
      // 错误后等待 30 秒重试
      console.log('[等待] 30 秒后重试...');
      await new Promise(r => setTimeout(r, 30000));
    }

    // 等待到下一个周期
    const waitSec = CYCLE_INTERVAL_SEC - ACTIVE_SECONDS;
    console.log(`\n[等待] ${waitSec} 秒后下一次保活...`);
    await new Promise(r => setTimeout(r, waitSec * 1000));
  }
}

main().catch(err => {
  console.error(`\n[致命错误] ${err.message}`);
  process.exit(1);
});
