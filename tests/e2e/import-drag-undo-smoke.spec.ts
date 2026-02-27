import { expect, test } from '@playwright/test';

test.describe('Import + Drag Undo Smoke', () => {
  test('dragging a plot undoes cleanly and mixed imports skip invalid objects', async ({ page }, testInfo) => {
    await page.goto('/');

    const webGpuGate = page.getByRole('heading', { name: 'WebGPU Required' });
    if (await webGpuGate.isVisible().catch(() => false)) {
      test.skip(true, 'WebGPU not available in this Playwright browser session');
    }

    await expect(page.getByRole('button', { name: /Ribbon Surface/ })).toContainText('Ready');
    await expect(page.getByRole('button', { name: /Helix/ })).toContainText('Ready');

    await page.getByRole('button', { name: /Ribbon Surface/ }).click();
    const viewportCanvas = page.locator('canvas').first();
    await expect(viewportCanvas).toBeVisible();
    const box = await viewportCanvas.boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;

    const xInput = page.locator('.control-grid--triplet').filter({ hasText: 'Position' }).locator('input[type="number"]').nth(0);
    await expect(xInput).toHaveValue('0');

    const start = { x: box.x + box.width * 0.52, y: box.y + box.height * 0.55 };
    const end = { x: start.x + 120, y: start.y - 40 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);

    await expect(xInput).not.toHaveValue('0');
    await testInfo.attach('after-drag', { body: await page.locator('.viewport-shell').screenshot(), contentType: 'image/png' });

    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForTimeout(300);
    await expect(xInput).toHaveValue('0');
    await testInfo.attach('after-undo', { body: await page.locator('.viewport-shell').screenshot(), contentType: 'image/png' });

    const mixedImport = {
      schemaVersion: 1,
      appVersion: 'e2e-mixed-import',
      scene: {},
      render: {},
      objects: [
        {
          id: 'imported-plot',
          name: 'Imported Demo Surface',
          type: 'plot',
          visible: true,
          transform: { position: { x: 0.5, y: -0.25, z: 0 } },
          equation: {
            kind: 'explicit_surface',
            source: { rawText: 'z = 0.5*sin(x)*cos(y)' },
          },
          material: {
            baseColor: '#ff7a45',
            opacity: 0.95,
            transmission: 0.05,
            ior: 1.4,
            reflectiveness: 0.3,
            roughness: 0.45,
          },
        },
        { id: 'unknown', type: 'alien_widget' },
      ],
    };

    await page.setInputFiles('input[type="file"]', {
      name: 'mixed-import.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(mixedImport, null, 2)),
    });

    await expect(page.getByText('Project loaded (skipped 1 invalid object)')).toBeVisible();
    await expect(page.getByRole('button', { name: /Imported Demo Surface/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Imported Light 2/ })).not.toBeVisible();

    await page.waitForTimeout(800);
    await testInfo.attach('after-import', { body: await page.locator('.viewport-shell').screenshot(), contentType: 'image/png' });
  });
});
