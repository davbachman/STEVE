import type { PlotGeometry } from '../plotGeometry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { SceneController } from '../SceneController';
import { resolveInteractiveRenderBudget, resolvePngExportBudget, resolvePngExportScale, resolveShadowUpVector, type RenderBudget } from '../renderBudget';
import { createRendererSceneSnapshot, type RendererSceneSnapshot } from '../renderSnapshot';
import { createDefaultGraph, createDirectionalLight, createPointLight, defaultRenderSettings, defaultSceneSettings } from '../../state/defaults';
import type { CameraState } from '../../types/contracts';
import type { AppState } from '../../state/store';
import { useAppStore } from '../../state/store';

function mockGl() {
  let id = 0;
  return {
    FRAMEBUFFER_COMPLETE: 1,
    getParameter: vi.fn(() => 4096),
    COLOR_ATTACHMENT0: 100,
    COLOR_ATTACHMENT15: 115,
    DEPTH_ATTACHMENT: 200,
    createTexture: vi.fn(() => ({ id: ++id })),
    deleteTexture: vi.fn(),
    createFramebuffer: vi.fn(() => ({ id: ++id })),
    deleteFramebuffer: vi.fn(),
    bindFramebuffer: vi.fn(),
    checkFramebufferStatus: vi.fn(() => 1),
    framebufferTexture2D: vi.fn(),
    bindTexture: vi.fn(),
    texImage2D: vi.fn(),
    texParameteri: vi.fn(),
    generateMipmap: vi.fn(),
    createBuffer: vi.fn(() => ({ id: ++id })),
    createVertexArray: vi.fn(() => ({ id: ++id })),
    bindBuffer: vi.fn(), bindVertexArray: vi.fn(), bufferData: vi.fn(), bufferSubData: vi.fn(),
    enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(),
    deleteBuffer: vi.fn(), deleteVertexArray: vi.fn(),
    drawBuffers: vi.fn(),
    readBuffer: vi.fn(),
  };
}

type ControllerInternals = {
  gl: WebGL2RenderingContext;
  renderPrograms: object;
  maxFragmentTextureUnits: number;
  latestSnapshot: RendererSceneSnapshot;
  pendingProbeRefresh: boolean;
  pngExportBudget: RenderBudget | null;
  recordingGif: boolean;
  camera: { alpha: number; beta: number; radius: number; target: vec3; upVector: vec3 };
  restoreCamera: (state: CameraState | undefined) => void;
  persistCamera: () => void;
  sync: (state: Pick<AppState, 'scene' | 'render' | 'objects' | 'selectedId' | 'plotJobs'>) => void;
  updateTurntableCamera: (elapsedMs: number) => void;
  turntableTarget: vec3 | null;
  cameraSaveTimer: ReturnType<typeof setTimeout> | undefined;
  animationFrame: number;
  requestRender: () => void;
  renderFrame: (timestamp: number) => void;
  renderScene: () => void;
  ensureShadowResources: (size: number, directional: boolean, pointCount: number, transparent: boolean) => void;
  shadowResources: { pointDepthCubemaps: unknown[]; pointTransDepthCubemaps: unknown[]; directionalFramebuffer: unknown };
};

function controllerFixture() {
  const gl = mockGl();
  const canvas = document.createElement('canvas');
  const controller = new SceneController(canvas);
  const internal = controller as unknown as ControllerInternals;
  internal.gl = gl as unknown as WebGL2RenderingContext;
  return { gl, internal, controller, canvas };
}

afterEach(() => vi.restoreAllMocks());

