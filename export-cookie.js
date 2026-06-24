/**
 * Cookie 导出工具
 * ===============
 * 将 session-data.json 中的 cookies 转为一行字符串，
 * 方便粘贴到 GitHub Secrets 中。
 *
 * 使用方法：
 *   1. 先运行 node login.js 完成微信登录
 *   2. 运行 node export-cookie.js
 *   3. 复制输出的内容
 *   4. 添加到 GitHub 仓库 Settings → Secrets → COOKIE_HEADER
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_FILE = path.resolve('session-data.json');

if (!fs.existsSync(SESSION_FILE)) {
  console.error('错误: 找不到 session-data.json');
  console.error('请先运行 node login.js 完成微信登录');
  process.exit(1);
}

const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
const data = JSON.parse(raw);

if (!data.cookies || data.cookies.length === 0) {
  console.error('错误: session-data.json 中没有 cookies');
  process.exit(1);
}

// 转为 HTTP Cookie 格式
const cookieHeader = data.cookies
  .filter(c => c.name && c.value)
  .map(c => `${encodeURIComponent(c.name)}=${encodeURIComponent(c.value)}`)
  .join('; ');

// 提取任务 ID 提示
const taskId = data.taskId || '(未设置)';

console.log('');
console.log('========================================');
console.log('  Cookie 导出结果');
console.log('========================================');
console.log('');
console.log('Task ID: ' + taskId);
console.log('Cookie 数量: ' + data.cookies.length);
console.log('Cookie 字符串长度: ' + cookieHeader.length + ' 字符');
console.log('');
console.log('--- 复制以下内容到 GitHub Secret (COOKIE_HEADER) ---');
console.log('');
console.log(cookieHeader);
console.log('');
console.log('--- 复制结束 ---');
console.log('');
console.log('同时请在 GitHub Secret 中添加:');
console.log('  TASK_ID = ' + taskId);
console.log('');

// 打印 hash 用于验证完整性
const hash = crypto.createHash('sha256').update(cookieHeader).digest('hex').substring(0, 16);
console.log('SHA256 (前16位): ' + hash);
