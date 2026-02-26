import { expect, test, type Browser, type BrowserContext, type ConsoleMessage, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type BuiltInSceneId = 'shadow-regression' | 'phase5b-path-mixed-geometry';

interface Scenario {
  id: string;
  sceneId: BuiltInSceneId;
  expectedObjectName: RegExp;
  viewport: { width: number; height: number };
  resizeViewport: { width: number; height: number };
  deviceScaleFactor: number;
  qualityResolutionScale: number;
}

interface RenderDiagnosticsSnapshot {
  webgpuReady: boolean;
  qualityActiveRenderer: string;
  qualityRendererFallbackReason: string | null;
  qualityResolutionScale: number;
  qualitySamplesPerSecond: number;
  qualityLastResetReason: string | null;
  qualityPathExecutionMode: string | null;
  qualityPathAlignmentStatus: string | null;
  qualityPathAlignmentProbeCount: number;
  qualityPathAlignmentHitMismatches: number;
  qualityPathAlignmentMaxPointError: number;
  qualityPathAlignmentMaxDistanceError: number;
  qualityPathWorkerBatchCount: number;
  qualityPathWorkerPixelCount: number;
  qualityPathWorkerBatchLatencyMs: number;
  qualityPathWorkerBatchPixelsPerBatch: number;
  qualityPathWorkerPixelsPerSecond: number;
  qualityPathMainThreadBatchCount: number;
  qualityPathMainThreadPixelCount: number;
  qualityPathMainThreadPixelsPerSecond: number;
}

interface AppSnapshot {
  render: {
    mode: string;
    qualityRenderer: string;
    qualityResolutionScale: number;
    qualityMaxBounces: number;
    qualitySamplesTarget: number;
    qualityCurrentSamples: number;
    qualityRunning: boolean;
  };
  diagnostics: RenderDiagnosticsSnapshot;
  objects: string[];
  canvas: {
    width: number;
    height: number;
    clientWidth: number;
    clientHeight: number;
  } | null;
  browser: {
    devicePixelRatio: number;
    userAgent: string;
    gpuAdapterInfo: Record<string, unknown> | null;
  };
}

interface ScenarioPhaseResult {
  phase: 'baseline' | 'after_resize';
  elapsedMs: number;
  snapshot: AppSnapshot;
}

interface ScenarioResult {
  scenario: Scenario;
  ok: boolean;
  status: 'pass' | 'warning' | 'fail' | 'skipped';
  failureReason: string | null;
  phases: ScenarioPhaseResult[];
  deltaAfterResize: {
    probes: number;
    hitMismatches: number;
  } | null;
  perfSmoke: {
    resizePhaseMs: number;
    workerPixelsDelta: number;
    mainThreadPixelsDelta: number;
    workerPixelsPerSecondDuringResize: number | null;
    mainThreadPixelsPerSecondDuringResize: number | null;
    workerBatchLatencyMsDuringResize: number | null;
    workerBatchPixelsDuringResize: number | null;
    warnings: string[];
  } | null;
  consoleWarnings: string[];
}

interface CampaignReport {
  generatedAt: string;
  host: {
    hostname: string;
    platform: NodeJS.Platform;
    release: string;
    arch: string;
    cpuModel: string | null;
    cpuCount: number;
  };
  browserProject: string;
  scenarios: ScenarioResult[];
  summary: {
    total: number;
    pass: number;
    warning: number;
    fail: number;
    skipped: number;
    perfWarnings: number;
  };
}

const CAMPAIGN_SCENARIOS: Scenario[] = [
  {
    id: 'shadow-dpr1-qrs1.0-960x640',
    sceneId: 'shadow-regression',
    expectedObjectName: /Shadow Ribbon/i,
    viewport: { width: 960, height: 640 },
    resizeViewport: { width: 1111, height: 713 },
    deviceScaleFactor: 1,
    qualityResolutionScale: 1.0,
  },
  {
    id: 'shadow-dpr1-qrs0.75-1200x720',
    sceneId: 'shadow-regression',
    expectedObjectName: /Shadow Ribbon/i,
    viewport: { width: 1200, height: 720 },
    resizeViewport: { width: 1099, height: 777 },
    deviceScaleFactor: 1,
    qualityResolutionScale: 0.75,
  },
  {
    id: 'shadow-dpr2-qrs0.5-1200x720',
    sceneId: 'shadow-regression',
    expectedObjectName: /Shadow Ribbon/i,
    viewport: { width: 1200, height: 720 },
    resizeViewport: { width: 1037, height: 761 },
    deviceScaleFactor: 2,
    qualityResolutionScale: 0.5,
  },
  {
    id: 'mixed-dpr1-qrs0.5-960x640',
    sceneId: 'phase5b-path-mixed-geometry',
    expectedObjectName: /Line Curve \(No Tube\)/i,
    viewport: { width: 960, height: 640 },
    resizeViewport: { width: 1097, height: 689 },
    deviceScaleFactor: 1,
    qualityResolutionScale: 0.5,
  },
  {
    id: 'mixed-dpr1-qrs0.35-1000x640',
    sceneId: 'phase5b-path-mixed-geometry',
    expectedObjectName: /Line Curve \(No Tube\)/i,
    viewport: { width: 1000, height: 640 },
    resizeViewport: { width: 947, height: 701 },
    deviceScaleFactor: 1,
    qualityResolutionScale: 0.35,
  },
  {
    id: 'mixed-dpr2-qrs0.5-900x600',
    sceneId: 'phase5b-path-mixed-geometry',
    expectedObjectName: /Line Curve \(No Tube\)/i,
    viewport: { width: 900, height: 600 },
    resizeViewport: { width: 977, height: 653 },
    deviceScaleFactor: 2,
    qualityResolutionScale: 0.5,
  },
];

test.describe.serial('Phase 5B Path Alignment Campaign', () => {
  test('collects a local matrix report for path alignment across viewport/DPR/quality-scale cases', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(15 * 60_000);

    const effectiveBaseUrl = baseURL ?? 'http://127.0.0.1:41731';
    const scenarioResults: ScenarioResult[] = [];

    for (const scenario of CAMPAIGN_SCENARIOS) {
      console.log(
        `Starting scenario ${scenario.id} (scene=${scenario.sceneId}, dpr=${scenario.deviceScaleFactor}, viewport=${scenario.viewport.width}x${scenario.viewport.height}, qrs=${scenario.qualityResolutionScale})`,
      );
      const result = await runScenario(browser, effectiveBaseUrl, scenario, testInfo.project.name);
      scenarioResults.push(result);
      console.log(
        `Finished scenario ${scenario.id} => ${result.status}${result.failureReason ? ` (${result.failureReason})` : ''}`,
      );
    }

    const report: CampaignReport = {
      generatedAt: new Date().toISOString(),
      host: {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        cpuModel: os.cpus()[0]?.model ?? null,
        cpuCount: os.cpus().length,
      },
      browserProject: testInfo.project.name,
      scenarios: scenarioResults,
      summary: {
        total: scenarioResults.length,
        pass: scenarioResults.filter((r) => r.status === 'pass').length,
        warning: scenarioResults.filter((r) => r.status === 'warning').length,
        fail: scenarioResults.filter((r) => r.status === 'fail').length,
        skipped: scenarioResults.filter((r) => r.status === 'skipped').length,
        perfWarnings: scenarioResults.reduce((sum, r) => sum + (r.perfSmoke?.warnings.length ?? 0), 0),
      },
    };

    const reportDir = path.resolve(process.cwd(), 'artifacts', 'validation');
    await mkdir(reportDir, { recursive: true });
    const fileSafeProject = testInfo.project.name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const repoReportPath = path.join(reportDir, `phase5b-path-alignment-campaign-${fileSafeProject}-${timestamp}.json`);
    await writeFile(repoReportPath, JSON.stringify(report, null, 2), 'utf8');

    const outputReportPath = testInfo.outputPath('phase5b-path-alignment-campaign-report.json');
    await writeFile(outputReportPath, JSON.stringify(report, null, 2), 'utf8');
    await testInfo.attach('phase5b-path-alignment-campaign-report', {
      path: outputReportPath,
      contentType: 'application/json',
    });

    console.log(`Phase 5B path alignment campaign report: ${repoReportPath}`);
    for (const item of scenarioResults) {
      const baseline = item.phases.find((p) => p.phase === 'baseline')?.snapshot.diagnostics;
      const afterResize = item.phases.find((p) => p.phase === 'after_resize')?.snapshot.diagnostics;
      console.log(
        `[${item.status}] ${item.scenario.id} | active=${afterResize?.qualityActiveRenderer ?? baseline?.qualityActiveRenderer ?? 'n/a'}`
        + ` exec=${afterResize?.qualityPathExecutionMode ?? baseline?.qualityPathExecutionMode ?? 'n/a'}`
        + ` align=${afterResize?.qualityPathAlignmentStatus ?? baseline?.qualityPathAlignmentStatus ?? 'n/a'}`
        + ` probes=${afterResize?.qualityPathAlignmentProbeCount ?? baseline?.qualityPathAlignmentProbeCount ?? 0}`
        + ` mismatches=${afterResize?.qualityPathAlignmentHitMismatches ?? baseline?.qualityPathAlignmentHitMismatches ?? 0}`
        + ` worker_pxps=${Math.round(afterResize?.qualityPathWorkerPixelsPerSecond ?? baseline?.qualityPathWorkerPixelsPerSecond ?? 0)}`
        + ` main_pxps=${Math.round(afterResize?.qualityPathMainThreadPixelsPerSecond ?? baseline?.qualityPathMainThreadPixelsPerSecond ?? 0)}`
        + ` worker_batch_ms=${(afterResize?.qualityPathWorkerBatchLatencyMs ?? baseline?.qualityPathWorkerBatchLatencyMs ?? 0).toFixed(1)}`
        + ` worker_batch_px=${Math.round(afterResize?.qualityPathWorkerBatchPixelsPerBatch ?? baseline?.qualityPathWorkerBatchPixelsPerBatch ?? 0)}`
        + ` resize_worker_pxps=${Math.round(item.perfSmoke?.workerPixelsPerSecondDuringResize ?? 0)}`
        + ` perf_warns=${item.perfSmoke?.warnings.length ?? 0}`,
      );
      for (const warning of item.perfSmoke?.warnings ?? []) {
        console.log(`[warning] ${item.scenario.id} perf-smoke: ${warning}`);
      }
    }

    const failed = scenarioResults.filter((r) => r.status === 'fail');
    if (failed.length > 0) {
      const details = failed.map((r) => `${r.scenario.id}: ${r.failureReason ?? 'unknown'}`).join('\n');
      throw new Error(`Path alignment campaign failures (${failed.length}):\n${details}`);
    }
  });
});