describe('shadow resource lifetime', () => {
  it('allocates no shadow maps for scenes without shadow-casting lights', () => {
    const { gl, internal } = controllerFixture();
    internal.ensureShadowResources(2048, false, 0, false);
    expect(gl.createTexture).not.toHaveBeenCalled();
    expect(gl.createFramebuffer).not.toHaveBeenCalled();
  });

  it('allocates only active point-light slots and only allocates transmittance for transparent casters', () => {
    const { gl, internal } = controllerFixture();
    internal.ensureShadowResources(1024, false, 1, false);
    expect(gl.createTexture).toHaveBeenCalledTimes(1);
    expect(gl.texImage2D).toHaveBeenCalledTimes(6);
    expect(internal.shadowResources.directionalFramebuffer).toBeNull();
    internal.ensureShadowResources(1024, false, 1, false);
    expect(gl.createTexture).toHaveBeenCalledTimes(1);

    internal.ensureShadowResources(1024, false, 1, true);
    expect(gl.createTexture).toHaveBeenCalledTimes(3);
    expect(internal.shadowResources.pointTransDepthCubemaps).toHaveLength(1);
    internal.ensureShadowResources(1024, false, 2, true);
    expect(gl.createTexture).toHaveBeenCalledTimes(6);
    internal.ensureShadowResources(1024, false, 1, false);
    expect(gl.deleteTexture).toHaveBeenCalledTimes(5);
    expect(internal.shadowResources.pointDepthCubemaps).toHaveLength(1);
    expect(internal.shadowResources.pointTransDepthCubemaps).toHaveLength(0);
    internal.ensureShadowResources(1024, false, 0, false);
    expect(gl.deleteTexture).toHaveBeenCalledTimes(6);
  });

  it('reuses directional maps, releases disabled channels, and replaces maps on a resolution change', () => {
    const { gl, internal } = controllerFixture();
    internal.ensureShadowResources(1024, true, 0, false);
    expect(gl.createTexture).toHaveBeenCalledTimes(1);
    internal.ensureShadowResources(1024, true, 0, true);
    expect(gl.createTexture).toHaveBeenCalledTimes(3);
    internal.ensureShadowResources(512, true, 0, false);
    expect(gl.deleteTexture).toHaveBeenCalledTimes(3);
    expect(gl.createTexture).toHaveBeenCalledTimes(4);
    internal.ensureShadowResources(512, false, 0, false);
    expect(gl.deleteTexture).toHaveBeenCalledTimes(4);
  });
});

describe('render scheduling', () => {
  function fixture() {
    const { internal } = controllerFixture();
    const scheduled: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      scheduled.push(callback);
      return scheduled.length;
    });
    internal.renderPrograms = {};
    internal.latestSnapshot = { scene: { turntableEnabled: false } } as RendererSceneSnapshot;
    internal.renderScene = vi.fn();
    return { internal, scheduled };
  }

  it('coalesces updates into one frame, stops while idle, and wakes for another change', () => {
    const { internal, scheduled } = fixture();
    internal.requestRender();
    internal.requestRender();
    expect(scheduled).toHaveLength(1);
    scheduled[0](100);
    expect(internal.renderScene).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
    internal.requestRender();
    expect(scheduled).toHaveLength(2);
  });

  it('continues until reflection probes converge, then sleeps', () => {
    const { internal, scheduled } = fixture();
    internal.pendingProbeRefresh = true;
    internal.requestRender();
    scheduled[0](100);
    expect(scheduled).toHaveLength(2);
    internal.pendingProbeRefresh = false;
    scheduled[1](116);
    expect(scheduled).toHaveLength(2);
  });

  it('keeps turntable animation alive but does not compete with GIF capture', () => {
    const { internal, scheduled } = fixture();
    internal.latestSnapshot.scene.turntableEnabled = true;
    internal.latestSnapshot.scene.turntableSpeed = 20;
    internal.requestRender();
    scheduled[0](100);
    expect(scheduled).toHaveLength(2);
    internal.recordingGif = true;
    scheduled[1](116);
    internal.requestRender();
    expect(scheduled).toHaveLength(2);
    expect(internal.renderScene).toHaveBeenCalledTimes(1);
  });
});

