/**
 * WorkBuddy HTTP 保活脚本（轻量版，无需浏览器）
 * =============================================
 * 直接发送 HTTP 请求保持会话活跃，无需 Puppeteer / Chromium。
 * 适合在 GitHub Actions 等免费 CI 平台定时运行。
 *
 * Cookie 来源（优先级）：
 *   1. 环境变量 COOKIE_HEADER（用于 GitHub Secrets）
 *   2. session-data.json 文件（本地测试用）
 *
 * 使用方法：
 *   node keepalive-http.js
 */

const BASE_URL = 'https://www.workbuddy.cn';
const fs = require('fs');
const path = require('path');

// ============================================================
// 获取 Cookie 请求头
// ============================================================
function getCookieHeader() {
  // 优先级1：环境变量
  if (process.env.COOKIE_HEADER) {
    console.log('[Cookies] 使用环境变量 COOKIE_HEADER');
    return process.env.COOKIE_HEADER;
  }

  // 优先级2：session-data.json
  const sessionPath = path.resolve('session-data.json');
  if (fs.existsSync(sessionPath)) {
    console.log(`[Cookies] 从 ${sessionPath} 读取`);
    const raw = fs.readFileSync(sessionPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data.cookies || data.cookies.length === 0) {
      throw new Error('session-data.json 中没有 cookies');
    }
    // 转为 HTTP Cookie 头
    return data.cookies
      .filter(c => c.name && c.value)
      .map(c => `${encodeURIComponent(c.name)}=${encodeURIComponent(c.value)}`)
      .join('; ');
  }

  throw new Error(
    '未找到 cookies！\n' +
    '请先运行 node login.js 完成微信登录，然后：\n' +
    '  方式A: node export-cookie.js（保存为 GH Secret）\n' +
    '  方式B: 直接运行（使用 session-data.json）'
  );
}

// ============================================================
// 获取 taskId
// ============================================================
function getTaskId() {
  // 优先级1：环境变量
  if (process.env.TASK_ID) {
    return process.env.TASK_ID;
  }
  // 优先级2：session-data.json
  const sessionPath = path.resolve('session-data.json');
  if (fs.existsSync(sessionPath)) {
    try {
      return JSON.parse(fs.readFileSync(sessionPath, 'utf-8')).taskId || '';
    } catch {}
  }
  return '';
}

// ============================================================
// 发送保活请求
// ============================================================
async function sendKeepAlive(cookieHeader, taskId) {
  const reqPath = taskId ? `/app/task/${taskId}` : '/app';
  const url = `${BASE_URL}${reqPath}`;

  console.log(`[KeepAlive] ${new Date().toISOString()}`);
  console.log(`[KeepAlive] ${url}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                     'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                     'Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': `${BASE_URL}/app`,
      'Cookie': cookieHeader,
      'Cache-Control': 'no-cache',
    },
    redirect: 'manual', // 不自动跟随重定向
  });

  console.log(`[KeepAlive] 状态: ${response.status}`);

  // 检测会话过期
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') || '';
    if (location.includes('login') || location.includes('auth')) {
      throw new Error(`会话已过期，请重新登录 (重定向到 ${location})`);
    }
  }

  if (response.ok) {
    console.log('[KeepAlive] OK');
    return true;
  }

  console.warn(`[KeepAlive] 非预期响应: ${response.status}`);
  return true;
}

// ============================================================
// 主函数
// ============================================================
async function main() {
  console.log('==============================');
  console.log(' WorkBuddy HTTP KeepAlive');
  console.log('==============================');

  const cookieHeader = getCookieHeader();
  // 只显示前50个字符用于调试
  console.log(`[Cookies] 长度: ${cookieHeader.length} 字符`);

  const taskId = getTaskId();
  console.log(`[Task] ID: ${taskId || '(未设置)'}`);

  try {
    await sendKeepAlive(cookieHeader, taskId);
    console.log('[Result] OK');
  } catch (err) {
    console.error(`[Result] 失败: ${err.message}`);
    process.exit(1);
  }
}

main();
