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
    await expect(page.getByRole('button', { name: /Pinned Gizmo Occluder/i })).toBeVisible();

    const webGlGate = page.getByRole('heading', { name: 'WebGL2 Required' });
    if (await webGlGate.isVisible().catch(() => false)) {
      test.skip(true, 'WebGL2 not available in this Playwright browser session');
    }
    await page.waitForTimeout(50);
    await expect(page.getByRole('status', {
      name: /Building (Pinned Gizmo Curve|Pinned Gizmo Occluder)/,
    })).toHaveCount(0, { timeout: 30_000 });

    await page.getByRole('checkbox', { name: 'Show Pinned Gizmo Curve' }).uncheck();
    await page.waitForTimeout(150);
    const obliqueGizmoCenter = await findPointLightGizmoCenter(page);
    const obliqueWithoutCurve = await readCanvasDiscPixels(page, obliqueGizmoCenter);
    await page.getByRole('checkbox', { name: 'Show Pinned Gizmo Curve' }).check();
    await page.waitForTimeout(150);
    const obliqueWithCurve = await readCanvasDiscPixels(page, obliqueGizmoCenter);
    expect(meanPixelDifference(obliqueWithCurve, obliqueWithoutCurve)).toBeLessThan(5);

    const projection = page.getByRole('combobox', { name: 'Camera Projection' });
    await projection.selectOption('perspective');
    await page.getByRole('checkbox', { name: 'Show Pinned Gizmo Curve' }).uncheck();
    await page.waitForTimeout(150);
    const perspectiveGizmoCenter = await findPointLightGizmoCenter(page);
    const perspectiveWithoutCurve = await readCanvasDiscPixels(page, perspectiveGizmoCenter, 5);
    await page.getByRole('checkbox', { name: 'Show Pinned Gizmo Curve' }).check();
    await page.waitForTimeout(150);
    const perspectiveWithCurve = await readCanvasDiscPixels(page, perspectiveGizmoCenter, 5);
    expect(meanPixelDifference(perspectiveWithCurve, perspectiveWithoutCurve)).toBeLessThan(5);

    await projection.selectOption('orthographic');
    await page.getByRole('button', { name: 'Front' }).click();
    await page.waitForTimeout(150);
    await page.getByRole('checkbox', { name: 'Show Pinned Gizmo Curve' }).uncheck();
    await page.waitForTimeout(150);
    const gizmoCenter = await findPointLightGizmoCenter(page);
    const withoutCurve = await readCanvasDiscPixels(page, gizmoCenter);
    const withoutCurveCenter = await readCanvasDiscPixels(page, gizmoCenter, 2);

    await page.getByRole('checkbox', { name: 'Show Pinned Gizmo Curve' }).check();
    await page.waitForTimeout(150);
    const withOpaqueCurve = await readCanvasDiscPixels(page, gizmoCenter);
    const withOpaqueCurveCenter = await readCanvasDiscPixels(page, gizmoCenter, 2);

    expect(meanPixelDifference(withOpaqueCurve, withoutCurve)).toBeLessThan(5);
    expect(meanPixelDifference(withOpaqueCurveCenter, withoutCurveCenter)).toBeLessThan(5);

    await page.getByRole('button', { name: /Pinned Gizmo Curve/i }).click();
    await page.getByRole('button', { name: 'Appearance' }).click();
    await page.waitForTimeout(150);
    const selectedGizmoCenter = await findPointLightGizmoCenter(page);
    const withSelectedOpaqueCurve = await readCanvasDiscPixels(page, selectedGizmoCenter);
    await page.getByRole('checkbox', { name: 'Show Pinned Gizmo Curve' }).uncheck();
    await page.waitForTimeout(150);
    const withoutSelectedCurve = await readCanvasDiscPixels(page, selectedGizmoCenter);
    await page.getByRole('checkbox', { name: 'Show Pinned Gizmo Curve' }).check();
    await page.waitForTimeout(150);
    expect(meanPixelDifference(withSelectedOpaqueCurve, withoutSelectedCurve)).toBeLessThan(5);

    await setRangeField(page, 'Opacity', '0.5');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const throughTransparentCurve = await readCanvasDiscPixels(page, gizmoCenter);
    const throughTransparentCurveCenter = await readCanvasDiscPixels(page, gizmoCenter, 2);

    expect(meanPixelDifference(throughTransparentCurve, withoutCurve)).toBeLessThan(5);
    expect(meanPixelDifference(throughTransparentCurveCenter, withoutCurveCenter)).toBeLessThan(5);

    await page.getByRole('button', { name: /Pinned Gizmo Curve/i }).click();
    await page.getByRole('button', { name: 'Appearance' }).click();
    await setRangeField(page, 'Opacity', '1');
    await page.getByRole('button', { name: /Pinned Gizmo Occluder/i }).click();
    await page.getByRole('button', { name: 'Appearance' }).click();
    await page.waitForTimeout(150);
    const occluderGizmoCenter = await findPointLightGizmoCenter(page);
    const withoutOccluder = await readCanvasDiscPixels(page, occluderGizmoCenter);
    const withoutOccluderCenter = await readCanvasDiscPixels(page, occluderGizmoCenter, 2);
    await setRangeField(page, 'Opacity', '0.5');
    await page.waitForTimeout(150);
    const throughTransparentOccluder = await readCanvasDiscPixels(page, occluderGizmoCenter);
    const throughTransparentOccluderCenter = await readCanvasDiscPixels(page, occluderGizmoCenter, 2);
    await setRangeField(page, 'Opacity', '1');
    await page.waitForTimeout(150);
    const behindOpaqueOccluder = await readCanvasDiscPixels(page, occluderGizmoCenter);
    const behindOpaqueOccluderCenter = await readCanvasDiscPixels(page, occluderGizmoCenter, 2);

    const transparentOccluderDifference = meanPixelDifference(throughTransparentOccluder, withoutOccluder);
    const opaqueOccluderDifference = meanPixelDifference(behindOpaqueOccluder, withoutOccluder);
    const transparentOccluderCenterDifference = meanPixelDifference(
      throughTransparentOccluderCenter,
      withoutOccluderCenter,
    );
    const opaqueOccluderCenterDifference = meanPixelDifference(behindOpaqueOccluderCenter, withoutOccluderCenter);
    expect(transparentOccluderDifference).toBeGreaterThan(5);
    expect(opaqueOccluderDifference).toBeGreaterThan(transparentOccluderDifference + 5);
    expect(transparentOccluderCenterDifference).toBeGreaterThan(5);
    expect(opaqueOccluderCenterDifference).toBeGreaterThan(transparentOccluderCenterDifference + 5);

    await setRangeField(page, 'Opacity', '0.5');
    await page.getByRole('button', { name: 'Object' }).click();
    const occluderPositionY = page.getByRole('textbox', { name: 'Position y' });
    await occluderPositionY.fill('-3');
    await occluderPositionY.blur();
    await page.waitForTimeout(150);
    const frontOccluderCenter = await findPointLightGizmoCenter(page);
    const frontOccluderWithSource = await readCanvasDiscPixels(page, frontOccluderCenter, 2);

    await page.getByRole('checkbox', { name: 'Show Pinned Gizmo Curve' }).uncheck();
    await page.waitForTimeout(150);
    const frontOccluderWithoutSourceCenter = await findPointLightGizmoCenter(page);
    const frontOccluderWithoutSource = await readCanvasDiscPixels(page, frontOccluderWithoutSourceCenter, 2);

    expect(meanPixelDifference(frontOccluderWithSource, frontOccluderWithoutSource)).toBeLessThan(5);
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

