import { expect, test } from '@playwright/test';

test.describe('Shadow Regression Visual', () => {
  test('matches the dedicated shadow regression scene viewport baseline', async ({ page }) => {
    await page.goto('/?testScene=shadow-regression');

    await expect(page.getByRole('button', { name: 'Render' })).toBeVisible();

    const webGpuGate = page.getByRole('heading', { name: 'WebGPU Required' });
    if (await webGpuGate.isVisible().catch(() => false)) {
      test.skip(true, 'WebGPU not available in this Playwright browser session');
    }

    // Wait for the dedicated scene to load into the object list and for Babylon to render a few frames.
    await expect(page.getByRole('button', { name: /Shadow Ribbon/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Shadow Sphere/i })).toBeVisible();
    await page.waitForTimeout(1500);

    const viewport = page.locator('.viewport-shell');
    await expect(viewport).toBeVisible();
    await expect(viewport).toHaveScreenshot('shadow-regression-viewport.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.012,
    });
  });
});
