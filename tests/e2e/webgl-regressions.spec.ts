import { expect, test } from '@playwright/test';

test.describe('WebGL Regressions', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://cloudflareinsights.com/**', (route) => route.fulfill({
      status: 204,
      headers: { 'access-control-allow-origin': '*' },
    }));
  });

  test('keeps the interactive opacity sweep stable', async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    await page.goto('/?testScene=interactive-render-regression');
    await expect(page.getByRole('button', { name: /Regression Sheet/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Regression Receiver/i })).toBeVisible();

    const webGlGate = page.getByRole('heading', { name: 'WebGL2 Required' });
    if (await webGlGate.isVisible().catch(() => false)) {
      test.skip(true, 'WebGL2 not available in this Playwright browser session');
    }

    await page.getByRole('button', { name: /Regression Sheet/i }).click();
    await expect(page.getByRole('button', { name: 'Render' })).toHaveCount(0);
    await expect(page.locator('.viewport-overlay--diagnostics')).toHaveCount(0);
    await page.getByRole('button', { name: 'Appearance' }).click();

    for (const opacity of [1, 0.97, 0.95, 0.5, 0]) {
      await setRangeField(page, 'Opacity', String(opacity));
      await page.waitForTimeout(250);
    }

    expect(consoleErrors).toEqual([]);
    await testInfo.attach('opacity-sweep', {
      body: await page.locator('.viewport-shell').screenshot(),
      contentType: 'image/png',
    });
  });

  test('keeps reflective scenes stable without the diagnostics overlay', async ({ page }) => {
    await page.goto('/?testScene=phase5b-path-mixed-geometry');
    await expect(page.getByRole('button', { name: /Glass Sheet/i })).toBeVisible();

    const webGlGate = page.getByRole('heading', { name: 'WebGL2 Required' });
    if (await webGlGate.isVisible().catch(() => false)) {
      test.skip(true, 'WebGL2 not available in this Playwright browser session');
    }

    await expect(page.getByRole('button', { name: 'Render' })).toHaveCount(0);
    await expect(page.locator('.viewport-overlay--diagnostics')).toHaveCount(0);
    await page.waitForTimeout(1000);
    await expect(page.locator('.viewport-shell')).toBeVisible();
  });
});

async function setRangeField(page: import('@playwright/test').Page, labelText: string, numericValue: string) {
  const label = page.locator('label.range-field').filter({ hasText: labelText }).first();
  await expect(label).toBeVisible();
  const numberInput = label.locator('input').last();
  await numberInput.fill(numericValue);
  await numberInput.blur();
}