interface CanvasPoint {
  x: number;
  y: number;
}

async function findPointLightGizmoCenter(page: import('@playwright/test').Page): Promise<CanvasPoint> {
  return page.evaluate(() => new Promise<CanvasPoint>((resolve, reject) => {
    requestAnimationFrame(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.viewport-canvas');
      const gl = canvas?.getContext('webgl2');
      if (!canvas || !gl) {
        reject(new Error('WebGL2 canvas is unavailable'));
        return;
      }

      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let weightedX = 0;
      let weightedY = 0;
      let totalWeight = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index];
        const green = pixels[index + 1];
        const blue = pixels[index + 2];
        const weight = Math.max(0, red + green - blue - 180);
        if (weight <= 0) {
          continue;
        }
        const pixelIndex = index / 4;
        weightedX += (pixelIndex % canvas.width) * weight;
        weightedY += Math.floor(pixelIndex / canvas.width) * weight;
        totalWeight += weight;
      }
      if (totalWeight <= 0) {
        reject(new Error('Point-light gizmo pixels were not found'));
        return;
      }
      resolve({ x: weightedX / totalWeight, y: weightedY / totalWeight });
    });
  }));
}

async function readCanvasDiscPixels(
  page: import('@playwright/test').Page,
  center: CanvasPoint,
  radius = 11,
): Promise<number[]> {
  return page.evaluate(({ center, radius }) => new Promise<number[]>((resolve, reject) => {
    requestAnimationFrame(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.viewport-canvas');
      const gl = canvas?.getContext('webgl2');
      if (!canvas || !gl) {
        reject(new Error('WebGL2 canvas is unavailable'));
        return;
      }

      const size = radius * 2 + 1;
      const pixels = new Uint8Array(size * size * 4);
      gl.readPixels(
        Math.round(center.x) - radius,
        Math.round(center.y) - radius,
        size,
        size,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      const discPixels: number[] = [];
      for (let y = -radius; y <= radius; y += 1) {
        for (let x = -radius; x <= radius; x += 1) {
          if (x * x + y * y > radius * radius) {
            continue;
          }
          const index = ((y + radius) * size + x + radius) * 4;
          discPixels.push(pixels[index], pixels[index + 1], pixels[index + 2]);
        }
      }
      resolve(discPixels);
    });
  }), { center, radius });
}

function meanPixelDifference(left: number[], right: number[]): number {
  expect(left).toHaveLength(right.length);
  return left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0) / left.length;
}
