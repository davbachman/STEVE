import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

const REGRESSION_SCENE_URL = '/?testScene=interactive-render-regression';
const BLOCKER_NAME = 'Regression Sheet';
const RECEIVER_NAME = 'Regression Receiver';

interface BlockerDebugSnapshot {
  plotId: string;
  opacity: number;
  wireframeVisible: boolean;
  wireframeLineCount: number;
  visibleWireframeLineCount: number;
  backShellVisible: boolean;
  rootVisible: boolean;
  rootRenderingGroupId: number | null;
  rootMaterial: {
    alpha: number;
    backFaceCulling: boolean;
    cullBackFaces: boolean;
    twoSidedLighting: boolean;
    separateCullingPass: boolean;
  } | null;
  backShellMaterial: {
    alpha: number;
    backFaceCulling: boolean;
    cullBackFaces: boolean;
    twoSidedLighting: boolean;
    separateCullingPass: boolean;
  } | null;
  directionalShadowRenderList: string[];
  directionalShadowSettings: {
    transparencyShadow: boolean;
    enableSoftTransparentShadow: boolean;
  } | null;
  renderLoopFailed: boolean;
}

test.describe('Interactive Render Regressions', () => {
  test('clicking the viewport canvas does not show a browser focus outline', async ({ page }) => {
    await openRegressionScene(page);

    const canvas = page.locator('.viewport-canvas');
    await expect(canvas).toBeVisible();
    await canvas.click({ position: { x: 120, y: 120 } });

    const outline = await canvas.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        active: document.activeElement === element,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      };
    });

    expect(outline.active).toBe(true);
    expect(outline.outlineStyle).toBe('none');
    expect(outline.outlineWidth).toBe('0px');
    expect(outline.boxShadow).toBe('none');
  });

  test('transparent parametric surfaces keep wireframe hidden until explicitly enabled', async ({ page }) => {
    await openRegressionScene(page);

    await updateBlockerMaterial(page, { opacity: 0.55, wireframeVisible: false });
    const withoutWireframe = await readBlockerDebug(page);

    expect(withoutWireframe.opacity).toBeCloseTo(0.55, 3);
    expect(withoutWireframe.wireframeVisible).toBe(false);
    expect(withoutWireframe.visibleWireframeLineCount).toBe(0);
    expect(withoutWireframe.backShellVisible).toBe(true);
    expect(withoutWireframe.rootMaterial?.separateCullingPass).toBe(false);
    expect(withoutWireframe.rootMaterial?.twoSidedLighting).toBe(false);

    await updateBlockerMaterial(page, { opacity: 0.55, wireframeVisible: true });
    const withWireframe = await readBlockerDebug(page);

    expect(withWireframe.wireframeVisible).toBe(true);
    expect(withWireframe.wireframeLineCount).toBeGreaterThan(0);
    expect(withWireframe.visibleWireframeLineCount).toBeGreaterThan(0);
  });

  test('wireframe overlay no longer trips WebGPU line pipeline validation or blanks the canvas', async ({ page }) => {
    const consoleIssues: string[] = [];
    page.on('console', (msg) => recordWireframeConsoleIssue(msg, consoleIssues));

    await openRegressionScene(page);
    await updateBlockerMaterial(page, { opacity: 0.55, wireframeVisible: true });

    const blocker = await readBlockerDebug(page);

    expect(blocker.renderLoopFailed).toBe(false);
    expect(blocker.visibleWireframeLineCount).toBeGreaterThan(0);
    expect(consoleIssues).toEqual([]);
    await expect(page.locator('.viewport-shell')).toHaveScreenshot('interactive-wireframe-overlay.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.02,
    });
  });

  test('transparent blockers stay in the shadow map with approximate transmission once they enter the translucent path', async ({ page }) => {
    await openRegressionScene(page);

    const opaque = await readBlockerDebug(page);
    expect(opaque.backShellVisible).toBe(false);
    expect(opaque.rootRenderingGroupId).toBe(0);
    expect(opaque.rootMaterial?.backFaceCulling).toBe(false);
    expect(opaque.rootMaterial?.twoSidedLighting).toBe(true);
    expect(opaque.directionalShadowSettings).toEqual({
      transparencyShadow: true,
      enableSoftTransparentShadow: true,
    });
    expect(opaque.directionalShadowRenderList).toContain(`plot-${opaque.plotId}`);

    await updateBlockerMaterial(page, { opacity: 0.99, wireframeVisible: false });
    const nearOpaque99 = await readBlockerDebug(page);
    expect(nearOpaque99.backShellVisible).toBe(false);
    expect(nearOpaque99.rootRenderingGroupId).toBe(0);
    expect(nearOpaque99.rootMaterial?.backFaceCulling).toBe(false);
    expect(nearOpaque99.rootMaterial?.alpha).toBeCloseTo(1, 5);
    expect(nearOpaque99.rootMaterial?.twoSidedLighting).toBe(true);
    expect(nearOpaque99.directionalShadowRenderList).toContain(`plot-${opaque.plotId}`);

    await updateBlockerMaterial(page, { opacity: 0.97, wireframeVisible: false });
    const nearOpaque97 = await readBlockerDebug(page);
    expect(nearOpaque97.backShellVisible).toBe(false);
    expect(nearOpaque97.rootRenderingGroupId).toBe(0);
    expect(nearOpaque97.rootMaterial?.backFaceCulling).toBe(false);
    expect(nearOpaque97.rootMaterial?.alpha).toBeCloseTo(1, 5);
    expect(nearOpaque97.rootMaterial?.twoSidedLighting).toBe(true);
    expect(nearOpaque97.directionalShadowRenderList).toContain(`plot-${opaque.plotId}`);

    await updateBlockerMaterial(page, { opacity: 0.95, wireframeVisible: false });
    const translucent95 = await readBlockerDebug(page);
    expect(translucent95.backShellVisible).toBe(true);
    expect(translucent95.rootRenderingGroupId).toBe(1);
    expect(translucent95.rootMaterial?.backFaceCulling).toBe(true);
    expect(translucent95.rootMaterial?.cullBackFaces).toBe(true);
    expect(translucent95.rootMaterial?.twoSidedLighting).toBe(false);
    expect(translucent95.backShellMaterial?.backFaceCulling).toBe(true);
    expect(translucent95.backShellMaterial?.cullBackFaces).toBe(false);
    expect(translucent95.backShellMaterial?.twoSidedLighting).toBe(false);
    expect(translucent95.directionalShadowRenderList).toContain(`plot-${opaque.plotId}`);
    expect(translucent95.directionalShadowRenderList).toContain(`plot-${opaque.plotId}-back-shell`);

    await updateBlockerMaterial(page, { opacity: 0.5, wireframeVisible: false });
    const translucent50 = await readBlockerDebug(page);
    expect(translucent50.backShellVisible).toBe(true);
    expect(translucent50.rootMaterial?.separateCullingPass).toBe(false);
    expect(translucent50.backShellMaterial?.separateCullingPass).toBe(false);
    expect(translucent50.directionalShadowRenderList).toContain(`plot-${opaque.plotId}`);
    expect(translucent50.directionalShadowRenderList).toContain(`plot-${opaque.plotId}-back-shell`);
    await expect(page.locator('.viewport-shell')).toHaveScreenshot('interactive-translucent-shadow.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.02,
    });

    await updateBlockerMaterial(page, { opacity: 0, wireframeVisible: false });
    const translucent0 = await readBlockerDebug(page);
    expect(translucent0.rootVisible).toBe(true);
    expect(translucent0.backShellVisible).toBe(true);
    expect(translucent0.rootMaterial?.alpha).toBeCloseTo(0, 5);
    expect(translucent0.backShellMaterial?.alpha).toBeCloseTo(0, 5);
    expect(translucent0.directionalShadowRenderList).toContain(`plot-${opaque.plotId}`);
    expect(translucent0.directionalShadowRenderList).toContain(`plot-${opaque.plotId}-back-shell`);
  });
});