describe('interactive quality budgets', () => {
  it('reduces pixels, shadow memory, and reflections without touching geometry', () => {
    const performance = resolveInteractiveRenderBudget('performance', 2);
    const balanced = resolveInteractiveRenderBudget('balanced', 2);
    const quality = resolveInteractiveRenderBudget('quality', 2);
    expect(performance.pixelRatio).toBe(1);
    expect(balanced.pixelRatio).toBe(1.5);
    expect(quality.pixelRatio).toBe(2);
    expect(performance.maxShadowSize).toBeLessThan(balanced.maxShadowSize);
    expect(balanced.maxShadowSize).toBeLessThan(quality.maxShadowSize);
    expect(performance.probeSize).toBeLessThan(quality.probeSize);
    expect(performance.planarScale).toBeLessThan(quality.planarScale);
  });

  it('keeps straight-down and straight-up shadow cameras nonsingular', () => {
    for (const z of [-1, 1]) {
      const up = resolveShadowUpVector({ x: 0, y: 0, z });
      const matrix = mat4.lookAt(mat4.create(), vec3.fromValues(0, 0, -z * 24), vec3.create(), up);
      expect(Math.abs(mat4.determinant(matrix))).toBeCloseTo(1);
    }
  });
});


describe('render invalidation and saved camera', () => {
  it('reuses shadows across selection, orbit, and pan changes, but refreshes after geometry changes', () => {
    const { internal } = controllerFixture();
    const object = createDefaultGraph();
    const light = createDirectionalLight();
    internal.maxFragmentTextureUnits = 16;
    const pointA = createPointLight(), pointB = createPointLight();
    pointA.castShadows = pointB.castShadows = true;
    internal.latestSnapshot = createRendererSceneSnapshot({
      scene: defaultSceneSettings(), render: defaultRenderSettings(), objects: [object, light, pointA, pointB],
      selectedId: null, plotJobs: {},
    }, null);
    internal.renderPrograms = {};
    const stubs: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of [
      'ensureRenderTargets', 'ensureEnvironmentCubemap', 'ensureProbeResources', 'pruneProbePool',
      'ensureShadowResources', 'renderDirectionalShadowMaps', 'renderPointShadowMaps',
      'renderPlanarReflection', 'renderOpaqueScene', 'renderTransparentScene', 'renderSceneAxes',
      'renderAxisLabels', 'renderBloom', 'compositeScene', 'renderTransparentContourOverlays',
      'renderSelectionMask', 'renderSelectionOutline', 'renderSelectedFeatureEdges',
      'renderOverlayLines', 'renderDirectionalLightGizmos', 'syncRenderDiagnostics',
    ]) {
      stubs[name] = vi.fn();
      (internal as unknown as Record<string, unknown>)[name] = stubs[name];
    }
    internal.renderScene();
    internal.latestSnapshot.selectedId = object.id;
    internal.camera.alpha += 0.5;
    internal.renderScene();
    expect(stubs.renderDirectionalShadowMaps).toHaveBeenCalledTimes(1);
    expect(stubs.renderSelectionOutline).toHaveBeenCalledTimes(2);
    internal.camera.target[0] += 1;
    internal.renderScene();
    expect(stubs.renderDirectionalShadowMaps).toHaveBeenCalledTimes(1);
    internal.latestSnapshot.plots[0].meshVersion += 1;
    internal.renderScene();
    expect(stubs.renderDirectionalShadowMaps).toHaveBeenCalledTimes(2);
    object.material.roughness = 0.83;
    internal.renderScene();
    expect(stubs.renderDirectionalShadowMaps).toHaveBeenCalledTimes(2);
    const pointCalls = stubs.renderPointShadowMaps.mock.calls.length;
    pointA.position.x += 1;
    internal.renderScene();
    expect(stubs.renderPointShadowMaps).toHaveBeenCalledTimes(pointCalls + 1);
    expect(stubs.renderPointShadowMaps.mock.lastCall?.[1][0].light.id).toBe(pointA.id);
    expect(stubs.renderDirectionalShadowMaps).toHaveBeenCalledTimes(2);
    object.castShadows = false;
    internal.renderScene();
    expect(stubs.renderDirectionalShadowMaps).toHaveBeenCalledTimes(3);
    object.transform.position.x += 4;
    internal.renderScene();
    expect(stubs.renderDirectionalShadowMaps).toHaveBeenCalledTimes(4);
  });

  it('excludes powered-off lights from lighting while preserving their visible handles', () => {
    const { internal } = controllerFixture();
    const point = createPointLight();
    const directional = createDirectionalLight();
    point.enabled = false;
    directional.enabled = false;
    const snapshot = createRendererSceneSnapshot({
      scene: defaultSceneSettings(), render: defaultRenderSettings(), objects: [point, directional],
      selectedId: null, plotJobs: {},
    }, null);
    const lightMethods = internal as unknown as {
      collectRenderablePointLights: (snapshot: RendererSceneSnapshot) => unknown[];
      collectRenderableDirectionalLights: (snapshot: RendererSceneSnapshot) => unknown[];
    };
    expect(lightMethods.collectRenderablePointLights(snapshot)).toEqual([]);
    expect(lightMethods.collectRenderableDirectionalLights(snapshot)).toEqual([]);
    expect(snapshot.pointLights[0].light.visible).toBe(true);
    expect(snapshot.directionalLights[0].light.visible).toBe(true);
  });

  it('round-trips camera framing through saved scene state and restores default framing', () => {
    const { internal } = controllerFixture();
    const originalScene = useAppStore.getState().scene;
    const camera: CameraState = {
      alpha: 0.6, beta: 1.2, radius: 14,
      target: { x: 4, y: -2, z: 3 }, upVector: { x: 0, y: 0, z: 1 },
    };
    try {
      internal.restoreCamera(camera);
      internal.persistCamera();
      expect(useAppStore.getState().scene.camera).toEqual(camera);
      internal.restoreCamera(undefined);
      expect(internal.camera.radius).toBe(20);
      expect(Array.from(internal.camera.target)).toEqual([0, 0, 1.5]);
    } finally {
      useAppStore.setState({ scene: originalScene });
    }
  });

  it.each(['New', 'Open legacy project'] as const)('%s resets a running turntable without dirtying the fresh project', (action) => {
    const { internal } = controllerFixture();
    const originalState = useAppStore.getState();
    vi.useFakeTimers();
    try {
      for (const name of ['syncBackground', 'syncPointLights', 'syncPlots', 'resizeViewport', 'requestRender']) {
        (internal as unknown as Record<string, unknown>)[name] = vi.fn();
      }
      useAppStore.getState().newProject();
      useAppStore.getState().updateScene({ turntableEnabled: true });
      internal.sync(useAppStore.getState());
      internal.updateTurntableCamera(100);
      const rotatedAlpha = internal.camera.alpha;
      expect(internal.turntableTarget).not.toBeNull();
      expect(rotatedAlpha).not.toBe(defaultSceneSettings().camera?.alpha);
      internal.cameraSaveTimer = setTimeout(() => internal.persistCamera(), 150);

      if (action === 'New') {
        useAppStore.getState().newProject();
      } else {
        const project = useAppStore.getState().exportProjectFile();
        useAppStore.getState().replaceProject({
          ...project, scene: { ...defaultSceneSettings(), camera: undefined },
        });
      }
      const freshlyLoaded = useAppStore.getState();
      expect(freshlyLoaded.scene.camera).toEqual(defaultSceneSettings().camera);
      internal.sync(freshlyLoaded);
      internal.updateTurntableCamera(16);
      vi.advanceTimersByTime(200);
      expect(internal.camera.alpha).toBe(defaultSceneSettings().camera?.alpha);
      expect(internal.turntableTarget).toBeNull();
      // No stale turntable stop or delayed wheel handler can write into the new scene.
      expect(useAppStore.getState()).toBe(freshlyLoaded);
    } finally {
      vi.useRealTimers();
      useAppStore.setState(originalState, true);
    }
  });

});