async function runScenario(
  browser: Browser,
  baseUrl: string,
  scenario: Scenario,
  projectName: string,
): Promise<ScenarioResult> {
  const consoleWarnings: string[] = [];
  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({
      viewport: scenario.viewport,
      deviceScaleFactor: scenario.deviceScaleFactor,
    });
    const page = await context.newPage();
    page.on('console', (msg) => recordConsoleWarning(msg, consoleWarnings));

    const url = `${baseUrl}/?testScene=${encodeURIComponent(scenario.sceneId)}`;
    await page.goto(url);

    const webGpuGate = page.getByRole('heading', { name: 'WebGPU Required' });
    if (await webGpuGate.isVisible().catch(() => false)) {
      return {
        scenario,
        ok: false,
        status: 'skipped',
        failureReason: `WebGPU unavailable in Playwright project ${projectName}`,
        phases: [],
        deltaAfterResize: null,
        perfSmoke: null,
        consoleWarnings,
      };
    }

    await expect(page.getByRole('button', { name: scenario.expectedObjectName })).toBeVisible({ timeout: 30_000 });
    await waitForStoreReady(page, 45_000);
    await configurePathQualityMode(page, scenario.qualityResolutionScale);

    const scenarioStart = Date.now();
    const baselineSnapshot = await waitForPathProbeSnapshot(page, 1, 60_000);
    const baselineFinal = await readAppSnapshot(page);
    const baselinePhase: ScenarioPhaseResult = {
      phase: 'baseline',
      elapsedMs: Date.now() - scenarioStart,
      snapshot: baselineFinal,
    };

    await page.setViewportSize(scenario.resizeViewport);

    const targetProbeCountAfterResize = Math.max(1, baselineFinal.diagnostics.qualityPathAlignmentProbeCount + 1);
    const afterResizeSnapshot = await waitForPathProbeSnapshot(page, targetProbeCountAfterResize, 60_000);
    const afterResizeFinal = await readAppSnapshot(page);
    const afterResizePhase: ScenarioPhaseResult = {
      phase: 'after_resize',
      elapsedMs: Date.now() - scenarioStart,
      snapshot: afterResizeFinal,
    };

    const deltaAfterResize = {
      probes: afterResizeFinal.diagnostics.qualityPathAlignmentProbeCount - baselineFinal.diagnostics.qualityPathAlignmentProbeCount,
      hitMismatches: afterResizeFinal.diagnostics.qualityPathAlignmentHitMismatches - baselineFinal.diagnostics.qualityPathAlignmentHitMismatches,
    };

    const evaluation = evaluateScenarioResult(baselineFinal, afterResizeFinal, deltaAfterResize, afterResizeSnapshot);
    const perfSmoke = evaluatePerfSmoke(baselinePhase, afterResizePhase);
    const status = evaluation.status === 'fail'
      ? 'fail'
      : (evaluation.status === 'warning' || perfSmoke.warnings.length > 0 ? 'warning' : 'pass');

    return {
      scenario,
      ok: status !== 'fail',
      status,
      failureReason: evaluation.failureReason,
      phases: [baselinePhase, afterResizePhase],
      deltaAfterResize,
      perfSmoke,
      consoleWarnings,
    };
  } catch (error) {
    return {
      scenario,
      ok: false,
      status: 'fail',
      failureReason: error instanceof Error ? error.message : String(error),
      phases: [],
      deltaAfterResize: null,
      perfSmoke: null,
      consoleWarnings,
    };
  } finally {
    await context?.close().catch(() => undefined);
  }
}

