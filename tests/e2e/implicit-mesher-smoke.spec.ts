import { expect, test } from '@playwright/test';

test.describe('Implicit Mesher Smoke', () => {
  test('adds an implicit plot and renders it in the viewport', async ({ page }, testInfo) => {
    await page.goto('/');

    const webGpuGate = page.getByRole('heading', { name: 'WebGL2 Required' });
    if (await webGpuGate.isVisible().catch(() => false)) {
      test.skip(true, 'WebGL2 not available in this Playwright browser session');
    }

    await expect(page.getByRole('button', { name: /Surface 1/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Curve 1/ })).toBeVisible();

    await page.getByRole('button', { name: '+ Implicit' }).click();

    const implicitItem = page.getByRole('button', { name: /Implicit 1/ });
    await expect(implicitItem).toBeVisible({ timeout: 20_000 });
    await implicitItem.click();

    await page.waitForTimeout(1200);
    const viewport = page.locator('.viewport-shell');
    await expect(viewport).toBeVisible();

    const screenshot = await viewport.screenshot();
    await testInfo.attach('implicit-mesher-viewport', {
      body: screenshot,
      contentType: 'image/png',
    });
  });
});
