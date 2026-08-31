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

  test('occludes point-light gizmos according to object opacity and depth', async ({ page }) => {
    await page.goto('/?testScene=point-light-gizmo-occlusion');
    await expect(page.getByRole('button', { name: /Gizmo Occluder/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Occlusion Test Light/i })).toBeVisible();

    const webGlGate = page.getByRole('heading', { name: 'WebGL2 Required' });
    if (await webGlGate.isVisible().catch(() => false)) {
      test.skip(true, 'WebGL2 not available in this Playwright browser session');
    }

    await page.getByRole('button', { name: 'Front' }).click();
    await page.getByRole('button', { name: /Gizmo Occluder/i }).click();
    await page.getByRole('button', { name: 'Appearance' }).click();

    const contrastByOpacity: Record<string, number> = {};
    for (const opacity of [0, 0.5, 1]) {
      await setRangeField(page, 'Opacity', String(opacity));
      await page.waitForTimeout(150);
      contrastByOpacity[String(opacity)] = await readCanvasCenterContrast(page);
    }

    expect(contrastByOpacity['0']).toBeGreaterThan(contrastByOpacity['0.5'] + 5);
    expect(contrastByOpacity['0.5']).toBeGreaterThan(contrastByOpacity['1'] + 5);
    expect(contrastByOpacity['1']).toBeLessThan(contrastByOpacity['0'] * 0.25);

    await setRangeField(page, 'Opacity', '0.5');
    await page.getByRole('button', { name: /Occlusion Test Light/i }).click();
    await page.getByRole('button', { name: 'Object' }).click();
    const positionY = page.getByRole('textbox', { name: 'Position y' });
    await positionY.fill('-2');
    await positionY.blur();
    await page.getByRole('button', { name: /Gizmo Occluder/i }).click();
    await page.getByRole('button', { name: 'Appearance' }).click();
    await page.waitForTimeout(150);
    const foregroundContrast = await readCanvasCenterContrast(page);

    expect(foregroundContrast).toBeGreaterThan(contrastByOpacity['0.5'] + 5);
    expect(foregroundContrast).toBeGreaterThan(contrastByOpacity['0'] * 0.75);
  });

  test('keeps a pinned point-light gizmo in front of its source curve', async ({ page }) => {
    await page.goto('/?testScene=pinned-light-gizmo-curve');
    await expect(page.getByRole('button', { name: /Pinned Gizmo Curve/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Pinned Test Light/i })).toBeVisible();

    const webGlGate = page.getByRole('heading', { name: 'WebGL2 Required' });
    if (await webGlGate.isVisible().catch(() => false)) {
      test.skip(true, 'WebGL2 not available in this Playwright browser session');
    }

    await page.getByRole('button', { name: 'Front' }).click();
    await page.waitForTimeout(150);
    const withCurve = await readCanvasCenterColor(page);

    await page.getByRole('checkbox', { name: 'Show Pinned Gizmo Curve' }).uncheck();
    await page.waitForTimeout(150);
    const withoutCurve = await readCanvasCenterColor(page);
    const colorDifference = Math.hypot(
      withCurve[0] - withoutCurve[0],
      withCurve[1] - withoutCurve[1],
      withCurve[2] - withoutCurve[2],
    );

    expect(colorDifference).toBeLessThan(5);

    await page.getByRole('checkbox', { name: 'Show Pinned Gizmo Curve' }).check();
    await page.getByRole('button', { name: /Pinned Gizmo Curve/i }).click();
    await page.getByRole('button', { name: 'Appearance' }).click();
    await setRangeField(page, 'Opacity', '0.5');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const throughTransparentCurve = await readCanvasCenterColor(page);
    const transparentColorDifference = Math.hypot(
      throughTransparentCurve[0] - withoutCurve[0],
      throughTransparentCurve[1] - withoutCurve[1],
      throughTransparentCurve[2] - withoutCurve[2],
    );

    expect(transparentColorDifference).toBeLessThan(5);
  });
});

async function setRangeField(page: import('@playwright/test').Page, labelText: string, numericValue: string) {
  const label = page.locator('label.range-field').filter({ hasText: labelText }).first();
  await expect(label).toBeVisible();
  const numberInput = label.locator('input').last();
  await numberInput.fill(numericValue);
  await numberInput.blur();
}

async function readCanvasCenterContrast(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolve, reject) => {
    requestAnimationFrame(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.viewport-canvas');
      const gl = canvas?.getContext('webgl2');
      if (!canvas || !gl) {
        reject(new Error('WebGL2 canvas is unavailable'));
        return;
      }

      const averagePatch = (centerX: number, centerY: number, radius = 2) => {
        const size = radius * 2 + 1;
        const pixels = new Uint8Array(size * size * 4);
        gl.readPixels(
          Math.round(centerX) - radius,
          Math.round(centerY) - radius,
          size,
          size,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        );
        const rgb = [0, 0, 0];
        for (let index = 0; index < pixels.length; index += 4) {
          rgb[0] += pixels[index];
          rgb[1] += pixels[index + 1];
          rgb[2] += pixels[index + 2];
        }
        const count = pixels.length / 4;
        return rgb.map((channel) => channel / count);
      };

      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const center = averagePatch(centerX, centerY);
      const neighbors = [
        averagePatch(centerX - 24, centerY),
        averagePatch(centerX + 24, centerY),
        averagePatch(centerX, centerY - 24),
        averagePatch(centerX, centerY + 24),
      ];
      const background = [0, 1, 2].map((channel) => (
        neighbors.reduce((sum, color) => sum + color[channel], 0) / neighbors.length
      ));
      const contrast = Math.sqrt(
        (center[0] - background[0]) ** 2
        + (center[1] - background[1]) ** 2
        + (center[2] - background[2]) ** 2,
      );
      resolve(contrast);
    });
  }));
}

async function readCanvasCenterColor(page: import('@playwright/test').Page): Promise<[number, number, number]> {
  return page.evaluate(() => new Promise<[number, number, number]>((resolve, reject) => {
    requestAnimationFrame(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.viewport-canvas');
      const gl = canvas?.getContext('webgl2');
      if (!canvas || !gl) {
        reject(new Error('WebGL2 canvas is unavailable'));
        return;
      }

      const radius = 2;
      const size = radius * 2 + 1;
      const pixels = new Uint8Array(size * size * 4);
      gl.readPixels(
        Math.round(canvas.width / 2) - radius,
        Math.round(canvas.height / 2) - radius,
        size,
        size,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      const rgb: [number, number, number] = [0, 0, 0];
      for (let index = 0; index < pixels.length; index += 4) {
        rgb[0] += pixels[index];
        rgb[1] += pixels[index + 1];
        rgb[2] += pixels[index + 2];
      }
      const count = pixels.length / 4;
      resolve([rgb[0] / count, rgb[1] / count, rgb[2] / count]);
    });
  }));
}