function evaluateScenarioResult(
  baseline: AppSnapshot,
  afterResize: AppSnapshot,
  deltaAfterResize: { probes: number; hitMismatches: number },
  lastSnapshot: AppSnapshot,
): { status: ScenarioResult['status']; failureReason: string | null } {
  const diagnostics = afterResize.diagnostics;
  if (!diagnostics.webgpuReady) {
    return { status: 'fail', failureReason: 'renderDiagnostics.webgpuReady remained false' };
  }
  if (diagnostics.qualityActiveRenderer !== 'path') {
    return {
      status: 'fail',
      failureReason: `active quality backend was ${diagnostics.qualityActiveRenderer} (fallback=${diagnostics.qualityRendererFallbackReason ?? 'none'})`,
    };
  }
  if (!diagnostics.qualityPathExecutionMode) {
    return { status: 'fail', failureReason: 'qualityPathExecutionMode was never populated' };
  }
  if (diagnostics.qualityPathAlignmentStatus === 'probe_error') {
    return { status: 'fail', failureReason: 'alignment probe reported probe_error' };
  }
  if (diagnostics.qualityPathAlignmentStatus === 'error') {
    return {
      status: 'fail',
      failureReason: `alignment probe status=error (mismatches=${diagnostics.qualityPathAlignmentHitMismatches}, point=${diagnostics.qualityPathAlignmentMaxPointError}, dist=${diagnostics.qualityPathAlignmentMaxDistanceError})`,
    };
  }
  if (deltaAfterResize.probes < 1) {
    return { status: 'fail', failureReason: 'no additional alignment probes recorded after resize' };
  }
  if (deltaAfterResize.hitMismatches > 0) {
    return { status: 'fail', failureReason: `hit mismatches increased after resize by ${deltaAfterResize.hitMismatches}` };
  }

  const anyWarning = baseline.diagnostics.qualityPathAlignmentStatus === 'warning'
    || diagnostics.qualityPathAlignmentStatus === 'warning'
    || lastSnapshot.diagnostics.qualityPathAlignmentStatus === 'warning';
  return {
    status: anyWarning ? 'warning' : 'pass',
    failureReason: null,
  };
}