describe('PNG export quality', () => {
  it('raises shadow and reflection detail independently of preview quality', () => {
    const standard = resolvePngExportBudget(1, 1024, true, 0, false);
    const high = resolvePngExportBudget(2, 1024, true, 0, false);
    expect(standard.maxShadowSize).toBe(2048);
    expect(high.maxShadowSize).toBe(4096);
    expect(high.probeSize).toBeGreaterThan(standard.probeSize);
    expect(high.planarScale).toBe(1);
    expect(resolvePngExportBudget(1, 4096, true, 0, false).maxShadowSize).toBe(4096);
  });

  it('bounds shadow memory for point lights and transparent casters, and respects hardware limits', () => {
    for (const pointCount of [0, 1, 2, 3]) {
      for (const transparent of [false, true]) {
        const budget = resolvePngExportBudget(4, 4096, true, pointCount, transparent);
        const bytes = budget.maxShadowSize ** 2 * 4 * (1 + pointCount * 6) * (transparent ? 3 : 1);
        expect(bytes).toBeLessThanOrEqual(256 * 1024 * 1024);
        expect(budget.maxShadowSize).toBeGreaterThanOrEqual(1024);
      }
    }
    expect(resolvePngExportBudget(4, 4096, true, 0, false, 1024).maxShadowSize).toBe(1024);
    expect(resolvePngExportBudget(4, 1536, true, 1, true).maxShadowSize).toBe(1536);
  });

  it.each([1, 4])('restores preview dimensions and quality if a %sx export render fails', async (scale) => {
    const { internal, controller, canvas } = controllerFixture();
    canvas.width = 200;
    canvas.height = 100;
    internal.latestSnapshot = createRendererSceneSnapshot({
      scene: defaultSceneSettings(), render: defaultRenderSettings(), objects: [createDirectionalLight()],
      selectedId: null, plotJobs: {},
    }, null);
    vi.spyOn(controller, 'resizeViewport').mockImplementation(() => {});
    const budgets: Array<RenderBudget | null> = [];
    internal.renderScene = vi.fn(() => {
      budgets.push(internal.pngExportBudget);
      if (internal.pngExportBudget) throw new Error('capture failed');
    });
    await expect(controller.getApi().exportPng('test.png', scale)).rejects.toThrow('capture failed');
    expect(budgets).toHaveLength(2);
    expect(budgets[0]?.probeSize).toBeGreaterThan(128);
    expect(budgets[1]).toBeNull();
    expect([canvas.width, canvas.height]).toEqual([200, 100]);
    expect(internal.pngExportBudget).toBeNull();
    expect(internal.latestSnapshot.render.interactiveQuality).toBe('balanced');
  });
});


