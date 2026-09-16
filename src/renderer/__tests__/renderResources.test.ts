import { afterEach, describe, expect, it, vi } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { SceneController } from '../SceneController';
import { resolveInteractiveRenderBudget, resolveShadowUpVector } from '../renderBudget';
import { createRendererSceneSnapshot, type RendererSceneSnapshot } from '../renderSnapshot';
import { createDefaultGraph, createDirectionalLight, createPointLight, defaultRenderSettings, defaultSceneSettings } from '../../state/defaults';
import type { CameraState } from '../../types/contracts';
import type { AppState } from '../../state/store';
import { useAppStore } from '../../state/store';

function mockGl() {
  let id = 0;
  return {
    FRAMEBUFFER_COMPLETE: 1,
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
    drawBuffers: vi.fn(),
    readBuffer: vi.fn(),
  };
}

type ControllerInternals = {
  gl: WebGL2RenderingContext;
  renderPrograms: object;
  latestSnapshot: RendererSceneSnapshot;
  pendingProbeRefresh: boolean;
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
  const controller = new SceneController(document.createElement('canvas'));
  const internal = controller as unknown as ControllerInternals;
  internal.gl = gl as unknown as WebGL2RenderingContext;
  return { gl, internal };
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
  it('reuses shadows across selection and orbit changes, but refreshes after panning or remeshing', () => {
    const { internal } = controllerFixture();
    const object = createDefaultGraph();
    const light = createDirectionalLight();
    internal.latestSnapshot = createRendererSceneSnapshot({
      scene: defaultSceneSettings(), render: defaultRenderSettings(), objects: [object, light],
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
    expect(stubs.renderDirectionalShadowMaps).toHaveBeenCalledTimes(2);
    internal.latestSnapshot.plots[0].meshVersion += 1;
    internal.renderScene();
    expect(stubs.renderDirectionalShadowMaps).toHaveBeenCalledTimes(3);
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
