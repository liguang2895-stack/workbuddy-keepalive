/**
 * WorkBuddy 登录诊断工具
 * ======================
 * 在 GitHub Actions 上运行，打开页面、截图、检查登录状态。
 * 运行完毕后退出，通过截图 Artifact 让你判断是否登录成功。
 *
 * 在 GitHub Actions 运行后，下载 diagnosis-screenshot.zip
 * 解压查看 diagnosis.png，检查页面显示的是登录页还是对话页。
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');

const BASE_URL = 'https://www.workbuddy.cn';
const CHROME_PATHS = [
  '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
];

function loadConfig() {
  let data = null;
  if (process.env.SESSION_DATA) {
    try { data = JSON.parse(process.env.SESSION_DATA); } catch {}
  }
  const fp = require('path').resolve('session-data.json');
  if (!data && fs.existsSync(fp)) { data = JSON.parse(fs.readFileSync(fp, 'utf-8')); }
  if (!data) throw new Error('未找到会话数据');
  return {
    cookies: data.cookies || [],
    localStorage: data.localStorage || {},
    taskId: process.env.TASK_ID || data.taskId || '',
  };
}

function findChrome() {
  for (const p of CHROME_PATHS) { if (fs.existsSync(p)) return p; }
  try { const p = require('puppeteer-core').executablePath(); if (fs.existsSync(p)) return p; } catch {}
  return '/usr/bin/google-chrome';
}

async function main() {
  console.log('========================================');
  console.log('  WorkBuddy 登录诊断');
  console.log('========================================\n');

  const config = loadConfig();
  const targetUrl = config.taskId
    ? `${BASE_URL}/app/task/${config.taskId}`
    : `${BASE_URL}/app`;

  console.log(`目标: ${targetUrl}`);
  console.log(`cookies: ${config.cookies.length} 个`);
  console.log(`localStorage: ${Object.keys(config.localStorage).length} 条`);

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();

  // 清空日志
  console.log('\n------ 诊断过程 ------\n');

  // 1. 看首页
  console.log('[1] 打开首页...');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log(`    标题: "${await page.title()}"`);
  console.log(`    URL: ${page.url()}`);

  // 2. 注入 cookies
  console.log('[2] 注入 cookies...');
  if (config.cookies.length > 0) {
    const valid = config.cookies.map(c => ({
      name: c.name, value: c.value,
      domain: c.domain || '.workbuddy.cn', path: c.path || '/',
      httpOnly: c.httpOnly ?? false, secure: c.secure ?? true,
      sameSite: c.sameSite || 'Lax',
    }));
    await page.setCookie(...valid);
    console.log(`    已注入 ${valid.length} 个`);
  }

  // 3. 目标页面（不拦截资源，看完整效果）
  console.log('[3] 打开目标页面...');
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'
  );
  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  console.log(`    标题: "${await page.title()}"`);
  console.log(`    URL: ${page.url()}`);

  // 4. localStorage 注入
  if (Object.keys(config.localStorage).length > 0) {
    console.log('[4] 注入 localStorage...');
    await page.evaluate((items) => {
      for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
    }, config.localStorage);
    console.log('    已注入，刷新页面...');
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    console.log(`    刷新后标题: "${await page.title()}"`);
    console.log(`    刷新后 URL: ${page.url()}`);
  }

  // 5. 页面文本分析
  const text = await page.evaluate(() => document.body?.innerText?.substring(0, 1000) || '');
  console.log(`\n[5] 页面文本 (前1000字):\n${text}\n`);

  // 6. 截图
  console.log('[6] 截图...');
  await page.screenshot({ path: 'diagnosis.png', fullPage: true });
  console.log('    已保存 diagnosis.png');

  // 7. 诊断结论
  const url = page.url();
  const title = await page.title();
  console.log('\n------ 诊断结论 ------');
  if (url.includes('login') || title.includes('登录') || title.includes('Login') || title.includes('微信')) {
    console.log('❌ 页面在登录页 - 登录失败');
    console.log('   原因可能是: cookie 已过期，或 WorkBuddy 校验了更多信息');
  } else if (url.includes('/task/')) {
    console.log('✅ 页面在任务页 - 登录成功！');
  } else if (text.includes('AI') || text.includes('对话') || text.includes('消息')) {
    console.log('✅ 页面有对话内容 - 登录成功！');
  } else {
    console.log('⚠️ 不确定状态，请查看截图 diagnosis.png');
  }
  console.log('------------------------\n');

  await browser.close();
}

main().catch(err => {
  console.error(`\n[错误] ${err.message}`);
  process.exit(1);
});
