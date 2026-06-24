/**
 * 会话导出工具
 * =============
 * 将 session-data.json 转为一行 JSON 字符串，用于 GitHub Secrets。
 * 
 * 使用方法：
 *   npm run session-export
 * 
 * 输出内容（复制整行作为 GitHub Secret SESSION_DATA 的值）：
 *   {"createdAt":"2026-...","cookies":[...],"localStorage":{...},"taskId":"..."}
 */

const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.resolve('session-data.json');

if (!fs.existsSync(SESSION_FILE)) {
  console.error('错误: 找不到 session-data.json');
  console.error('请先运行 npm run login 完成微信扫码登录');
  process.exit(1);
}

const raw = fs.readFileSync(SESSION_FILE, 'utf-8');

try {
  JSON.parse(raw); // 验证是合法 JSON
} catch {
  console.error('错误: session-data.json 格式不正确');
  process.exit(1);
}

// 转为一行
const oneLine = JSON.stringify(JSON.parse(raw));

console.log('');
console.log('========================================');
console.log('  会话导出结果');
console.log('========================================');
console.log('');
console.log('字符串长度: ' + oneLine.length + ' 字符');
console.log('');
console.log('--- 复制以下全部内容到 GitHub Secret (SESSION_DATA) ---');
console.log('');
console.log(oneLine);
console.log('');
console.log('--- 复制结束 ---');
console.log('');
console.log('同时确保已添加另一个 Secret:');
console.log('  TASK_ID = ' + (JSON.parse(raw).taskId || '(未设置)'));
console.log('');
