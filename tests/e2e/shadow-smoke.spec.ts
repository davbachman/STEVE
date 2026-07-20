import { expect, test } from '@playwright/test';

test.describe('WebGL2 Shadow Smoke', () => {
  test('opens app, toggles shadow controls, and captures a shadow-debug screenshot', async ({ page }, testInfo) => {
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Appearance' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Lighting' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Scene Settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Render' })).toHaveCount(0);
    await expect(page.locator('.viewport-overlay--diagnostics')).toHaveCount(0);

    const webGpuGate = page.getByRole('heading', { name: 'WebGL2 Required' });
    if (await webGpuGate.isVisible().catch(() => false)) {
      test.skip(true, 'WebGL2 not available in this Playwright browser session');
    }

    await page.getByLabel('Shadow map resolution').selectOption('1024');
    await setRangeField(page, 'Shadow softness', '0.55');
    await setRangeField(page, 'Intensity', '0.05'); // ambient intensity
    await page.getByLabel('XY grid').check();
    await page.getByLabel('Ground plane').check();

    await page.getByRole('button', { name: /Directional Light 1/ }).click();
    await page.getByRole('button', { name: 'Appearance' }).click();
    await page.getByLabel('Cast shadows').check();
    await setRangeField(page, 'Intensity', '1.8');

    // Give the WebGL renderer a moment to refresh shadow maps after control changes.
    await page.waitForTimeout(1200);

    const viewport = page.locator('.viewport-shell');
    await expect(viewport).toBeVisible();
    const screenshot = await viewport.screenshot();
    await testInfo.attach('shadow-debug-viewport', {
      body: screenshot,
      contentType: 'image/png',
    });
  });
});

async function setRangeField(
  page: import('@playwright/test').Page,
  labelText: string,
  numericValue: string,
  options?: { occurrence?: number },
) {
  const occurrence = options?.occurrence ?? 0;
  const label = page.locator('label.range-field').filter({ hasText: labelText }).nth(occurrence);
  await expect(label).toBeVisible();
  const numberInput = label.locator('input.numeric-expression-input').last();
  await numberInput.fill(numericValue);
  await numberInput.blur();
}
