import { firefox } from 'playwright-core';

async function testFirefox() {
  console.log('Launching Playwright Firefox via playwright-core...');
  const browser = await firefox.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:3000/login');
  const title = await page.title();
  console.log('Page Title:', title);
  await browser.close();
  console.log('Firefox launch test successful!');
}

testFirefox().catch((err) => {
  console.error('Firefox test failed:', err);
  process.exit(1);
});
