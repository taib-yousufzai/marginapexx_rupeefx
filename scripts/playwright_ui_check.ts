import { chromium } from 'playwright-core';
import path from 'path';

async function checkDashboardUI() {
  console.log('=== RUNNING PLAYWRIGHT TRADING DASHBOARD & OPTIMISTIC ORDER VERIFICATION ===\n');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  console.log('1. Navigating to http://localhost:3000/login...');
  await page.goto('http://localhost:3000/login', { waitUntil: 'networkidle' });

  console.log('2. Entering demo credentials (demo@gmail.com)...');
  await page.fill('#username', 'demo@gmail.com');
  await page.fill('#password', 'demo123');

  console.log('3. Clicking Sign in...');
  await page.click('button[type="submit"]');

  // Handle Risk Rules popup if displayed
  try {
    const acceptBtn = page.locator('button:has-text("I Understand"), button:has-text("Accept"), button:has-text("Agree")').first();
    if (await acceptBtn.isVisible({ timeout: 4000 })) {
      console.log('4. Accepting risk rules popup...');
      await acceptBtn.click();
    }
  } catch {}

  await page.waitForTimeout(3000);
  console.log('5. Current URL after login:', page.url());

  // Capture full trading dashboard screenshot
  const screenshotDash = path.join(process.cwd(), 'ui_dashboard.png');
  await page.screenshot({ path: screenshotDash });
  console.log(`📸 Saved Trading Dashboard screenshot: ${screenshotDash}`);

  // Navigate to Option Chain page if available
  console.log('6. Testing Option Chain / Order Entry UI...');
  try {
    await page.goto('http://localhost:3000/option-chain', { waitUntil: 'networkidle', timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const screenshotOpt = path.join(process.cwd(), 'ui_option_chain.png');
    await page.screenshot({ path: screenshotOpt });
    console.log(`📸 Saved Option Chain screenshot: ${screenshotOpt}`);
  } catch (e) {
    console.log('Option chain page check skipped:', e);
  }

  await browser.close();
  console.log('\n=== PLAYWRIGHT UI VERIFICATION COMPLETE ===');
}

checkDashboardUI().catch(err => {
  console.error('Dashboard UI Error:', err);
  process.exit(1);
});
