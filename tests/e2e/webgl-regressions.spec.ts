import { expect, test } from '@playwright/test';

test.describe('WebGL Regressions', () => {
  test('keeps the interactive opacity sweep stable and exposes WebGL diagnostics', async ({ page }, testInfo) => {
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
    await page.getByRole('button', { name: 'Render' }).click();
    await page.getByLabel('Render diagnostics overlay').check();
    await expect(page.locator('.viewport-overlay--diagnostics').getByText(/Backend: webgl2/i)).toBeVisible();

    for (const opacity of [1, 0.97, 0.95, 0.5, 0]) {
      await page.evaluate(async ({ nextOpacity }) => {
        const mod = await import('/src/state/store.ts');
        const state = mod.useAppStore.getState();
        const blocker = state.objects.find((object) => object.type === 'plot' && object.name === 'Regression Sheet');
        if (!blocker || blocker.type !== 'plot') {
          throw new Error('Regression Sheet not found');
        }
        state.updatePlotMaterial(blocker.id, { opacity: nextOpacity, wireframeVisible: false });
        state.selectObject(blocker.id);
      }, { nextOpacity: opacity });
      await page.waitForTimeout(250);
    }

    expect(consoleErrors).toEqual([]);
    await testInfo.attach('opacity-sweep', {
      body: await page.locator('.viewport-shell').screenshot(),
      contentType: 'image/png',
    });
  });

  test('promotes reflective scenes to the local probe path', async ({ page }) => {
    await page.goto('/?testScene=phase5b-path-mixed-geometry');
    await expect(page.getByRole('button', { name: /Glass Sheet/i })).toBeVisible();

    const webGlGate = page.getByRole('heading', { name: 'WebGL2 Required' });
    if (await webGlGate.isVisible().catch(() => false)) {
      test.skip(true, 'WebGL2 not available in this Playwright browser session');
    }

    await page.getByRole('button', { name: 'Render' }).click();
    await page.getByLabel('Render diagnostics overlay').check();
    const diagnostics = page.locator('.viewport-overlay--diagnostics');
    await expect(diagnostics.getByText(/Reflection source: probe/i)).toBeVisible();
    await expect(diagnostics.getByText(/Reflection probes:/i)).toBeVisible();
  });
});
