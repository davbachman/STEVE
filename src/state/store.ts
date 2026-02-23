import { create } from 'zustand';
import { produce } from 'immer';
import { v4 as uuidv4 } from 'uuid';
import type {
  EquationSpec,
  HistorySnapshot,
  PlotObject,
  ProjectFileV1,
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

interface AppStateShape {
  scene: SceneSettings;
  render: RenderSettings;
  objects: SceneObject[];
  selectedId: UUID | null;
  clipboardObject: SceneObject | null;
  ui: {
    inspectorTab: 'object' | 'material' | 'lighting' | 'scene' | 'render';
    statusMessage: string | null;
    qualityModeImplemented: boolean;
  };
  historyPast: HistorySnapshot[];
  historyFuture: HistorySnapshot[];
}

interface AppActions {
  setInspectorTab: (tab: AppState['ui']['inspectorTab']) => void;
  selectObject: (id: UUID | null) => void;
  setStatusMessage: (message: string | null) => void;
  addPlot: (template?: 'explicit' | 'curve' | 'surface' | 'implicit') => void;
  addPointLight: () => void;
  updatePlotEquationText: (id: UUID, rawText: string) => void;
  setPlotClassificationOverride: (id: UUID, kind: EquationSpec['kind']) => void;
  updatePlotSpec: (id: UUID, updater: (spec: EquationSpec) => EquationSpec) => void;
  updatePlotMaterial: (id: UUID, patch: Partial<PlotObject['material']>) => void;
  applyMaterialPreset: (id: UUID, presetName: string) => void;
  updateScene: (patch: Partial<SceneSettings>) => void;
  updateSceneNested: <K extends keyof SceneSettings>(key: K, value: SceneSettings[K]) => void;
  updateRender: (patch: Partial<RenderSettings>) => void;
  moveSelectedByDeltaXY: (dx: number, dy: number) => void;
  moveSelectedByDeltaZ: (dz: number) => void;
  setObjectPosition: (id: UUID, pos: { x: number; y: number; z: number }) => void;
  deleteSelected: () => void;
  duplicateSelected: () => void;
  copySelectedToClipboard: () => Promise<void>;
  pasteClipboard: () => Promise<void>;
  newProject: () => void;
  replaceProject: (project: ProjectFileV1) => void;
  exportProjectFile: () => ProjectFileV1;
  undo: () => void;
  redo: () => void;
  markQualityProgress: (samples: number, running: boolean) => void;
}

export type AppState = AppStateShape & AppActions;

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
      qualityModeImplemented: false,
    },
    historyPast: [],
    historyFuture: [],
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
      quality: 'draft',
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
      quality: existing.kind === 'implicit_surface' ? existing.quality : 'draft',
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

function normalizeImportedProject(project: ProjectFileV1): ProjectFileV1 {
  if (project.schemaVersion !== 1) {
    throw new Error(`Unsupported schema version ${project.schemaVersion}`);
  }
  return {
    schemaVersion: 1,
    appVersion: project.appVersion ?? APP_VERSION,
    scene: { ...defaultSceneSettings(), ...project.scene },
    render: { ...defaultRenderSettings(), ...project.render, qualityCurrentSamples: 0, qualityRunning: false },
    objects: project.objects ?? [],
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

  setPlotClassificationOverride: (id, kind) =>
    set((state) => {
      const idx = state.objects.findIndex((obj) => obj.id === id && obj.type === 'plot');
      if (idx === -1) return state;
      const plot = state.objects[idx] as PlotObject;
      const rawText = plot.equation.source.rawText;
      const next = produce(state, (draft) => {
        const draftPlot = draft.objects[idx] as PlotObject;
        draftPlot.equation = coerceEquationSpec(draftPlot.equation, rawText, kind);
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

  updateScene: (patch) =>
    set((state) => ({
      ...state,
      scene: { ...state.scene, ...patch },
      historyPast: [...state.historyPast, snapshotOf(state)],
      historyFuture: [],
    })),

  updateSceneNested: (key, value) =>
    set((state) => ({
      ...state,
      scene: { ...state.scene, [key]: value },
      historyPast: [...state.historyPast, snapshotOf(state)],
      historyFuture: [],
    })),

  updateRender: (patch) =>
    set((state) => ({
      ...state,
      render: { ...state.render, ...patch },
      historyPast: [...state.historyPast, snapshotOf(state)],
      historyFuture: [],
    })),

  moveSelectedByDeltaXY: (dx, dy) =>
    set((state) => moveSelected(state, { dx, dy, dz: 0 })),

  moveSelectedByDeltaZ: (dz) =>
    set((state) => moveSelected(state, { dx: 0, dy: 0, dz })),

  setObjectPosition: (id, pos) =>
    set((state) => {
      const idx = state.objects.findIndex((obj) => obj.id === id);
      if (idx === -1) return state;
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

  duplicateSelected: () =>
    set((state) => {
      const selected = state.objects.find((obj) => obj.id === state.selectedId);
      if (!selected) return state;
      const cloned = cloneWithNewId(selected);
      return {
        ...state,
        objects: [...state.objects, cloned],
        selectedId: cloned.id,
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
      scene: normalized.scene,
      render: normalized.render,
      objects: normalized.objects,
      selectedId: null,
      historyPast: [],
      historyFuture: [],
      ui: { ...state.ui, statusMessage: 'Project loaded' },
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
}));

function moveSelected(state: AppState, delta: { dx: number; dy: number; dz: number }): AppState {
  if (!state.selectedId) return state;
  const idx = state.objects.findIndex((obj) => obj.id === state.selectedId);
  if (idx === -1) return state;
  return produce(state, (draft) => {
    const obj = draft.objects[idx];
    if (obj.type === 'plot') {
      obj.transform.position.x += delta.dx;
      obj.transform.position.y += delta.dy;
      obj.transform.position.z += delta.dz;
    } else {
      obj.position.x += delta.dx;
      obj.position.y += delta.dy;
      obj.position.z += delta.dz;
    }
  });
}

function countPlots(objects: SceneObject[]): number {
  return objects.filter((obj) => obj.type === 'plot').length;
}

function countLights(objects: SceneObject[]): number {
  return objects.filter((obj) => obj.type === 'point_light').length;
}
