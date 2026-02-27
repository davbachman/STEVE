import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

test.describe('Implicit Mesher Smoke', () => {
  test('adds an implicit plot and renders it in the viewport', async ({ page }, testInfo) => {
    await page.goto('/');

    const webGpuGate = page.getByRole('heading', { name: 'WebGPU Required' });
    if (await webGpuGate.isVisible().catch(() => false)) {
      test.skip(true, 'WebGPU not available in this Playwright browser session');
    }

    await expect(page.getByRole('button', { name: /Ribbon Surface/ })).toContainText('Ready');
    await expect(page.getByRole('button', { name: /Helix/ })).toContainText('Ready');

    await page.getByRole('button', { name: '+ Implicit' }).click();

    const implicitItem = page.getByRole('button', { name: /Implicit .*Ready/ });
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

    const outDir = path.join(process.cwd(), 'artifacts', 'playwright-checks');
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, 'implicit-mesher-smoke.png'), screenshot);
  });
});