function evaluatePerfSmoke(
  baselinePhase: ScenarioPhaseResult,
  afterResizePhase: ScenarioPhaseResult,
): NonNullable<ScenarioResult['perfSmoke']> {
  const baseline = baselinePhase.snapshot.diagnostics;
  const afterResize = afterResizePhase.snapshot.diagnostics;
  const resizePhaseMs = Math.max(0, afterResizePhase.elapsedMs - baselinePhase.elapsedMs);
  const workerPixelsDelta = Math.max(0, afterResize.qualityPathWorkerPixelCount - baseline.qualityPathWorkerPixelCount);
  const mainThreadPixelsDelta = Math.max(0, afterResize.qualityPathMainThreadPixelCount - baseline.qualityPathMainThreadPixelCount);
  const workerPixelsPerSecondDuringResize = resizePhaseMs > 0 ? (workerPixelsDelta * 1000) / resizePhaseMs : null;
  const mainThreadPixelsPerSecondDuringResize = resizePhaseMs > 0 ? (mainThreadPixelsDelta * 1000) / resizePhaseMs : null;
  const workerBatchLatencyMsDuringResize = afterResize.qualityPathWorkerBatchLatencyMs > 0
    ? afterResize.qualityPathWorkerBatchLatencyMs
    : null;
  const workerBatchPixelsDuringResize = afterResize.qualityPathWorkerBatchPixelsPerBatch > 0
    ? afterResize.qualityPathWorkerBatchPixelsPerBatch
    : null;
  const warnings: string[] = [];
  const execMode = afterResize.qualityPathExecutionMode ?? baseline.qualityPathExecutionMode ?? null;
  const workerExpected = execMode === 'worker';

  if (workerExpected && resizePhaseMs >= 2000 && workerPixelsDelta <= 0) {
    warnings.push(`worker traced 0 pixels during resize phase (${resizePhaseMs} ms)`);
  }
  if (workerExpected && workerPixelsPerSecondDuringResize !== null && workerPixelsDelta > 0 && workerPixelsPerSecondDuringResize < 10) {
    warnings.push(`very low resize-phase worker throughput (${workerPixelsPerSecondDuringResize.toFixed(1)} px/s)`);
  }
  if (workerExpected && mainThreadPixelsDelta > 0) {
    warnings.push(`main-thread fallback work observed during resize phase (${mainThreadPixelsDelta} px)`);
  }
  if (workerExpected && workerBatchPixelsDuringResize !== null && workerBatchPixelsDuringResize < 64) {
    warnings.push(`very small worker batch size during resize (${workerBatchPixelsDuringResize.toFixed(0)} px/batch avg)`);
  }

  return {
    resizePhaseMs,
    workerPixelsDelta,
    mainThreadPixelsDelta,
    workerPixelsPerSecondDuringResize,
    mainThreadPixelsPerSecondDuringResize,
    workerBatchLatencyMsDuringResize,
    workerBatchPixelsDuringResize,
    warnings,
  };
}

