import { create } from 'zustand';
import { produce } from 'immer';
import { v4 as uuidv4 } from 'uuid';
import type {
  EquationSpec,
  HistorySnapshot,
  PlotObject,
  PointLightObject,
  PlotJobStatus,
  ProjectFileV1,
  RenderDiagnostics,
  SceneObject,
  SceneSettings,
  RenderSettings,
  UUID,
} from '../types/contracts';
import { analyzeEquationText } from '../math/classifier';
import {
  APP_VERSION,
  createBlankPlot,
  createDefaultCurve,
  createDefaultImplicit,
  createDefaultObjects,
  createDefaultSurface,
  createPointLight,
  defaultBounds,
  defaultRenderSettings,
  defaultSceneSettings,
  materialPresets,
} from './defaults';
import { coerceRenderSettingsForInteractiveOnly, LEGACY_QUALITY_MODE_PARKED_MESSAGE } from './renderCompat';

interface AppStateShape {
  scene: SceneSettings;
  render: RenderSettings;
  objects: SceneObject[];
  selectedId: UUID | null;
  clipboardObject: SceneObject | null;
  ui: {
    inspectorTab: 'object' | 'material' | 'lighting' | 'scene' | 'render';
    statusMessage: string | null;
  };
  renderDiagnostics: RenderDiagnostics;
  plotJobs: Record<UUID, PlotJobStatus>;
  historyPast: HistorySnapshot[];
  historyFuture: HistorySnapshot[];
  activeObjectDragHistory: {
    objectId: UUID;
    startPosition: { x: number; y: number; z: number };
    before: HistorySnapshot;
  } | null;
}

interface AppActions {
  setInspectorTab: (tab: AppState['ui']['inspectorTab']) => void;
  selectObject: (id: UUID | null) => void;
  setStatusMessage: (message: string | null) => void;
  addPlot: (template?: 'explicit' | 'curve' | 'surface' | 'implicit') => void;
  addPointLight: () => void;
  updatePlotEquationText: (id: UUID, rawText: string) => void;
  updatePlotSpec: (id: UUID, updater: (spec: EquationSpec) => EquationSpec) => void;
  updatePlotMaterial: (id: UUID, patch: Partial<PlotObject['material']>) => void;
  applyMaterialPreset: (id: UUID, presetName: string) => void;
  updatePointLight: (id: UUID, patch: Partial<PointLightObject>) => void;
  updateScene: (patch: Partial<SceneSettings>) => void;
  updateRender: (patch: Partial<RenderSettings>) => void;
  setObjectName: (id: UUID, name: string) => void;
  setObjectVisibility: (id: UUID, visible: boolean) => void;
  setObjectPosition: (id: UUID, pos: { x: number; y: number; z: number }) => void;
  beginObjectDragHistory: (id: UUID) => void;
  commitObjectDragHistory: (id: UUID) => void;
  cancelObjectDragHistory: () => void;
  deleteSelected: () => void;
  copySelectedToClipboard: () => Promise<void>;
  pasteClipboard: () => Promise<void>;
  newProject: () => void;
  replaceProject: (project: ProjectFileV1) => void;
  exportProjectFile: () => ProjectFileV1;
  undo: () => void;
  redo: () => void;
  markQualityProgress: (samples: number, running: boolean) => void;
  setRenderDiagnostics: (diagnostics: Partial<RenderDiagnostics>) => void;
  upsertPlotJobStatus: (id: UUID, patch: Partial<PlotJobStatus>) => void;
  resetPlotJobStatus: (id: UUID) => void;
  clearPlotJobStatus: (id: UUID) => void;
  bumpPlotMeshVersion: (id: UUID, meta?: { hasPreview?: boolean; buildMs?: number; phase?: PlotJobStatus['meshPhase']; progress?: number; message?: string }) => void;
  setPlotJobError: (id: UUID, message: string) => void;
  applyAsyncPlotSource: (id: UUID, rawText: string, source: PlotObject['equation']['source']) => void;
}

export type AppState = AppStateShape & AppActions;

function defaultRenderDiagnostics(): RenderDiagnostics {
  return {
    webgpuReady: false,
    plotCount: 0,
    pointLightCount: 0,
    directionalShadowEnabled: false,
    directionalShadowCasterCount: 0,
    pointShadowsEnabled: 0,
    pointShadowLimit: 0,
    pointShadowCasterCounts: {},
    shadowReceiver: 'none',
    transparentPlotCount: 0,
    shadowMapResolution: 0,
    pointShadowMode: 'off',
    pointShadowCapability: 'unknown',
    interactiveReflectionPath: 'none',
    interactiveReflectionSource: 'none',
    interactiveReflectionFallbackReason: null,
    interactiveReflectionProbeSize: 0,
    interactiveReflectionProbeRefreshCount: 0,
    interactiveReflectionLastRefreshReason: null,
    interactiveReflectionProbeHasCapture: false,
    interactiveReflectionProbeUsable: false,
    interactiveReflectionProbeTextureReady: false,
    interactiveReflectionProbeTextureAllocated: false,
    interactiveReflectionFallbackKind: 'none',
    interactiveReflectionFallbackEverUsable: false,
    interactiveReflectionFallbackTexturePresent: false,
    interactiveReflectionFallbackTextureReady: false,
    interactiveReflectionFallbackTextureUsable: false,
    qualityActiveRenderer: 'none',
    qualityRendererFallbackReason: null,
    qualityResolutionScale: 1,
    qualitySamplesPerSecond: 0,
    qualityLastResetReason: null,
    qualityPathExecutionMode: null,
    qualityPathAlignmentStatus: null,
    qualityPathAlignmentProbeCount: 0,
    qualityPathAlignmentHitMismatches: 0,
    qualityPathAlignmentMaxPointError: 0,
    qualityPathAlignmentMaxDistanceError: 0,
    qualityPathWorkerBatchCount: 0,
    qualityPathWorkerPixelCount: 0,
    qualityPathWorkerBatchLatencyMs: 0,
    qualityPathWorkerBatchPixelsPerBatch: 0,
    qualityPathWorkerPixelsPerSecond: 0,
    qualityPathMainThreadBatchCount: 0,
    qualityPathMainThreadPixelCount: 0,
    qualityPathMainThreadPixelsPerSecond: 0,
  };
}

