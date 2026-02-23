import { expect, test } from '@playwright/test';

test.describe('WebGPU Shadow Smoke', () => {
  test('opens app, toggles shadow controls, and captures a shadow-debug screenshot', async ({ page }, testInfo) => {
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Lighting' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Scene' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Render' })).toBeVisible();

    const webGpuGate = page.getByRole('heading', { name: 'WebGPU Required' });
    if (await webGpuGate.isVisible().catch(() => false)) {
      test.skip(true, 'WebGPU not available in this Playwright browser session');
    }

    await page.getByRole('button', { name: 'Render' }).click();
    await page.getByLabel('Render diagnostics overlay').check();
    await expect(page.getByText('Renderer Diagnostics')).toBeVisible();

    await page.getByRole('button', { name: 'Lighting' }).click();
    await page.getByLabel('Point Shadows').selectOption('on');
    await setRangeField(page, 'Shadow map resolution', '1024');
    await setRangeField(page, 'Shadow softness', '0.55');
    await page.getByLabel('Directional shadows enabled').check();
    await page.getByLabel('Cast shadows').nth(0).check(); // directional cast shadows
    await setRangeField(page, 'Intensity', '0.05', { occurrence: 0 }); // ambient intensity
    await setRangeField(page, 'Intensity', '1.8', { occurrence: 1 }); // directional intensity

    await page.getByRole('button', { name: 'Scene' }).click();
    await page.getByLabel('XY grid').check();
    await page.getByLabel('Grid shadow receiver').check();
    await page.getByLabel('Ground plane').uncheck();

    await page.getByRole('button', { name: 'Render' }).click();
    const diagnosticsOverlay = page.locator('.viewport-overlay--diagnostics');
    await expect(diagnosticsOverlay).toBeVisible();
    await expect(diagnosticsOverlay.getByText('Receiver: grid')).toBeVisible();

    // Give Babylon a moment to update shadow maps after control changes.
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
  const numberInput = label.locator('input[type="number"]').last();
  await numberInput.fill(numericValue);
  await numberInput.dispatchEvent('change');
}