describe('capture memory and optional effects', () => {
  it('keeps small 4x exports and reduces oversized captures using the active effects', () => {
    const effects = { hdr: true, bloom: true, refraction: true, selection: true, mirror: true };
    expect(resolvePngExportScale(300, 200, 4, 8192, effects)).toBe(4);
    const heavy = resolvePngExportScale(3840, 2160, 4, 8192, effects);
    const simple = resolvePngExportScale(3840, 2160, 4, 8192, { hdr: false, bloom: false, refraction: false, selection: false, mirror: false });
    expect(heavy).toBeLessThan(simple);
    expect(3840 * heavy).toBeLessThan(8192);
    expect(resolvePngExportScale(10000, 10000, 1, 8192, effects)).toBeLessThan(1);
  });

  it('allocates and releases refraction, bloom and selection independently', () => {
    const { gl, controller, internal } = controllerFixture();
    const object = createDefaultGraph();
    object.material.refractionEnabled = false;
    internal.latestSnapshot = createRendererSceneSnapshot({
      scene: defaultSceneSettings(), render: { ...defaultRenderSettings(), bloomEnabled: false },
      objects: [object], selectedId: null, plotJobs: {},
    }, null);
    const target = controller as unknown as {
      renderTargets: { width: number; height: number; sceneColor: unknown; refractionTexture: unknown; bloomTextureA: unknown; maskTexture: unknown };
      ensureOptionalRenderTargets: () => void;
    };
    target.renderTargets.width = 100; target.renderTargets.height = 100;
    const sceneColor = target.renderTargets.sceneColor = {};
    target.ensureOptionalRenderTargets(); expect(gl.createTexture).not.toHaveBeenCalled();
    object.material.refractionEnabled = true; object.material.opacity = 0.5;
    target.ensureOptionalRenderTargets(); expect(target.renderTargets.refractionTexture).not.toBeNull();
    expect(gl.createTexture).toHaveBeenCalledTimes(1);
    internal.latestSnapshot.render.bloomEnabled = true;
    internal.latestSnapshot.selectedId = object.id;
    target.ensureOptionalRenderTargets(); expect(gl.createTexture).toHaveBeenCalledTimes(5);
    target.ensureOptionalRenderTargets(); expect(gl.createTexture).toHaveBeenCalledTimes(5);
    object.material.refractionEnabled = false;
    internal.latestSnapshot.render.bloomEnabled = false; internal.latestSnapshot.selectedId = null;
    target.ensureOptionalRenderTargets(); expect(gl.deleteTexture).toHaveBeenCalledTimes(5);
    expect(target.renderTargets.sceneColor).toBe(sceneColor);
  });
});