async function openRegressionScene(page: Page): Promise<void> {
  await page.goto(REGRESSION_SCENE_URL);
  await expect(page.getByRole('button', { name: 'Render' })).toBeVisible();
  const webGpuGate = page.getByRole('heading', { name: 'WebGPU Required' });
  if (await webGpuGate.isVisible().catch(() => false)) {
    test.skip(true, 'WebGPU not available in this Playwright browser session');
  }
  await expect(page.getByRole('button', { name: new RegExp(BLOCKER_NAME, 'i') })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(RECEIVER_NAME, 'i') })).toBeVisible();
  await waitForRegressionController(page);
  await page.waitForTimeout(350);
}

async function waitForRegressionController(page: Page): Promise<void> {
  await expect
    .poll(async () => page.evaluate(async ({ blockerName, receiverName }) => {
      const mod = await import('/src/state/store.ts');
      const state = mod.useAppStore.getState();
      const controller = (window as Window & { __plotRenderSceneController?: unknown }).__plotRenderSceneController as
        | { plotVisuals?: Map<string, unknown> | { size?: number } }
        | undefined;
      const blocker = state.objects.find((object) => object.type === 'plot' && object.name === blockerName);
      const receiver = state.objects.find((object) => object.type === 'plot' && object.name === receiverName);
      return Boolean(
        state.renderDiagnostics.webgpuReady
        && blocker
        && receiver
        && controller
        && typeof controller === 'object',
      );
    }, { blockerName: BLOCKER_NAME, receiverName: RECEIVER_NAME }))
    .toBe(true);
}

