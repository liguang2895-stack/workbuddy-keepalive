/**
 * WorkBuddy 本地登录工具
 * =======================
 * 在本地电脑上运行，完成微信扫码登录+绑定需要保活的会话。
 *
 * 使用步骤:
 *   1. node login.js
 *   2. 在弹出的浏览器中用微信扫码登录 WorkBuddy
 *   3. 在浏览器中打开你想保活的 AI 对话（会有一个类似 /app/task/xxx 的地址）
 *   4. 复制地址栏中的数字 task ID，粘贴到终端
 *   5. 关闭浏览器，将 session-data.json 提交到 git 并部署云端
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const BASE_URL = 'https://www.workbuddy.cn';
const SESSION_FILE = path.join(__dirname, 'session-data.json');

// 创建命令行交互界面
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function askQuestion(query) {
  return new Promise((resolve) => {
    rl.question(query, resolve);
  });
}

(async () => {
  console.log('========================================');
  console.log('  WorkBuddy 登录 + 会话绑定工具');
  console.log('========================================\n');
  console.log('流程:');
  console.log('  1. 浏览器窗口会自动打开');
  console.log('  2. 用微信扫码登录 WorkBuddy');
  console.log('  3. 在浏览器中导航到你想要保活的 AI 对话页面');
  console.log('  4. 把地址栏中的数字 ID 粘贴回此终端');
  console.log('  5. 会话数据会自动保存，关闭浏览器即可\n');

  // 启动有界面的浏览器
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36'
  );

  let loginDetected = false;

  // 监听导航，检测登录成功
  page.on('framenavigated', async (frame) => {
    if (frame === page.mainFrame() && !loginDetected) {
      const url = frame.url();
      if (!url.includes('login') && !url.includes('auth') && url.includes('workbuddy')) {
        loginDetected = true;
        console.log('\n✓ 检测到登录成功！');

        // 保存 cookies 和 localStorage
        try {
          await sleep(2000); // 等页面稳定

          const cookies = await page.cookies();
          console.log(`  已提取 ${cookies.length} 个 cookies`);

          const localStorageData = await page.evaluate(() => {
            const items = {};
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              items[key] = localStorage.getItem(key);
            }
            return items;
          });
          console.log(`  已提取 ${Object.keys(localStorageData).length} 条 localStorage`);

          // 临时保存（不含 taskId）
          const partialData = {
            createdAt: new Date().toISOString(),
            cookies,
            localStorage: localStorageData,
            taskId: '',
          };

          // 询问用户 task ID
          console.log('\n----------------------------------------');
          console.log('现在请在你的浏览器中：');
          console.log('1. 找到你想保活的 AI 对话');
          console.log('2. 从地址栏复制 task ID（那串纯数字）');
          console.log('   例如: https://www.workbuddy.cn/app/task/2069611353750118400');
          console.log('   其中  2069611353750118400  就是 task ID');
          console.log('----------------------------------------\n');

          const taskId = (await askQuestion('请输入 task ID: ')).trim();
          partialData.taskId = taskId;

          // 保存完整会话数据
          fs.writeFileSync(SESSION_FILE, JSON.stringify(partialData, null, 2), 'utf-8');

          const fileSize = (fs.statSync(SESSION_FILE).size / 1024).toFixed(1);
          console.log(`\n✓ 会话数据已保存到: ${SESSION_FILE}`);
          console.log(`  文件大小: ${fileSize} KB`);
          console.log(`  绑定的 taskId: ${taskId || '(未设置)'}`);
          console.log('');
          console.log('接下来:');
          console.log('  1. 关闭浏览器窗口');
          console.log('  2. git add session-data.json');
          console.log('  3. git commit -m "添加登录会话 + taskId"');
          console.log('  4. git push');
          console.log('  5. 部署到 Railway/Fly.io\n');
        } catch (err) {
          console.error('  保存会话数据失败:', err.message);
        }
      }
    }
  });

  // 打开目标页面
  console.log(`打开 ${BASE_URL}/app ...`);
  await page.goto(`${BASE_URL}/app`, {
    waitUntil: 'networkidle2',
    timeout: 120000,
  });

  console.log('\n请在弹出的浏览器窗口中用微信扫描二维码登录...');
  console.log('登录后，在浏览器中打开你要保活的 AI 对话页面\n');

  // 等待浏览器被关闭
  await new Promise((resolve) => {
    browser.on('disconnected', resolve);
  });

  if (!loginDetected) {
    console.log('\n⚠ 未检测到登录完成。会话数据未保存。');
    console.log('请重新运行 node login.js 并完成微信扫码登录。');
  }

  rl.close();
})();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