function defaultPlotJobStatus(): PlotJobStatus {
  return {
    parsePhase: 'idle',
    meshPhase: 'idle',
    progress: 0,
    hasPreview: false,
    meshVersion: 0,
  };
}

function initialState(): AppStateShape {
  return {
    scene: defaultSceneSettings(),
    render: defaultRenderSettings(),
    objects: createDefaultObjects(),
    selectedId: null,
    clipboardObject: null,
    ui: {
      inspectorTab: 'object',
      statusMessage: null,
    },
    renderDiagnostics: defaultRenderDiagnostics(),
    plotJobs: {},
    historyPast: [],
    historyFuture: [],
    activeObjectDragHistory: null,
  };
}

function snapshotOf(state: AppStateShape): HistorySnapshot {
  return {
    scene: structuredClone(state.scene),
    render: structuredClone(state.render),
    objects: structuredClone(state.objects),
    selectedId: state.selectedId,
  };
}

function applySnapshot(state: AppStateShape, snapshot: HistorySnapshot): AppStateShape {
  return {
    ...state,
    scene: structuredClone(snapshot.scene),
    render: structuredClone(snapshot.render),
    objects: structuredClone(snapshot.objects),
    selectedId: snapshot.selectedId,
  };
}

function makeExplicitSpec(rawText: string): EquationSpec {
  const analyzed = analyzeEquationText(rawText);
  const source = analyzed.source;
  const domain = { uMin: -4, uMax: 4, vMin: -4, vMax: 4, uSamples: 80, vSamples: 80 };
  if (analyzed.inferredKind === 'parametric_curve') {
    return {
      kind: 'parametric_curve',
      source,
      tDomain: { min: -8, max: 8, samples: 200 },
      tubeRadius: 0.05,
      renderAsTube: true,
    };
  }
  if (analyzed.inferredKind === 'parametric_surface') {
    return {
      kind: 'parametric_surface',
      source,
      domain,
    };
  }
  if (analyzed.inferredKind === 'explicit_surface') {
    return {
      kind: 'explicit_surface',
      source,
      solvedAxis: analyzed.explicitAxis ?? 'z',
      domainAxes: analyzed.explicitDomainAxes ?? ['x', 'y'],
      domain,
      compileAsParametric: true,
    };
  }
  if (analyzed.inferredKind === 'implicit_surface') {
    return {
      kind: 'implicit_surface',
      source,
      bounds: structuredClone(defaultBounds),
      isoValue: 0,
      quality: 'high',
    };
  }
  return {
    kind: 'explicit_surface',
    source,
    solvedAxis: 'z',
    domainAxes: ['x', 'y'],
    domain,
    compileAsParametric: true,
  };
}

function coerceEquationSpec(existing: EquationSpec, rawText: string, forcedKind?: EquationSpec['kind']): EquationSpec {
  const analyzed = analyzeEquationText(rawText);
  const inferred = forcedKind ?? analyzed.inferredKind;
  const source = analyzed.source;

  const keepSurfaceDomain = (spec: EquationSpec) =>
    spec.kind === 'parametric_surface' || spec.kind === 'explicit_surface' ? spec.domain : undefined;

  if (inferred === 'parametric_curve') {
    return {
      kind: 'parametric_curve',
      source,
      tDomain: existing.kind === 'parametric_curve' ? existing.tDomain : { min: -8, max: 8, samples: 200 },
      tubeRadius: existing.kind === 'parametric_curve' ? existing.tubeRadius : 0.05,
      renderAsTube: existing.kind === 'parametric_curve' ? existing.renderAsTube : true,
    };
  }

  if (inferred === 'parametric_surface') {
    return {
      kind: 'parametric_surface',
      source,
      domain: keepSurfaceDomain(existing) ?? { uMin: -4, uMax: 4, vMin: -4, vMax: 4, uSamples: 80, vSamples: 80 },
    };
  }

  if (inferred === 'explicit_surface') {
    const priorDomain = keepSurfaceDomain(existing);
    return {
      kind: 'explicit_surface',
      source,
      solvedAxis: analyzed.explicitAxis ?? (existing.kind === 'explicit_surface' ? existing.solvedAxis : 'z'),
      domainAxes: analyzed.explicitDomainAxes ?? (existing.kind === 'explicit_surface' ? existing.domainAxes : ['x', 'y']),
      domain: priorDomain ?? { uMin: -4, uMax: 4, vMin: -4, vMax: 4, uSamples: 80, vSamples: 80 },
      compileAsParametric: true,
    };
  }

  if (inferred === 'implicit_surface') {
    return {
      kind: 'implicit_surface',
      source,
      bounds: existing.kind === 'implicit_surface' ? existing.bounds : structuredClone(defaultBounds),
      isoValue: existing.kind === 'implicit_surface' ? existing.isoValue : 0,
      quality: existing.kind === 'implicit_surface' ? existing.quality : 'high',
    };
  }

  return { ...existing, source };
}

function cloneWithNewId(object: SceneObject): SceneObject {
  const cloned = structuredClone(object) as SceneObject;
  cloned.id = uuidv4();
  cloned.name = `${cloned.name} Copy`;
  if (cloned.type === 'plot') {
    cloned.transform.position.x += 0.4;
    cloned.transform.position.y += 0.4;
  } else {
    cloned.position.x += 0.4;
    cloned.position.y += 0.4;
  }
  return cloned;
}

function maybeWriteClipboard(json: string, plainText?: string): Promise<void> {
  if (!navigator.clipboard) {
    return Promise.resolve();
  }

  if ('ClipboardItem' in window) {
    try {
      const item = new ClipboardItem({
        'application/x-3dplot-sceneobject+json': new Blob([json], { type: 'application/x-3dplot-sceneobject+json' }),
        'text/plain': new Blob([plainText ?? json], { type: 'text/plain' }),
      });
      return navigator.clipboard.write([item]);
    } catch {
      // fallback below
    }
  }

  return navigator.clipboard.writeText(plainText ?? json);
}

