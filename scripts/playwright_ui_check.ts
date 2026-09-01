import { chromium } from '/home/cluelessdev/.gemini/antigravity/brain/4554b5a9-80e8-4cd8-b1cf-9be9b6f5de19/scratch/node_modules/playwright';
import path from 'path';

async function checkDashboardUI() {
  console.log('=== RUNNING PLAYWRIGHT DASHBOARD UI VERIFICATION ===\n');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  console.log('1. Navigating to login page http://localhost:3000...');
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

  // Click Try Demo Account
  console.log('2. Clicking "Try Demo Account"...');
  const demoBtn = page.locator('text="Try Demo Account"').first();
  await demoBtn.click();

  // Wait for main dashboard to load
  await page.waitForTimeout(3000);
  console.log('3. Dashboard loaded! Current URL:', page.url());

  // Capture full trading dashboard screenshot
  const screenshotDash = path.join(process.cwd(), 'ui_dashboard.png');
  await page.screenshot({ path: screenshotDash });
  console.log(`📸 Saved Trading Dashboard screenshot: ${screenshotDash}`);

  // Find Orders tab or section
  const ordersTab = page.locator('text="Orders"').first();
  if (await ordersTab.isVisible()) {
    console.log('4. Clicking "Orders" tab...');
    await ordersTab.click();
    await page.waitForTimeout(1500);
    const screenshotOrders = path.join(process.cwd(), 'ui_orders_tab.png');
    await page.screenshot({ path: screenshotOrders });
    console.log(`📸 Saved Open Orders tab screenshot: ${screenshotOrders}`);
  }

  // Find Positions tab or section
  const positionsTab = page.locator('text="Positions"').first();
  if (await positionsTab.isVisible()) {
    console.log('5. Clicking "Positions" tab...');
    await positionsTab.click();
    await page.waitForTimeout(1500);
    const screenshotPos = path.join(process.cwd(), 'ui_positions_tab.png');
    await page.screenshot({ path: screenshotPos });
    console.log(`📸 Saved Positions tab screenshot: ${screenshotPos}`);
  }

  await browser.close();
  console.log('\n=== PLAYWRIGHT DASHBOARD UI VERIFICATION COMPLETE ===');
}

checkDashboardUI().catch(err => {
  console.error('Dashboard UI Error:', err);
  process.exit(1);
});