function recordConsoleWarning(message: ConsoleMessage, sink: string[]) {
  if (message.type() !== 'warning' && message.type() !== 'error') {
    return;
  }
  const text = message.text();
  if (!/Quality path alignment probe/i.test(text) && !/Quality path alignment/i.test(text)) {
    return;
  }
  sink.push(`[${message.type()}] ${text}`);
}

async function waitForStoreReady(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await readAppSnapshot(page);
    if (snapshot?.diagnostics.webgpuReady && snapshot.objects.length > 0) {
      return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for app/store readiness after ${timeoutMs}ms`);
}

async function configurePathQualityMode(page: Page, qualityResolutionScale: number): Promise<void> {
  await page.evaluate(async ({ qrs }) => {
    const mod = await import('/src/state/store.ts');
    mod.useAppStore.getState().updateRender({
      mode: 'quality',
      qualityRenderer: 'path',
      qualityResolutionScale: qrs,
      qualitySamplesTarget: 4096,
      qualityMaxBounces: 1,
      qualityClampFireflies: true,
      showDiagnostics: true,
    });
  }, { qrs: qualityResolutionScale });
}

async function waitForPathProbeSnapshot(page: Page, minProbeCount: number, timeoutMs: number): Promise<AppSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: AppSnapshot | null = null;
  while (Date.now() < deadline) {
    const snapshot = await readAppSnapshot(page);
    lastSnapshot = snapshot;
    const d = snapshot.diagnostics;
    if (
      d.webgpuReady
      && d.qualityActiveRenderer === 'path'
      && typeof d.qualityPathAlignmentProbeCount === 'number'
      && d.qualityPathAlignmentProbeCount >= minProbeCount
      && d.qualityPathAlignmentStatus !== null
    ) {
      return snapshot;
    }
    if (d.qualityActiveRenderer !== 'none' && d.qualityActiveRenderer !== 'path') {
      throw new Error(
        `Quality backend fallback prevented path probe (active=${d.qualityActiveRenderer}, fallback=${d.qualityRendererFallbackReason ?? 'none'})`,
      );
    }
    if (d.qualityPathAlignmentStatus === 'probe_error') {
      throw new Error('qualityPathAlignmentStatus=probe_error');
    }
    await page.waitForTimeout(350);
  }
  throw new Error(
    `Timed out waiting for path alignment probe count >= ${minProbeCount} after ${timeoutMs}ms; last diagnostics=${JSON.stringify(lastSnapshot?.diagnostics ?? null)}`,
  );
}

async function readAppSnapshot(page: Page): Promise<AppSnapshot> {
  return page.evaluate(async () => {
    const mod = await import('/src/state/store.ts');
    const state = mod.useAppStore.getState();
    const canvas = document.querySelector<HTMLCanvasElement>('.viewport-shell canvas');
    let gpuAdapterInfo: Record<string, unknown> | null = null;
    try {
      const navGpu = (navigator as Navigator & { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu;
      const adapter = (await navGpu?.requestAdapter?.()) as { info?: unknown; requestAdapterInfo?: () => Promise<unknown> } | undefined;
      if (adapter) {
        if (typeof adapter.requestAdapterInfo === 'function') {
          const info = await adapter.requestAdapterInfo().catch(() => null);
          if (info && typeof info === 'object') {
            gpuAdapterInfo = { ...(info as Record<string, unknown>) };
          }
        } else if (adapter.info && typeof adapter.info === 'object') {
          gpuAdapterInfo = { ...(adapter.info as Record<string, unknown>) };
        }
      }
    } catch {
      gpuAdapterInfo = null;
    }

    return {
      render: {
        mode: state.render.mode,
        qualityRenderer: state.render.qualityRenderer,
        qualityResolutionScale: state.render.qualityResolutionScale,
        qualityMaxBounces: state.render.qualityMaxBounces,
        qualitySamplesTarget: state.render.qualitySamplesTarget,
        qualityCurrentSamples: state.render.qualityCurrentSamples,
        qualityRunning: state.render.qualityRunning,
      },
      diagnostics: {
        webgpuReady: state.renderDiagnostics.webgpuReady,
        qualityActiveRenderer: state.renderDiagnostics.qualityActiveRenderer,
        qualityRendererFallbackReason: state.renderDiagnostics.qualityRendererFallbackReason,
        qualityResolutionScale: state.renderDiagnostics.qualityResolutionScale,
        qualitySamplesPerSecond: state.renderDiagnostics.qualitySamplesPerSecond,
        qualityLastResetReason: state.renderDiagnostics.qualityLastResetReason,
        qualityPathExecutionMode: state.renderDiagnostics.qualityPathExecutionMode,
        qualityPathAlignmentStatus: state.renderDiagnostics.qualityPathAlignmentStatus,
        qualityPathAlignmentProbeCount: state.renderDiagnostics.qualityPathAlignmentProbeCount,
        qualityPathAlignmentHitMismatches: state.renderDiagnostics.qualityPathAlignmentHitMismatches,
        qualityPathAlignmentMaxPointError: state.renderDiagnostics.qualityPathAlignmentMaxPointError,
        qualityPathAlignmentMaxDistanceError: state.renderDiagnostics.qualityPathAlignmentMaxDistanceError,
        qualityPathWorkerBatchCount: state.renderDiagnostics.qualityPathWorkerBatchCount,
        qualityPathWorkerPixelCount: state.renderDiagnostics.qualityPathWorkerPixelCount,
        qualityPathWorkerBatchLatencyMs: state.renderDiagnostics.qualityPathWorkerBatchLatencyMs,
        qualityPathWorkerBatchPixelsPerBatch: state.renderDiagnostics.qualityPathWorkerBatchPixelsPerBatch,
        qualityPathWorkerPixelsPerSecond: state.renderDiagnostics.qualityPathWorkerPixelsPerSecond,
        qualityPathMainThreadBatchCount: state.renderDiagnostics.qualityPathMainThreadBatchCount,
        qualityPathMainThreadPixelCount: state.renderDiagnostics.qualityPathMainThreadPixelCount,
        qualityPathMainThreadPixelsPerSecond: state.renderDiagnostics.qualityPathMainThreadPixelsPerSecond,
      },
      objects: state.objects.map((obj) => obj.name),
      canvas: canvas
        ? {
            width: canvas.width,
            height: canvas.height,
            clientWidth: canvas.clientWidth,
            clientHeight: canvas.clientHeight,
          }
        : null,
      browser: {
        devicePixelRatio: window.devicePixelRatio,
        userAgent: navigator.userAgent,
        gpuAdapterInfo,
      },
    } satisfies AppSnapshot;
  });
}