async function updateBlockerMaterial(
  page: Page,
  patch: { opacity?: number; wireframeVisible?: boolean },
): Promise<void> {
  await page.evaluate(async ({ blockerName, patch }) => {
    const mod = await import('/src/state/store.ts');
    const state = mod.useAppStore.getState();
    const blocker = state.objects.find((object) => object.type === 'plot' && object.name === blockerName);
    if (!blocker || blocker.type !== 'plot') {
      throw new Error(`Could not find blocker plot: ${blockerName}`);
    }
    state.updatePlotMaterial(blocker.id, patch);
  }, { blockerName: BLOCKER_NAME, patch });
  await page.waitForTimeout(250);
}

async function readBlockerDebug(page: Page): Promise<BlockerDebugSnapshot> {
  return page.evaluate(async ({ blockerName }) => {
    const mod = await import('/src/state/store.ts');
    const state = mod.useAppStore.getState();
    const blocker = state.objects.find((object) => object.type === 'plot' && object.name === blockerName);
    if (!blocker || blocker.type !== 'plot') {
      throw new Error(`Could not find blocker plot: ${blockerName}`);
    }
    const controller = (window as Window & { __plotRenderSceneController?: Record<string, unknown> }).__plotRenderSceneController;
    const plotVisuals = controller?.plotVisuals as Map<string, unknown> | undefined;
    const visual = plotVisuals?.get(blocker.id) as {
      wireframeLines?: Array<{ isVisible?: boolean }>;
      transparentBackShell?: { isVisible?: boolean; material?: Record<string, unknown> | null } | null;
      root?: { material?: Record<string, unknown> | null; renderingGroupId?: number };
    } | undefined;
    const directionalShadow = controller?.directionalShadow as {
      transparencyShadow?: boolean;
      enableSoftTransparentShadow?: boolean;
      getShadowMap?: () => { renderList?: Array<{ name?: string }> | null } | null;
    } | undefined;
    const renderList = directionalShadow?.getShadowMap?.()?.renderList ?? [];
    const wireframeLines = visual?.wireframeLines ?? [];
    const rootMaterial = visual?.root?.material as Record<string, unknown> | null | undefined;
    const backShellMaterial = visual?.transparentBackShell?.material as Record<string, unknown> | null | undefined;

    return {
      plotId: blocker.id,
      opacity: blocker.material.opacity,
      wireframeVisible: Boolean(blocker.material.wireframeVisible),
      wireframeLineCount: wireframeLines.length,
      visibleWireframeLineCount: wireframeLines.filter((line) => Boolean(line?.isVisible)).length,
      backShellVisible: Boolean(visual?.transparentBackShell?.isVisible),
      rootVisible: Boolean(visual?.root && (visual.root as { isVisible?: boolean }).isVisible),
      rootRenderingGroupId: typeof visual?.root?.renderingGroupId === 'number' ? visual.root.renderingGroupId : null,
      rootMaterial: rootMaterial
        ? {
            alpha: Number(rootMaterial.alpha ?? 0),
            backFaceCulling: Boolean(rootMaterial.backFaceCulling),
            cullBackFaces: Boolean(rootMaterial.cullBackFaces),
            twoSidedLighting: Boolean(rootMaterial.twoSidedLighting),
            separateCullingPass: Boolean(rootMaterial.separateCullingPass),
          }
        : null,
      backShellMaterial: backShellMaterial
        ? {
            alpha: Number(backShellMaterial.alpha ?? 0),
            backFaceCulling: Boolean(backShellMaterial.backFaceCulling),
            cullBackFaces: Boolean(backShellMaterial.cullBackFaces),
            twoSidedLighting: Boolean(backShellMaterial.twoSidedLighting),
            separateCullingPass: Boolean(backShellMaterial.separateCullingPass),
          }
        : null,
      directionalShadowRenderList: renderList.map((mesh) => mesh?.name ?? ''),
      directionalShadowSettings: directionalShadow
        ? {
            transparencyShadow: Boolean(directionalShadow.transparencyShadow),
            enableSoftTransparentShadow: Boolean(directionalShadow.enableSoftTransparentShadow),
          }
        : null,
      renderLoopFailed: Boolean(controller?.renderLoopFailed),
    };
  }, { blockerName: BLOCKER_NAME });
}

function recordWireframeConsoleIssue(message: ConsoleMessage, issues: string[]): void {
  if (message.type() !== 'warning' && message.type() !== 'error') {
    return;
  }
  const text = message.text();
  if (
    /depthbias/i.test(text)
    || /linelist/i.test(text)
    || /linestrip/i.test(text)
    || /gpuvalidationerror/i.test(text)
    || /render pipeline/i.test(text)
  ) {
    issues.push(text);
  }
}