it('retains mesh handles and capacity across animation updates and topology changes', () => {
  const { gl, controller } = controllerFixture();
  const internal = controller as unknown as {
    createPlotBuffers: (mesh: PlotGeometry) => { indexCount: number };
    updatePlotBuffers: (buffers: { indexCount: number }, mesh: PlotGeometry) => unknown;
    disposePlotBuffers: (buffers: { indexCount: number }) => void;
  };
  const mesh: PlotGeometry = {
    positions: new Float32Array([0,0,0, 1,0,0, 0,1,0]),
    normals: new Float32Array([0,0,1, 0,0,1, 0,0,1]), indices: new Uint32Array([0,1,2]),
    bounds: { min: {x:0,y:0,z:0}, max: {x:1,y:1,z:0}, center: {x:0.5,y:0.5,z:0}, radius: 1 },
    boundaryEdges: new Float32Array(), featureEdges: new Float32Array(), wireLines: [], curvePath: null,
    topology: { isClosedManifold: false, hasBoundaryEdges: true, hasFeatureEdges: false, boundaryEdgeCount: 3, featureEdgeCount: 0 },
  };
  const buffers = internal.createPlotBuffers(mesh);
  expect(gl.createBuffer).toHaveBeenCalledTimes(3);
  expect(gl.bufferData).toHaveBeenCalledTimes(3);
  const moved = { ...mesh, positions: new Float32Array([0,0,1, 1,0,1, 0,1,1]) };
  expect(internal.updatePlotBuffers(buffers, moved)).toBe(buffers);
  expect(gl.bufferSubData).toHaveBeenCalledTimes(3);
  expect(gl.bufferData).toHaveBeenCalledTimes(3);
  internal.updatePlotBuffers(buffers, { ...moved, indices: new Uint32Array([2,1,0, 0,1,2]) });
  expect(buffers.indexCount).toBe(6);
  expect(gl.bufferData).toHaveBeenCalledTimes(4);
  expect(gl.createBuffer).toHaveBeenCalledTimes(3);
  internal.disposePlotBuffers(buffers);
  expect(gl.deleteBuffer).toHaveBeenCalledTimes(3);
});
