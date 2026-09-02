import { chromium } from 'playwright-core';

async function test() {
  console.log('Launching chromium...');
  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('http://localhost:3000');
    const title = await page.title();
    console.log('PAGE TITLE:', title);
    await browser.close();
  } catch (e: any) {
    console.error('Launch failed:', e.message);
  }
}

test();
