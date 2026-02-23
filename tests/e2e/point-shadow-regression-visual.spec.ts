import { expect, test } from '@playwright/test';

test.describe('Point Shadow Regression Visual', () => {
  test('matches point-shadow viewport baseline when point shadows are available', async ({ page }, testInfo) => {
    await page.goto('/?testScene=point-shadow-regression');

    await expect(page.getByRole('button', { name: 'Render' })).toBeVisible();

    const webGpuGate = page.getByRole('heading', { name: 'WebGPU Required' });
    if (await webGpuGate.isVisible().catch(() => false)) {
      test.skip(true, 'WebGPU not available in this Playwright browser session');
    }

    await expect(page.getByRole('button', { name: /Shadow Ribbon/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Shadow Sphere/i })).toBeVisible();

    await page.getByRole('button', { name: 'Render' }).click();
    await page.getByLabel('Render diagnostics overlay').check();

    const diagnostics = page.locator('.viewport-overlay--diagnostics');
    await expect(diagnostics).toBeVisible();
    await page.waitForTimeout(1800);

    const diagnosticsText = (await diagnostics.textContent()) ?? '';
    await testInfo.attach('point-shadow-diagnostics.txt', {
      body: Buffer.from(diagnosticsText, 'utf8'),
      contentType: 'text/plain',
    });

    if (diagnosticsText.includes('Point shadow support: unavailable')) {
      test.skip(true, 'Point shadow generators are unavailable in this WebGPU/browser session');
    }
    if (!/Point shadows:\s*[1-9]\d*\//.test(diagnosticsText)) {
      test.skip(true, `Point shadows are not active in this session: ${diagnosticsText}`);
    }

    await expect(diagnostics.getByText(/Point shadows:\s*[1-9]\d*\/1 \(on\)/)).toBeVisible();

    // Hide overlay before snapshot so only the rendered image is compared.
    await page.getByLabel('Render diagnostics overlay').uncheck();
    await page.waitForTimeout(800);

    const canvas = page.locator('.viewport-canvas');
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveScreenshot('point-shadow-regression-canvas.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.015,
    });
  });
});