async function maybeReadClipboard(): Promise<{ json?: string; text?: string }> {
  if (!navigator.clipboard) {
    return {};
  }

  if ('read' in navigator.clipboard) {
    try {
      const items = await (navigator.clipboard as Clipboard & { read: () => Promise<ClipboardItem[]> }).read();
      for (const item of items) {
        if (item.types.includes('application/x-3dplot-sceneobject+json')) {
          const blob = await item.getType('application/x-3dplot-sceneobject+json');
          return { json: await blob.text() };
        }
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          return { text: await blob.text() };
        }
      }
    } catch {
      // fallback below
    }
  }

  try {
    return { text: await navigator.clipboard.readText() };
  } catch {
    return {};
  }
}

function asProjectFile(state: AppStateShape): ProjectFileV1 {
  return {
    schemaVersion: 1,
    appVersion: APP_VERSION,
    scene: structuredClone(state.scene),
    render: structuredClone(state.render),
    objects: structuredClone(state.objects),
  };
}

function normalizeImportedProject(project: ProjectFileV1): {
  project: ProjectFileV1;
  coercedLegacyQualityMode: boolean;
  inferredLegacySchemaVersion: boolean;
  skippedInvalidObjects: number;
} {
  const projectRecord = asRecord(project);
  if (!projectRecord) {
    throw new Error('Invalid project file: expected object');
  }
  const rawSchemaVersion = projectRecord.schemaVersion;
  const inferredLegacySchemaVersion = rawSchemaVersion == null;
  const schemaVersion = inferredLegacySchemaVersion ? 1 : rawSchemaVersion;
  if (schemaVersion !== 1) {
    throw new Error(`Unsupported schema version ${String(projectRecord.schemaVersion)}`);
  }
  const sceneInput = asRecord(projectRecord.scene) ?? {};
  const renderInput = asRecord(projectRecord.render) ?? {};
  const ambientInput = asRecord(sceneInput.ambient) ?? {};
  const directionalInput = asRecord(sceneInput.directional) ?? {};
  const shadowInput = asRecord(sceneInput.shadow) ?? {};
  const sceneDefaults = defaultSceneSettings();
  const renderDefaults = defaultRenderSettings();
  const mergedRender: RenderSettings = {
    ...renderDefaults,
    ...(renderInput as Partial<RenderSettings>),
    qualityCurrentSamples: 0,
    qualityRunning: false,
    showDiagnostics: (renderInput as Partial<RenderSettings>).showDiagnostics ?? renderDefaults.showDiagnostics,
  };
  const normalizedScene = normalizeSceneSettingsImport(sceneInput, ambientInput, directionalInput, shadowInput, sceneDefaults);
  const normalizedRender = normalizeRenderSettingsImport(mergedRender, renderInput, renderDefaults);
  const renderCompat = coerceRenderSettingsForInteractiveOnly(normalizedRender);
  const objectInputs = Array.isArray(projectRecord.objects) ? projectRecord.objects : [];
  const normalizedObjects = objectInputs
    .map((obj, index) => normalizeSceneObjectImport(obj, index))
    .filter((result): result is { object: SceneObject } => !!result)
    .map((result) => result.object);
  return {
    project: {
      schemaVersion: 1,
      appVersion: typeof projectRecord.appVersion === 'string' ? projectRecord.appVersion : APP_VERSION,
      scene: normalizedScene,
      render: renderCompat.render,
      objects: normalizedObjects,
    },
    coercedLegacyQualityMode: renderCompat.coercedLegacyQualityMode,
    inferredLegacySchemaVersion,
    skippedInvalidObjects: objectInputs.length - normalizedObjects.length,
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  ...initialState(),

  setInspectorTab: (tab) => set((state) => ({ ...state, ui: { ...state.ui, inspectorTab: tab } })),

  selectObject: (id) => set((state) => ({ ...state, selectedId: id })),

  setStatusMessage: (message) =>
    set((state) => {
      if (state.ui.statusMessage === message) {
        return state;
      }
      return { ...state, ui: { ...state.ui, statusMessage: message } };
    }),

  addPlot: (template) =>
    set((state) => {
      const past = [...state.historyPast, snapshotOf(state)];
      const actualPlot =
        template === 'curve'
          ? createDefaultCurve(`Curve ${countPlots(state.objects) + 1}`)
          : template === 'surface'
            ? createDefaultSurface(`Surface ${countPlots(state.objects) + 1}`)
            : template === 'implicit'
              ? createDefaultImplicit(`Implicit ${countPlots(state.objects) + 1}`)
              : createBlankPlot(`Plot ${countPlots(state.objects) + 1}`);
      return {
        ...state,
        objects: [...state.objects, actualPlot],
        selectedId: actualPlot.id,
        historyPast: past,
        historyFuture: [],
      };
    }),

  addPointLight: () =>
    set((state) => {
      const light = createPointLight(`Point Light ${countLights(state.objects) + 1}`);
      return {
        ...state,
        objects: [...state.objects, light],
        selectedId: light.id,
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  updatePlotEquationText: (id, rawText) =>
    set((state) => {
      const idx = state.objects.findIndex((obj) => obj.id === id && obj.type === 'plot');
      if (idx === -1) return state;
      const next = produce(state, (draft) => {
        const plot = draft.objects[idx] as PlotObject;
        plot.equation = coerceEquationSpec(plot.equation, rawText);
      });
      return {
        ...next,
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  updatePlotSpec: (id, updater) =>
    set((state) => {
      const idx = state.objects.findIndex((obj) => obj.id === id && obj.type === 'plot');
      if (idx === -1) return state;
      const next = produce(state, (draft) => {
        const plot = draft.objects[idx] as PlotObject;
        plot.equation = updater(plot.equation);
      });
      return {
        ...next,
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  updatePlotMaterial: (id, patch) =>
    set((state) => {
      const idx = state.objects.findIndex((obj) => obj.id === id && obj.type === 'plot');
      if (idx === -1) return state;
      const next = produce(state, (draft) => {
        const plot = draft.objects[idx] as PlotObject;
        plot.material = { ...plot.material, ...patch };
      });
      return {
        ...next,
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  applyMaterialPreset: (id, presetName) =>
    set((state) => {
      const preset = materialPresets[presetName];
      if (!preset) return state;
      const idx = state.objects.findIndex((obj) => obj.id === id && obj.type === 'plot');
      if (idx === -1) return state;
      const next = produce(state, (draft) => {
        const plot = draft.objects[idx] as PlotObject;
        plot.material = { ...preset };
      });
      return {
        ...next,
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  updatePointLight: (id, patch) =>
    set((state) => {
      const idx = state.objects.findIndex((obj) => obj.id === id && obj.type === 'point_light');
      if (idx === -1) return state;
      const next = produce(state, (draft) => {
        const light = draft.objects[idx] as PointLightObject;
        Object.assign(light, patch);
      });
      return {
        ...next,
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  updateScene: (patch) =>
    set((state) => ({
      ...state,
      scene: { ...state.scene, ...patch },
      historyPast: [...state.historyPast, snapshotOf(state)],
      historyFuture: [],
    })),

  updateRender: (patch) =>
    set((state) => {
      const requestedLegacyQualityMode = patch.mode === 'quality';
      const compat = coerceRenderSettingsForInteractiveOnly({ ...state.render, ...patch });
      return {
        ...state,
        render: compat.render,
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
        ui: requestedLegacyQualityMode && compat.coercedLegacyQualityMode
          ? { ...state.ui, statusMessage: LEGACY_QUALITY_MODE_PARKED_MESSAGE }
          : state.ui,
      };
    }),

  setObjectName: (id, name) =>
    set((state) => {
      const idx = state.objects.findIndex((obj) => obj.id === id);
      if (idx === -1) return state;
      const nextName = name.trim();
      if (!nextName) return state;
      if (state.objects[idx].name === nextName) return state;
      const next = produce(state, (draft) => {
        draft.objects[idx].name = nextName;
      });
      return {
        ...next,
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
        activeObjectDragHistory: null,
      };
    }),

  setObjectVisibility: (id, visible) =>
    set((state) => {
      const idx = state.objects.findIndex((obj) => obj.id === id);
      if (idx === -1) return state;
      if (state.objects[idx].visible === visible) return state;
      const next = produce(state, (draft) => {
        draft.objects[idx].visible = visible;
      });
      return {
        ...next,
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  setObjectPosition: (id, pos) =>
    set((state) => {
      const idx = state.objects.findIndex((obj) => obj.id === id);
      if (idx === -1) return state;
      const currentPos = getObjectPosition(state.objects[idx]);
      if (positionsEqual(currentPos, pos)) return state;
      const next = produce(state, (draft) => {
        const obj = draft.objects[idx];
        if (obj.type === 'plot') {
          obj.transform.position = { ...pos };
        } else {
          obj.position = { ...pos };
        }
      });
      return next;
    }),

  beginObjectDragHistory: (id) =>
    set((state) => {
      const obj = state.objects.find((candidate) => candidate.id === id);
      if (!obj) return state;
      const startPosition = getObjectPosition(obj);
      if (
        state.activeObjectDragHistory &&
        state.activeObjectDragHistory.objectId === id &&
        positionsEqual(state.activeObjectDragHistory.startPosition, startPosition)
      ) {
        return state;
      }
      return {
        ...state,
        activeObjectDragHistory: {
          objectId: id,
          startPosition,
          before: snapshotOf(state),
        },
      };
    }),

  commitObjectDragHistory: (id) =>
    set((state) => {
      const active = state.activeObjectDragHistory;
      if (!active) return state;
      if (active.objectId !== id) {
        return { ...state, activeObjectDragHistory: null };
      }
      const obj = state.objects.find((candidate) => candidate.id === id);
      const currentPosition = obj ? getObjectPosition(obj) : null;
      if (!currentPosition || positionsEqual(active.startPosition, currentPosition)) {
        return { ...state, activeObjectDragHistory: null };
      }
      return {
        ...state,
        activeObjectDragHistory: null,
        historyPast: [...state.historyPast, active.before],
        historyFuture: [],
      };
    }),

  cancelObjectDragHistory: () =>
    set((state) => (state.activeObjectDragHistory ? { ...state, activeObjectDragHistory: null } : state)),

  deleteSelected: () =>
    set((state) => {
      if (!state.selectedId) return state;
      return {
        ...state,
        objects: state.objects.filter((obj) => obj.id !== state.selectedId),
        selectedId: null,
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  copySelectedToClipboard: async () => {
    const state = get();
    const selected = state.objects.find((obj) => obj.id === state.selectedId);
    if (!selected) {
      get().setStatusMessage('Nothing selected to copy');
      return;
    }
    const json = JSON.stringify(selected);
    const plainText = selected.type === 'plot' ? selected.equation.source.rawText : selected.name;
    try {
      await maybeWriteClipboard(json, plainText);
      set((s) => ({ ...s, clipboardObject: structuredClone(selected), ui: { ...s.ui, statusMessage: 'Copied selection' } }));
    } catch {
      set((s) => ({ ...s, clipboardObject: structuredClone(selected), ui: { ...s.ui, statusMessage: 'Copied internally (browser clipboard unavailable)' } }));
    }
  },

  pasteClipboard: async () => {
    const state = get();
    const pasteFromObject = (obj: SceneObject) => {
      const cloned = cloneWithNewId(obj);
      set((s) => ({
        ...s,
        objects: [...s.objects, cloned],
        selectedId: cloned.id,
        historyPast: [...s.historyPast, snapshotOf(s)],
        historyFuture: [],
        ui: { ...s.ui, statusMessage: 'Pasted object' },
      }));
    };

    try {
      const clip = await maybeReadClipboard();
      if (clip.json) {
        pasteFromObject(JSON.parse(clip.json) as SceneObject);
        return;
      }
      if (clip.text) {
        const trimmed = clip.text.trim();
        try {
          const parsed = JSON.parse(trimmed) as SceneObject;
          if (parsed && typeof parsed === 'object' && 'id' in parsed && 'type' in parsed) {
            pasteFromObject(parsed);
            return;
          }
        } catch {
          // use text as equation
        }
        const newPlot = createBlankPlot(`Plot ${countPlots(state.objects) + 1}`);
        newPlot.equation = makeExplicitSpec(trimmed);
        pasteFromObject(newPlot);
        return;
      }
    } catch {
      // ignore and fallback
    }

    if (state.clipboardObject) {
      pasteFromObject(state.clipboardObject);
      return;
    }
    get().setStatusMessage('Clipboard is empty');
  },

  newProject: () => set(() => ({ ...initialState() })),

  replaceProject: (project) => {
    const normalized = normalizeImportedProject(project);
    set((state) => ({
      ...state,
      scene: normalized.project.scene,
      render: normalized.project.render,
      objects: normalized.project.objects,
      selectedId: null,
      renderDiagnostics: defaultRenderDiagnostics(),
      plotJobs: {},
      historyPast: [],
      historyFuture: [],
      activeObjectDragHistory: null,
      ui: {
        ...state.ui,
        statusMessage: buildProjectLoadStatusMessage(normalized),
      },
    }));
  },

  exportProjectFile: () => asProjectFile(get()),

  undo: () =>
    set((state) => {
      if (state.historyPast.length === 0) return state;
      const previous = state.historyPast[state.historyPast.length - 1];
      const base = applySnapshot(state, previous);
      return {
        ...base,
        clipboardObject: state.clipboardObject,
        ui: state.ui,
        historyPast: state.historyPast.slice(0, -1),
        historyFuture: [snapshotOf(state), ...state.historyFuture],
        activeObjectDragHistory: null,
      };
    }),

  redo: () =>
    set((state) => {
      if (state.historyFuture.length === 0) return state;
      const nextSnapshot = state.historyFuture[0];
      const base = applySnapshot(state, nextSnapshot);
      return {
        ...base,
        clipboardObject: state.clipboardObject,
        ui: state.ui,
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: state.historyFuture.slice(1),
        activeObjectDragHistory: null,
      };
    }),

  markQualityProgress: (samples, running) =>
    set((state) => {
      if (state.render.qualityCurrentSamples === samples && state.render.qualityRunning === running) {
        return state;
      }
      return {
        ...state,
        render: { ...state.render, qualityCurrentSamples: samples, qualityRunning: running },
      };
    }),

  setRenderDiagnostics: (diagnostics) =>
    set((state) => {
      const next = { ...state.renderDiagnostics, ...diagnostics };
      if (shallowDiagnosticsEqual(state.renderDiagnostics, next)) {
        return state;
      }
      return {
        ...state,
        renderDiagnostics: next,
      };
    }),

  upsertPlotJobStatus: (id, patch) =>
    set((state) => {
      const current = state.plotJobs[id] ?? defaultPlotJobStatus();
      const next = { ...current, ...patch };
      if (shallowPlotJobEqual(current, next)) {
        return state;
      }
      return {
        ...state,
        plotJobs: { ...state.plotJobs, [id]: next },
      };
    }),

  resetPlotJobStatus: (id) =>
    set((state) => {
      const current = state.plotJobs[id];
      const next = current ? { ...defaultPlotJobStatus(), meshVersion: current.meshVersion } : defaultPlotJobStatus();
      if (current && shallowPlotJobEqual(current, next)) {
        return state;
      }
      return {
        ...state,
        plotJobs: { ...state.plotJobs, [id]: next },
      };
    }),

  clearPlotJobStatus: (id) =>
    set((state) => {
      if (!(id in state.plotJobs)) return state;
      const next = { ...state.plotJobs };
      delete next[id];
      return {
        ...state,
        plotJobs: next,
      };
    }),

  bumpPlotMeshVersion: (id, meta) =>
    set((state) => {
      const current = state.plotJobs[id] ?? defaultPlotJobStatus();
      const next: PlotJobStatus = {
        ...current,
        meshVersion: current.meshVersion + 1,
        meshPhase: meta?.phase ?? 'ready',
        progress: meta?.progress ?? 1,
        hasPreview: meta?.hasPreview ?? current.hasPreview,
        lastMeshBuildMs: meta?.buildMs ?? current.lastMeshBuildMs,
        message: meta?.message,
        lastError: undefined,
      };
      return {
        ...state,
        plotJobs: { ...state.plotJobs, [id]: next },
      };
    }),

  setPlotJobError: (id, message) =>
    set((state) => {
      const current = state.plotJobs[id] ?? defaultPlotJobStatus();
      const next: PlotJobStatus = {
        ...current,
        meshPhase: 'error',
        progress: 0,
        message,
        lastError: message,
      };
      return {
        ...state,
        plotJobs: { ...state.plotJobs, [id]: next },
      };
    }),

  applyAsyncPlotSource: (id, rawText, source) =>
    set((state) => {
      const idx = state.objects.findIndex((obj) => obj.id === id && obj.type === 'plot');
      if (idx === -1) return state;
      const plot = state.objects[idx] as PlotObject;
      if (plot.equation.source.rawText !== rawText) return state;
      const next = produce(state, (draft) => {
        const draftPlot = draft.objects[idx] as PlotObject;
        draftPlot.equation.source = source;
      });
      return next;
    }),
}));

function getObjectPosition(obj: SceneObject): { x: number; y: number; z: number } {
  return obj.type === 'plot' ? { ...obj.transform.position } : { ...obj.position };
}

function positionsEqual(
  a: { x: number; y: number; z: number } | null,
  b: { x: number; y: number; z: number } | null,
): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
}

function buildProjectLoadStatusMessage(normalized: {
  coercedLegacyQualityMode: boolean;
  inferredLegacySchemaVersion: boolean;
  skippedInvalidObjects: number;
}): string {
  if (!normalized.coercedLegacyQualityMode && !normalized.inferredLegacySchemaVersion && normalized.skippedInvalidObjects === 0) {
    return 'Project loaded';
  }
  if (!normalized.inferredLegacySchemaVersion && normalized.skippedInvalidObjects === 0 && normalized.coercedLegacyQualityMode) {
    return LEGACY_QUALITY_MODE_PARKED_MESSAGE;
  }
  const notes: string[] = [];
  if (normalized.coercedLegacyQualityMode) {
    notes.push('legacy quality mode parked');
  }
  if (normalized.inferredLegacySchemaVersion) {
    notes.push('schema version inferred as 1');
  }
  if (normalized.skippedInvalidObjects > 0) {
    notes.push(`skipped ${normalized.skippedInvalidObjects} invalid object${normalized.skippedInvalidObjects === 1 ? '' : 's'}`);
  }
  return notes.length > 0 ? `Project loaded (${notes.join('; ')})` : 'Project loaded';
}

function normalizeSceneSettingsImport(
  sceneInput: Record<string, unknown>,
  ambientInput: Record<string, unknown>,
  directionalInput: Record<string, unknown>,
  shadowInput: Record<string, unknown>,
  defaults: SceneSettings,
): SceneSettings {
  return {
    ...defaults,
    backgroundMode: asEnum(sceneInput.backgroundMode, ['solid', 'gradient']) ?? defaults.backgroundMode,
    backgroundColor: asNonEmptyString(sceneInput.backgroundColor) ?? defaults.backgroundColor,
    gradientTopColor: asNonEmptyString(sceneInput.gradientTopColor) ?? defaults.gradientTopColor,
    gradientBottomColor: asNonEmptyString(sceneInput.gradientBottomColor) ?? defaults.gradientBottomColor,
    groundPlaneVisible: asBoolean(sceneInput.groundPlaneVisible) ?? defaults.groundPlaneVisible,
    groundPlaneSize: asFiniteNumber(sceneInput.groundPlaneSize) ?? defaults.groundPlaneSize,
    groundPlaneColor: asNonEmptyString(sceneInput.groundPlaneColor) ?? defaults.groundPlaneColor,
    groundPlaneRoughness: clampNumber(asFiniteNumber(sceneInput.groundPlaneRoughness) ?? defaults.groundPlaneRoughness, 0, 1),
    groundPlaneReflective: asBoolean(sceneInput.groundPlaneReflective) ?? defaults.groundPlaneReflective,
    gridVisible: asBoolean(sceneInput.gridVisible) ?? defaults.gridVisible,
    gridExtent: asFiniteNumber(sceneInput.gridExtent) ?? defaults.gridExtent,
    gridSpacing: asFiniteNumber(sceneInput.gridSpacing) ?? defaults.gridSpacing,
    gridLineOpacity: clampNumber(asFiniteNumber(sceneInput.gridLineOpacity) ?? defaults.gridLineOpacity, 0, 1),
    axesVisible: asBoolean(sceneInput.axesVisible) ?? defaults.axesVisible,
    axesLength: asFiniteNumber(sceneInput.axesLength) ?? defaults.axesLength,
    defaultGraphBounds: normalizeBounds3D(sceneInput.defaultGraphBounds, defaults.defaultGraphBounds),
    ambient: {
      ...defaults.ambient,
      color: asNonEmptyString(ambientInput.color) ?? defaults.ambient.color,
      intensity: asFiniteNumber(ambientInput.intensity) ?? defaults.ambient.intensity,
    },
    directional: {
      ...defaults.directional,
      direction: normalizeVec3(directionalInput.direction, defaults.directional.direction),
      color: asNonEmptyString(directionalInput.color) ?? defaults.directional.color,
      intensity: asFiniteNumber(directionalInput.intensity) ?? defaults.directional.intensity,
      castShadows: asBoolean(directionalInput.castShadows) ?? defaults.directional.castShadows,
    },
    shadow: {
      ...defaults.shadow,
      directionalShadowEnabled: asBoolean(shadowInput.directionalShadowEnabled) ?? defaults.shadow.directionalShadowEnabled,
      pointShadowMode: asEnum(shadowInput.pointShadowMode, ['off', 'auto', 'on']) ?? defaults.shadow.pointShadowMode,
      pointShadowMaxLights: asFiniteInteger(shadowInput.pointShadowMaxLights) ?? defaults.shadow.pointShadowMaxLights,
      shadowMapResolution: asFiniteInteger(shadowInput.shadowMapResolution) ?? defaults.shadow.shadowMapResolution,
      shadowSoftness: clampNumber(asFiniteNumber(shadowInput.shadowSoftness) ?? defaults.shadow.shadowSoftness, 0, 1),
    },
  };
}

function normalizeRenderSettingsImport(
  mergedRender: RenderSettings,
  renderInput: Record<string, unknown>,
  defaults: RenderSettings,
): RenderSettings {
  return {
    ...mergedRender,
    mode: asEnum(renderInput.mode, ['interactive', 'quality']) ?? mergedRender.mode,
    toneMapping: asEnum(renderInput.toneMapping, ['aces', 'filmic', 'none']) ?? mergedRender.toneMapping,
    interactiveQuality: asEnum(renderInput.interactiveQuality, ['performance', 'balanced', 'quality']) ?? mergedRender.interactiveQuality,
    qualityRenderer: asEnum(renderInput.qualityRenderer, ['taa_preview', 'hybrid_gpu_preview', 'path']) ?? mergedRender.qualityRenderer,
    qualitySamplesTarget: Math.max(1, asFiniteInteger(renderInput.qualitySamplesTarget) ?? mergedRender.qualitySamplesTarget),
    qualityResolutionScale: clampNumber(asFiniteNumber(renderInput.qualityResolutionScale) ?? mergedRender.qualityResolutionScale, 0.1, 2),
    qualityMaxBounces: Math.max(0, asFiniteInteger(renderInput.qualityMaxBounces) ?? mergedRender.qualityMaxBounces),
    qualityClampFireflies: asBoolean(renderInput.qualityClampFireflies) ?? mergedRender.qualityClampFireflies,
    qualityEarlyExportBehavior: asEnum(renderInput.qualityEarlyExportBehavior, ['wait', 'immediate']) ?? mergedRender.qualityEarlyExportBehavior,
    denoise: asBoolean(renderInput.denoise) ?? mergedRender.denoise,
    showDiagnostics: asBoolean(renderInput.showDiagnostics) ?? mergedRender.showDiagnostics ?? defaults.showDiagnostics,
    exposure: asFiniteNumber(renderInput.exposure) ?? mergedRender.exposure,
    qualityRunning: false,
    qualityCurrentSamples: 0,
  };
}

function normalizeSceneObjectImport(input: unknown, index: number): { object: SceneObject } | null {
  const record = asRecord(input);
  if (!record) return null;
  const type = asEnum(record.type, ['plot', 'point_light']);
  if (type === 'plot') {
    return { object: normalizePlotObjectImport(record, index) };
  }
  if (type === 'point_light') {
    return { object: normalizePointLightObjectImport(record, index) };
  }
  return null;
}

function normalizePlotObjectImport(record: Record<string, unknown>, index: number): PlotObject {
  const fallback = createBlankPlot(`Imported Plot ${index + 1}`);
  const transformInput = asRecord(record.transform);
  const materialInput = asRecord(record.material);
  const equationInput = asRecord(record.equation);
  return {
    ...fallback,
    id: asNonEmptyString(record.id) ?? fallback.id,
    name: asNonEmptyString(record.name) ?? fallback.name,
    visible: asBoolean(record.visible) ?? fallback.visible,
    transform: {
      position: normalizeVec3(transformInput?.position, fallback.transform.position),
    },
    material: normalizeMaterialImport(materialInput, fallback.material),
    equation: normalizeEquationSpecImport(equationInput, fallback.equation),
  };
}

function normalizePointLightObjectImport(record: Record<string, unknown>, index: number): PointLightObject {
  const fallback = createPointLight(`Imported Light ${index + 1}`);
  return {
    ...fallback,
    id: asNonEmptyString(record.id) ?? fallback.id,
    name: asNonEmptyString(record.name) ?? fallback.name,
    visible: asBoolean(record.visible) ?? fallback.visible,
    position: normalizeVec3(record.position, fallback.position),
    color: asNonEmptyString(record.color) ?? fallback.color,
    intensity: Math.max(0, asFiniteNumber(record.intensity) ?? fallback.intensity),
    range: Math.max(0, asFiniteNumber(record.range) ?? fallback.range),
    castShadows: asBoolean(record.castShadows) ?? fallback.castShadows,
  };
}

function normalizeMaterialImport(
  materialInput: Record<string, unknown> | null,
  fallback: PlotObject['material'],
): PlotObject['material'] {
  if (!materialInput) return { ...fallback };
  return {
    ...fallback,
    baseColor: asNonEmptyString(materialInput.baseColor) ?? fallback.baseColor,
    opacity: clampNumber(asFiniteNumber(materialInput.opacity) ?? fallback.opacity, 0, 1),
    transmission: clampNumber(asFiniteNumber(materialInput.transmission) ?? fallback.transmission, 0, 1),
    reflectiveness: clampNumber(asFiniteNumber(materialInput.reflectiveness) ?? fallback.reflectiveness, 0, 1),
    roughness: clampNumber(asFiniteNumber(materialInput.roughness) ?? fallback.roughness, 0, 1),
    presetName: asNonEmptyString(materialInput.presetName) ?? fallback.presetName,
    wireframeVisible: asBoolean(materialInput.wireframeVisible) ?? fallback.wireframeVisible,
    wireframeCellSize: positiveFiniteNumber(materialInput.wireframeCellSize) ?? fallback.wireframeCellSize,
  };
}

function normalizeEquationSpecImport(
  equationInput: Record<string, unknown> | null,
  fallback: PlotObject['equation'],
): PlotObject['equation'] {
  if (!equationInput) return structuredClone(fallback);
  const sourceInput = asRecord(equationInput.source);
  const rawText = asNonEmptyString(sourceInput?.rawText) ?? fallback.source.rawText;
  const requestedKind =
    asEnum(equationInput.kind, ['parametric_curve', 'parametric_surface', 'implicit_surface', 'explicit_surface']) ?? undefined;
  const base = coerceEquationSpec(fallback, rawText, requestedKind);

  if (base.kind === 'parametric_curve') {
    const tDomainInput = asRecord(equationInput.tDomain);
    return {
      ...base,
      tDomain: normalizeDomain1D(tDomainInput, base.tDomain),
      tubeRadius: Math.max(0, asFiniteNumber(equationInput.tubeRadius) ?? base.tubeRadius),
      renderAsTube: asBoolean(equationInput.renderAsTube) ?? base.renderAsTube,
    };
  }

  if (base.kind === 'parametric_surface') {
    return {
      ...base,
      domain: normalizeDomain2D(asRecord(equationInput.domain), base.domain),
    };
  }

  if (base.kind === 'explicit_surface') {
    return {
      ...base,
      solvedAxis: asEnum(equationInput.solvedAxis, ['x', 'y', 'z']) ?? base.solvedAxis,
      domainAxes: normalizeExplicitDomainAxes(equationInput.domainAxes, base.domainAxes),
      domain: normalizeDomain2D(asRecord(equationInput.domain), base.domain),
      compileAsParametric: true,
    };
  }

  return {
    ...base,
    bounds: normalizeBounds3D(equationInput.bounds, base.bounds),
    isoValue: asFiniteNumber(equationInput.isoValue) ?? base.isoValue,
    quality: asEnum(equationInput.quality, ['draft', 'medium', 'high']) ?? base.quality,
  };
}

function normalizeDomain1D(
  input: Record<string, unknown> | null,
  fallback: { min: number; max: number; samples: number },
): { min: number; max: number; samples: number } {
  if (!input) return { ...fallback };
  return {
    min: asFiniteNumber(input.min) ?? fallback.min,
    max: asFiniteNumber(input.max) ?? fallback.max,
    samples: Math.max(2, asFiniteInteger(input.samples) ?? fallback.samples),
  };
}

function normalizeDomain2D(
  input: Record<string, unknown> | null,
  fallback: { uMin: number; uMax: number; vMin: number; vMax: number; uSamples: number; vSamples: number },
): { uMin: number; uMax: number; vMin: number; vMax: number; uSamples: number; vSamples: number } {
  if (!input) return { ...fallback };
  return {
    uMin: asFiniteNumber(input.uMin) ?? fallback.uMin,
    uMax: asFiniteNumber(input.uMax) ?? fallback.uMax,
    vMin: asFiniteNumber(input.vMin) ?? fallback.vMin,
    vMax: asFiniteNumber(input.vMax) ?? fallback.vMax,
    uSamples: Math.max(2, asFiniteInteger(input.uSamples) ?? fallback.uSamples),
    vSamples: Math.max(2, asFiniteInteger(input.vSamples) ?? fallback.vSamples),
  };
}

function normalizeBounds3D(
  input: unknown,
  fallback: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } {
  const record = asRecord(input);
  if (!record) {
    return {
      min: { ...fallback.min },
      max: { ...fallback.max },
    };
  }
  return {
    min: normalizeVec3(record.min, fallback.min),
    max: normalizeVec3(record.max, fallback.max),
  };
}

function normalizeVec3(
  input: unknown,
  fallback: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const record = asRecord(input);
  if (!record) return { ...fallback };
  return {
    x: asFiniteNumber(record.x) ?? fallback.x,
    y: asFiniteNumber(record.y) ?? fallback.y,
    z: asFiniteNumber(record.z) ?? fallback.z,
  };
}

function normalizeExplicitDomainAxes(
  value: unknown,
  fallback: ['x' | 'y' | 'z', 'x' | 'y' | 'z'],
): ['x' | 'y' | 'z', 'x' | 'y' | 'z'] {
  if (!Array.isArray(value) || value.length !== 2) return [...fallback];
  const a = asEnum(value[0], ['x', 'y', 'z']);
  const b = asEnum(value[1], ['x', 'y', 'z']);
  if (!a || !b || a === b) return [...fallback];
  return [a, b];
}

function countPlots(objects: SceneObject[]): number {
  return objects.filter((obj) => obj.type === 'plot').length;
}

function countLights(objects: SceneObject[]): number {
  return objects.filter((obj) => obj.type === 'point_light').length;
}

function shallowDiagnosticsEqual(a: RenderDiagnostics, b: RenderDiagnostics): boolean {
  return (
    a.webgpuReady === b.webgpuReady &&
    a.plotCount === b.plotCount &&
    a.pointLightCount === b.pointLightCount &&
    a.directionalShadowEnabled === b.directionalShadowEnabled &&
    a.directionalShadowCasterCount === b.directionalShadowCasterCount &&
    a.pointShadowsEnabled === b.pointShadowsEnabled &&
    a.pointShadowLimit === b.pointShadowLimit &&
    a.shadowReceiver === b.shadowReceiver &&
    a.transparentPlotCount === b.transparentPlotCount &&
    a.shadowMapResolution === b.shadowMapResolution &&
    a.pointShadowMode === b.pointShadowMode &&
    a.pointShadowCapability === b.pointShadowCapability &&
    a.interactiveReflectionPath === b.interactiveReflectionPath &&
    a.interactiveReflectionSource === b.interactiveReflectionSource &&
    a.interactiveReflectionFallbackReason === b.interactiveReflectionFallbackReason &&
    a.interactiveReflectionProbeSize === b.interactiveReflectionProbeSize &&
    a.interactiveReflectionProbeRefreshCount === b.interactiveReflectionProbeRefreshCount &&
    a.interactiveReflectionLastRefreshReason === b.interactiveReflectionLastRefreshReason &&
    a.interactiveReflectionProbeHasCapture === b.interactiveReflectionProbeHasCapture &&
    a.interactiveReflectionProbeUsable === b.interactiveReflectionProbeUsable &&
    a.interactiveReflectionProbeTextureReady === b.interactiveReflectionProbeTextureReady &&
    a.interactiveReflectionProbeTextureAllocated === b.interactiveReflectionProbeTextureAllocated &&
    a.interactiveReflectionFallbackKind === b.interactiveReflectionFallbackKind &&
    a.interactiveReflectionFallbackEverUsable === b.interactiveReflectionFallbackEverUsable &&
    a.interactiveReflectionFallbackTexturePresent === b.interactiveReflectionFallbackTexturePresent &&
    a.interactiveReflectionFallbackTextureReady === b.interactiveReflectionFallbackTextureReady &&
    a.interactiveReflectionFallbackTextureUsable === b.interactiveReflectionFallbackTextureUsable &&
    a.qualityActiveRenderer === b.qualityActiveRenderer &&
    a.qualityRendererFallbackReason === b.qualityRendererFallbackReason &&
    a.qualityResolutionScale === b.qualityResolutionScale &&
    a.qualitySamplesPerSecond === b.qualitySamplesPerSecond &&
    a.qualityLastResetReason === b.qualityLastResetReason &&
    a.qualityPathExecutionMode === b.qualityPathExecutionMode &&
    a.qualityPathAlignmentStatus === b.qualityPathAlignmentStatus &&
    a.qualityPathAlignmentProbeCount === b.qualityPathAlignmentProbeCount &&
    a.qualityPathAlignmentHitMismatches === b.qualityPathAlignmentHitMismatches &&
    a.qualityPathAlignmentMaxPointError === b.qualityPathAlignmentMaxPointError &&
    a.qualityPathAlignmentMaxDistanceError === b.qualityPathAlignmentMaxDistanceError &&
    a.qualityPathWorkerBatchCount === b.qualityPathWorkerBatchCount &&
    a.qualityPathWorkerPixelCount === b.qualityPathWorkerPixelCount &&
    a.qualityPathWorkerBatchLatencyMs === b.qualityPathWorkerBatchLatencyMs &&
    a.qualityPathWorkerBatchPixelsPerBatch === b.qualityPathWorkerBatchPixelsPerBatch &&
    a.qualityPathWorkerPixelsPerSecond === b.qualityPathWorkerPixelsPerSecond &&
    a.qualityPathMainThreadBatchCount === b.qualityPathMainThreadBatchCount &&
    a.qualityPathMainThreadPixelCount === b.qualityPathMainThreadPixelCount &&
    a.qualityPathMainThreadPixelsPerSecond === b.qualityPathMainThreadPixelsPerSecond &&
    shallowPointShadowCasterCountsEqual(a.pointShadowCasterCounts ?? {}, b.pointShadowCasterCounts ?? {})
  );
}

function shallowPointShadowCasterCountsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function shallowPlotJobEqual(a: PlotJobStatus, b: PlotJobStatus): boolean {
  return (
    a.parsePhase === b.parsePhase &&
    a.meshPhase === b.meshPhase &&
    a.progress === b.progress &&
    a.message === b.message &&
    a.hasPreview === b.hasPreview &&
    a.meshVersion === b.meshVersion &&
    a.lastMeshBuildMs === b.lastMeshBuildMs &&
    a.lastError === b.lastError
  );
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveFiniteNumber(value: unknown): number | null {
  const n = asFiniteNumber(value);
  return n !== null && n > 0 ? n : null;
}

function asFiniteInteger(value: unknown): number | null {
  const n = asFiniteNumber(value);
  return n === null ? null : Math.round(n);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (typeof value !== 'string') return null;
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
