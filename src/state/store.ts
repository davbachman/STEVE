import { create } from 'zustand';
import { produce } from 'immer';
import { v4 as uuidv4 } from 'uuid';
import type {
  EquationSpec,
  DirectionalLightObject,
  HistorySnapshot,
  IntersectionObject,
  LightObject,
  PlotObject,
  PointLightObject,
  PlotJobStatus,
  ProjectFileV1,
  RenderDiagnostics,
  RenderableObject,
  SceneObject,
  SceneSettings,
  RenderSettings,
  UUID,
} from '../types/contracts';
import { analyzeEquationText, analyzeGraphExpression } from '../math/classifier';
import {
  clampCurveParameter,
  curveParameterBounds,
  pinnedCurveForLight,
  resolvePinnedLightPosition,
} from '../math/curvePinning';
import { isParametricCurvePlot, isRenderableObject, isSurfacePlot } from '../types/guards';
import {
  DEFAULT_DISCRETE_PARAMETER_COUNT,
  clampAnimationSpeed,
  clampDiscreteParameterCount,
  snapDiscreteParameterValue,
  syncEquationParameters,
} from '../math/parameters';
import {
  APP_VERSION,
  createBlankPlot,
  createDefaultCurve,
  createDefaultGraph,
  createDefaultImplicit,
  createDefaultIntersection,
  createDefaultObjects,
  createDefaultSurface,
  createDirectionalLight,
  createPointLight,
  directionTowardOrigin,
  MAX_TURNTABLE_SPEED,
  MIN_TURNTABLE_SPEED,
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
    inspectorTab: 'object' | 'material' | 'scene';
    intersectionSourcePick: { intersectionId: UUID; slot: 0 | 1 } | null;
    lightCurveSourcePick: { lightId: UUID } | null;
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
  activeEquationParameterDrag: {
    plotId: UUID;
    parameterName: string;
    startValue: number;
    before: HistorySnapshot;
  } | null;
  activeLightCurveParameterDrag: {
    lightId: UUID;
    startValue: number;
    before: HistorySnapshot;
  } | null;
}

interface AppActions {
  setInspectorTab: (tab: AppState['ui']['inspectorTab']) => void;
  selectObject: (id: UUID | null) => void;
  addPlot: (template?: 'curve' | 'graph' | 'surface' | 'implicit') => void;
  addIntersection: () => void;
  addPointLight: () => void;
  addDirectionalLight: () => void;
  beginIntersectionSourcePick: (intersectionId: UUID, slot: 0 | 1) => void;
  cancelIntersectionSourcePick: () => void;
  setIntersectionSource: (intersectionId: UUID, slot: 0 | 1, surfaceId: UUID | null) => void;
  setLightCurvePinEnabled: (lightId: UUID, enabled: boolean) => void;
  beginLightCurveSourcePick: (lightId: UUID) => void;
  cancelLightCurveSourcePick: () => void;
  setLightCurveSource: (lightId: UUID, curveId: UUID | null) => void;
  beginLightCurveParameterDrag: (lightId: UUID) => void;
  commitLightCurveParameterDrag: (lightId: UUID) => void;
  cancelLightCurveParameterDrag: () => void;
  setLightCurveParameter: (lightId: UUID, value: number) => void;
  setLightCurveAnimation: (
    lightId: UUID,
    patch: { animating?: boolean; animationSpeed?: number },
  ) => void;
  applyLightCurveAnimationValues: (
    updates: ReadonlyArray<{ lightId: UUID; parameterValue: number }>,
  ) => void;
  updateIntersectionCurveStyle: (id: UUID, patch: Partial<IntersectionObject['curveStyle']>) => void;
  updatePlotEquationText: (id: UUID, rawText: string) => void;
  updatePlotSpec: (id: UUID, updater: (spec: EquationSpec) => EquationSpec) => void;
  updatePlotMaterial: (id: UUID, patch: Partial<RenderableObject['material']>) => void;
  applyMaterialPreset: (id: UUID, presetName: string) => void;
  updatePointLight: (id: UUID, patch: Partial<PointLightObject>) => void;
  updateDirectionalLight: (id: UUID, patch: Partial<DirectionalLightObject>) => void;
  updateScene: (patch: Partial<SceneSettings>) => void;
  updateRender: (patch: Partial<RenderSettings>) => void;
  setObjectName: (id: UUID, name: string) => void;
  setObjectVisibility: (id: UUID, visible: boolean) => void;
  setObjectPosition: (id: UUID, pos: { x: number; y: number; z: number }) => void;
  beginObjectDragHistory: (id: UUID) => void;
  commitObjectDragHistory: (id: UUID) => void;
  cancelObjectDragHistory: () => void;
  beginEquationParameterDrag: (plotId: UUID, parameterName: string) => void;
  commitEquationParameterDrag: (plotId: UUID, parameterName: string) => void;
  cancelEquationParameterDrag: () => void;
  setParameterAnimation: (plotId: UUID, parameterName: string, patch: { animating?: boolean; animationSpeed?: number }) => void;
  applyParameterAnimationValues: (updates: ReadonlyArray<{ plotId: UUID; parameterName: string; value: number }>) => void;
  deleteSelected: () => void;
  deleteObject: (id: UUID) => void;
  duplicateObject: (id: UUID) => void;
  copySelectedToClipboard: () => Promise<void>;
  pasteClipboard: () => Promise<void>;
  newProject: () => void;
  replaceProject: (project: ProjectFileV1) => void;
  exportProjectFile: () => ProjectFileV1;
  undo: () => void;
  redo: () => void;
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
    backend: 'unsupported',
    webglReady: false,
    plotCount: 0,
    pointLightCount: 0,
    transparentPlotCount: 0,
    shadowMapResolution: 0,
    frameTimeMs: 0,
    fps: 0,
    shadowAtlasUsage: 0,
    opaqueShadowCasters: 0,
    transmittanceShadowCasters: 0,
    pointShadowCount: 0,
    activeProbeCount: 0,
    outlineMode: 'disabled',
    reflectionSource: 'none',
    reflectionProbeRefreshCount: 0,
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
      intersectionSourcePick: null,
      lightCurveSourcePick: null,
    },
    renderDiagnostics: defaultRenderDiagnostics(),
    plotJobs: {},
    historyPast: [],
    historyFuture: [],
    activeObjectDragHistory: null,
    activeEquationParameterDrag: null,
    activeLightCurveParameterDrag: null,
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
  const parameters = syncEquationParameters(analyzed.parameterNames);
  const domain = { uMin: -4, uMax: 4, vMin: -4, vMax: 4, uSamples: 80, vSamples: 80 };
  if (analyzed.inferredKind === 'parametric_curve') {
    return {
      kind: 'parametric_curve',
      source,
      parameters,
      tDomain: { min: -8, max: 8, samples: 200 },
      tubeRadius: 0.05,
      renderAsTube: true,
    };
  }
  if (analyzed.inferredKind === 'parametric_surface') {
    return {
      kind: 'parametric_surface',
      source,
      parameters,
      domain,
    };
  }
  if (analyzed.inferredKind === 'explicit_surface') {
    return {
      kind: 'explicit_surface',
      source,
      parameters,
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
      parameters,
      bounds: structuredClone(defaultBounds),
      quality: 'high',
    };
  }
  return {
    kind: 'explicit_surface',
    source,
    parameters,
    solvedAxis: 'z',
    domainAxes: ['x', 'y'],
    domain,
    compileAsParametric: true,
  };
}

function coerceEquationSpec(existing: EquationSpec, rawText: string, forcedKind?: EquationSpec['kind']): EquationSpec {
  const graphExpression = existing.kind === 'explicit_surface' && existing.graphExpression;
  const analyzed = graphExpression ? analyzeGraphExpression(rawText) : analyzeEquationText(rawText);
  const inferred = forcedKind ?? analyzed.inferredKind;
  const source = analyzed.source;
  const nextParameters =
    analyzed.inferredKind === 'unknown' && source.parseStatus !== 'ok'
      ? existing.parameters.map((parameter) => ({ ...parameter }))
      : syncEquationParameters(analyzed.parameterNames, existing.parameters);

  const keepSurfaceDomain = (spec: EquationSpec) =>
    spec.kind === 'parametric_surface' || spec.kind === 'explicit_surface' ? spec.domain : undefined;

  if (inferred === 'parametric_curve') {
    return {
      kind: 'parametric_curve',
      source,
      parameters: nextParameters,
      tDomain: existing.kind === 'parametric_curve' ? existing.tDomain : { min: -8, max: 8, samples: 200 },
      tubeRadius: existing.kind === 'parametric_curve' ? existing.tubeRadius : 0.05,
      renderAsTube: existing.kind === 'parametric_curve' ? existing.renderAsTube : true,
    };
  }

  if (inferred === 'parametric_surface') {
    return {
      kind: 'parametric_surface',
      source,
      parameters: nextParameters,
      domain: keepSurfaceDomain(existing) ?? { uMin: -4, uMax: 4, vMin: -4, vMax: 4, uSamples: 80, vSamples: 80 },
    };
  }

  if (inferred === 'explicit_surface') {
    const priorDomain = keepSurfaceDomain(existing);
    return {
      kind: 'explicit_surface',
      graphExpression: graphExpression || undefined,
      source,
      parameters: nextParameters,
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
      parameters: nextParameters,
      bounds: existing.kind === 'implicit_surface' ? existing.bounds : structuredClone(defaultBounds),
      quality: existing.kind === 'implicit_surface' ? existing.quality : 'high',
    };
  }

  return { ...existing, source, parameters: nextParameters };
}

function clearInvalidIntersectionSources(
  objects: SceneObject[],
  previousObjects: ReadonlyArray<SceneObject> = objects,
): SceneObject[] {
  const surfacesById = new Set(objects.filter(isSurfacePlot).map((surface) => surface.id));
  const curvesById = new Map(
    objects.filter(isParametricCurvePlot).map((curve) => [curve.id, curve] as const),
  );
  return objects.map((object) => {
    if (isLightObject(object)) {
      const curve = object.curvePin.curveId ? curvesById.get(object.curvePin.curveId) : null;
      const bounds = curve ? curveParameterBounds(curve) : null;
      const parameterValue = curve && bounds
        ? clampCurveParameter(curve, object.curvePin.parameterValue) ?? object.curvePin.parameterValue
        : object.curvePin.parameterValue;
      const curveId = curve?.id ?? null;
      const canAnimate = !!curve
        && !!bounds
        && curve.equation.source.parseStatus === 'ok';
      const animating = object.curvePin.enabled && canAnimate ? object.curvePin.animating : false;
      const sourceBecameInvalid = object.curvePin.enabled
        && !!object.curvePin.curveId
        && !canAnimate;
      const previousLight = sourceBecameInvalid
        ? previousObjects.find((candidate) => candidate.id === object.id)
        : null;
      const lastPinnedPosition = isLightObject(previousLight)
        ? resolvePinnedLightPosition(previousLight, previousObjects)
        : null;
      if (
        curveId === object.curvePin.curveId
        && parameterValue === object.curvePin.parameterValue
        && animating === object.curvePin.animating
        && !lastPinnedPosition
      ) {
        return object;
      }
      const nextLight: LightObject = {
        ...object,
        curvePin: {
          ...object.curvePin,
          curveId,
          parameterValue,
          animating,
        },
      };
      if (lastPinnedPosition) {
        nextLight.position = lastPinnedPosition;
        if (nextLight.type === 'directional_light') {
          nextLight.direction = directionTowardOrigin(lastPinnedPosition);
        }
      }
      return nextLight;
    }
    if (object.type !== 'intersection') {
      return object;
    }
    const first = object.sourceSurfaceIds[0];
    const second = object.sourceSurfaceIds[1];
    const nextFirst = first && surfacesById.has(first) ? first : null;
    const nextSecond = second && surfacesById.has(second) && second !== nextFirst ? second : null;
    if (nextFirst === first && nextSecond === second) {
      return object;
    }
    return {
      ...object,
      sourceSurfaceIds: [nextFirst, nextSecond],
    };
  });
}

function ensureUniqueObjectIds(objects: SceneObject[]): SceneObject[] {
  const idCounts = new Map<UUID, number>();
  for (const object of objects) {
    idCounts.set(object.id, (idCounts.get(object.id) ?? 0) + 1);
  }
  const ambiguousIds = new Set(
    [...idCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id),
  );
  if (ambiguousIds.size === 0) return objects;

  const reservedIds = new Set(objects.map((object) => object.id));
  const usedIds = new Set<UUID>();
  const uniqueObjects = objects.map((object) => {
    if (!usedIds.has(object.id)) {
      usedIds.add(object.id);
      return object;
    }
    let nextId = uuidv4();
    while (reservedIds.has(nextId) || usedIds.has(nextId)) {
      nextId = uuidv4();
    }
    usedIds.add(nextId);
    return { ...object, id: nextId } as SceneObject;
  });

  return uniqueObjects.map((object) => {
    if (isLightObject(object)) {
      const curveId = object.curvePin.curveId;
      return curveId && ambiguousIds.has(curveId)
        ? { ...object, curvePin: { ...object.curvePin, curveId: null, animating: false } }
        : object;
    }
    if (object.type !== 'intersection') return object;
    const [first, second] = object.sourceSurfaceIds;
    return {
      ...object,
      sourceSurfaceIds: [
        first && !ambiguousIds.has(first) ? first : null,
        second && !ambiguousIds.has(second) ? second : null,
      ],
    };
  });
}

function isLightObject(object: SceneObject | undefined | null): object is LightObject {
  return object?.type === 'point_light' || object?.type === 'directional_light';
}

function cloneWithNewId(object: SceneObject, offsetPosition = true): SceneObject {
  const cloned = structuredClone(object) as SceneObject;
  cloned.id = uuidv4();
  cloned.name = `${cloned.name} Copy`;
  if (offsetPosition) {
    if (cloned.type === 'plot') {
      cloned.transform.position.x += 0.4;
      cloned.transform.position.y += 0.4;
    } else if (cloned.type === 'point_light' || cloned.type === 'directional_light') {
      cloned.position.x += 0.4;
      cloned.position.y += 0.4;
      if (cloned.type === 'directional_light') {
        cloned.direction = directionTowardOrigin(cloned.position);
      }
    }
  }
  return cloned;
}

function clipboardPlainText(object: SceneObject): string {
  return object.type === 'plot' ? object.equation.source.rawText : object.name;
}

function surfaceDecorationSettings(material: RenderableObject['material']): Partial<RenderableObject['material']> {
  return {
    wireframeVisible: material.wireframeVisible,
    wireframeCellSize: material.wireframeCellSize,
    wireframeColor: material.wireframeColor,
    xContoursVisible: material.xContoursVisible,
    xContourSpacing: material.xContourSpacing,
    xContourColor: material.xContourColor,
    yContoursVisible: material.yContoursVisible,
    yContourSpacing: material.yContourSpacing,
    yContourColor: material.yContourColor,
    zContoursVisible: material.zContoursVisible,
    zContourSpacing: material.zContourSpacing,
    zContourColor: material.zContourColor,
  };
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
  const normalizedScene = normalizeSceneSettingsImport(sceneInput, ambientInput, directionalInput, shadowInput, sceneDefaults);
  const normalizedRender = normalizeRenderSettingsImport(renderInput, renderDefaults);
  const objectInputs = Array.isArray(projectRecord.objects) ? projectRecord.objects : [];
  let normalizedObjects = clearInvalidIntersectionSources(ensureUniqueObjectIds(objectInputs
    .map((obj, index) => normalizeSceneObjectImport(obj, index))
    .filter((result): result is { object: SceneObject } => !!result)
    .map((result) => result.object)));
  if (!normalizedObjects.some((object) => object.type === 'directional_light') && normalizedScene.directional.enabled) {
    const migrated = createDirectionalLight(`Directional Light ${countDirectionalLights(normalizedObjects) + 1}`);
    migrated.color = normalizedScene.directional.color;
    migrated.intensity = Math.max(0, normalizedScene.directional.intensity);
    migrated.castShadows = normalizedScene.directional.castShadows;
    normalizedObjects = [...normalizedObjects, migrated];
  }
  // New projects store directional sources as objects. Keeping this disabled
  // marker prevents a deleted light from being recreated when a v1 file reloads.
  normalizedScene.directional = { ...normalizedScene.directional, enabled: false };
  return {
    schemaVersion: 1,
    appVersion: typeof projectRecord.appVersion === 'string' ? projectRecord.appVersion : APP_VERSION,
    scene: normalizedScene,
    render: normalizedRender,
    objects: normalizedObjects,
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  ...initialState(),

  setInspectorTab: (tab) => set((state) => ({
    ...state,
    ui: {
      ...state.ui,
      inspectorTab: tab,
      intersectionSourcePick: tab === 'object' ? state.ui.intersectionSourcePick : null,
      lightCurveSourcePick: tab === 'object' ? state.ui.lightCurveSourcePick : null,
    },
  })),

  selectObject: (id) => set((state) => ({
    ...state,
    selectedId: id,
    ui: {
      ...state.ui,
      intersectionSourcePick: state.ui.intersectionSourcePick?.intersectionId === id
        ? state.ui.intersectionSourcePick
        : null,
      lightCurveSourcePick: state.ui.lightCurveSourcePick?.lightId === id
        ? state.ui.lightCurveSourcePick
        : null,
    },
  })),

  addPlot: (template) =>
    set((state) => {
      const past = [...state.historyPast, snapshotOf(state)];
      const actualPlot =
        template === 'curve'
          ? createDefaultCurve(`Curve ${countPlotsByKind(state.objects, 'curve') + 1}`)
          : template === 'graph'
            ? createDefaultGraph(`Graph ${countPlotsByKind(state.objects, 'graph') + 1}`)
          : template === 'surface'
            ? createDefaultSurface(`Parametric ${countPlotsByKind(state.objects, 'parametric') + 1}`)
            : template === 'implicit'
              ? createDefaultImplicit(`Implicit ${countPlotsByKind(state.objects, 'implicit') + 1}`)
              : createBlankPlot(`Surface ${countPlotsByKind(state.objects, 'graph') + 1}`);
      return {
        ...state,
        objects: [...state.objects, actualPlot],
        selectedId: actualPlot.id,
        ui: { ...state.ui, intersectionSourcePick: null, lightCurveSourcePick: null },
        historyPast: past,
        historyFuture: [],
      };
    }),

  addIntersection: () =>
    set((state) => {
      const intersection = createDefaultIntersection(nextIntersectionName(state.objects));
      return {
        ...state,
        objects: [...state.objects, intersection],
        selectedId: intersection.id,
        ui: { ...state.ui, inspectorTab: 'object', intersectionSourcePick: null, lightCurveSourcePick: null },
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  addPointLight: () =>
    set((state) => {
      const light = createPointLight(`Point Light ${countPointLights(state.objects) + 1}`);
      return {
        ...state,
        objects: [...state.objects, light],
        selectedId: light.id,
        ui: { ...state.ui, intersectionSourcePick: null, lightCurveSourcePick: null },
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  addDirectionalLight: () =>
    set((state) => {
      const light = createDirectionalLight(`Directional Light ${countDirectionalLights(state.objects) + 1}`);
      return {
        ...state,
        objects: [...state.objects, light],
        selectedId: light.id,
        ui: { ...state.ui, inspectorTab: 'object', intersectionSourcePick: null, lightCurveSourcePick: null },
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  beginIntersectionSourcePick: (intersectionId, slot) =>
    set((state) => {
      if (slot !== 0 && slot !== 1) return state;
      const intersection = state.objects.find(
        (object): object is IntersectionObject => object.id === intersectionId && object.type === 'intersection',
      );
      if (!intersection) return state;
      const current = state.ui.intersectionSourcePick;
      const nextPick = current?.intersectionId === intersectionId && current.slot === slot
        ? null
        : { intersectionId, slot };
      return {
        ...state,
        selectedId: intersectionId,
        ui: {
          ...state.ui,
          inspectorTab: 'object',
          intersectionSourcePick: nextPick,
          lightCurveSourcePick: null,
        },
      };
    }),

  cancelIntersectionSourcePick: () =>
    set((state) => state.ui.intersectionSourcePick
      ? { ...state, ui: { ...state.ui, intersectionSourcePick: null } }
      : state),

  setIntersectionSource: (intersectionId, slot, surfaceId) =>
    set((state) => {
      if (slot !== 0 && slot !== 1) return state;
      const idx = state.objects.findIndex(
        (object): object is IntersectionObject => object.id === intersectionId && object.type === 'intersection',
      );
      if (idx === -1) return state;
      const intersection = state.objects[idx] as IntersectionObject;
      const clearsActivePick = state.ui.intersectionSourcePick?.intersectionId === intersectionId
        && state.ui.intersectionSourcePick.slot === slot;
      if (intersection.sourceSurfaceIds[slot] === surfaceId) {
        return clearsActivePick
          ? { ...state, ui: { ...state.ui, intersectionSourcePick: null } }
          : state;
      }
      if (surfaceId !== null) {
        const source = state.objects.find((object) => object.id === surfaceId);
        if (!isSurfacePlot(source) || intersection.sourceSurfaceIds[slot === 0 ? 1 : 0] === surfaceId) {
          return state;
        }
      }
      const next = produce(state, (draft) => {
        const draftIntersection = draft.objects[idx] as IntersectionObject;
        draftIntersection.sourceSurfaceIds[slot] = surfaceId;
      });
      return {
        ...next,
        ui: clearsActivePick ? { ...next.ui, intersectionSourcePick: null } : next.ui,
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  setLightCurvePinEnabled: (lightId, enabled) =>
    set((state) => {
      const idx = state.objects.findIndex((object) => object.id === lightId && isLightObject(object));
      if (idx === -1) return state;
      const light = state.objects[idx] as LightObject;
      if (light.curvePin.enabled === enabled) return state;
      const pinnedPosition = !enabled ? resolvePinnedLightPosition(light, state.objects) : null;
      const next = produce(state, (draft) => {
        const draftLight = draft.objects[idx] as LightObject;
        draftLight.curvePin.enabled = enabled;
        if (!enabled) draftLight.curvePin.animating = false;
        if (pinnedPosition) {
          draftLight.position = pinnedPosition;
          if (draftLight.type === 'directional_light') {
            draftLight.direction = directionTowardOrigin(pinnedPosition);
          }
        }
      });
      return {
        ...next,
        ui: {
          ...next.ui,
          lightCurveSourcePick: enabled ? next.ui.lightCurveSourcePick : null,
        },
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  beginLightCurveSourcePick: (lightId) =>
    set((state) => {
      const light = state.objects.find((object) => object.id === lightId && isLightObject(object));
      if (!isLightObject(light) || !light.curvePin.enabled) return state;
      const nextPick = state.ui.lightCurveSourcePick?.lightId === lightId ? null : { lightId };
      return {
        ...state,
        selectedId: lightId,
        ui: {
          ...state.ui,
          inspectorTab: 'object',
          intersectionSourcePick: null,
          lightCurveSourcePick: nextPick,
        },
      };
    }),

  cancelLightCurveSourcePick: () =>
    set((state) => state.ui.lightCurveSourcePick
      ? { ...state, ui: { ...state.ui, lightCurveSourcePick: null } }
      : state),

  setLightCurveSource: (lightId, curveId) =>
    set((state) => {
      const idx = state.objects.findIndex((object) => object.id === lightId && isLightObject(object));
      if (idx === -1) return state;
      const light = state.objects[idx] as LightObject;
      const clearsActivePick = state.ui.lightCurveSourcePick?.lightId === lightId;
      if (light.curvePin.curveId === curveId) {
        return clearsActivePick
          ? { ...state, ui: { ...state.ui, lightCurveSourcePick: null } }
          : state;
      }
      const curve = curveId
        ? state.objects.find(
            (object): object is PlotObject => object.id === curveId && isParametricCurvePlot(object),
          )
        : null;
      if (curveId && !isParametricCurvePlot(curve)) return state;
      const nextValue = curve?.equation.kind === 'parametric_curve'
        ? curve.equation.tDomain.min
        : light.curvePin.parameterValue;
      const next = produce(state, (draft) => {
        const draftLight = draft.objects[idx] as LightObject;
        draftLight.curvePin.curveId = curve?.id ?? null;
        draftLight.curvePin.parameterValue = nextValue;
        draftLight.curvePin.animating = false;
      });
      return {
        ...next,
        ui: clearsActivePick ? { ...next.ui, lightCurveSourcePick: null } : next.ui,
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  beginLightCurveParameterDrag: (lightId) =>
    set((state) => {
      const light = state.objects.find((object) => object.id === lightId && isLightObject(object));
      if (!isLightObject(light)) return state;
      if (state.activeLightCurveParameterDrag?.lightId === lightId) return state;
      return {
        ...state,
        activeLightCurveParameterDrag: {
          lightId,
          startValue: light.curvePin.parameterValue,
          before: snapshotOf(state),
        },
      };
    }),

  commitLightCurveParameterDrag: (lightId) =>
    set((state) => {
      const active = state.activeLightCurveParameterDrag;
      if (!active) return state;
      if (active.lightId !== lightId) return { ...state, activeLightCurveParameterDrag: null };
      const light = state.objects.find((object) => object.id === lightId && isLightObject(object));
      if (!isLightObject(light) || light.curvePin.parameterValue === active.startValue) {
        return { ...state, activeLightCurveParameterDrag: null };
      }
      return {
        ...state,
        activeLightCurveParameterDrag: null,
        historyPast: [...state.historyPast, active.before],
        historyFuture: [],
      };
    }),

  cancelLightCurveParameterDrag: () =>
    set((state) => state.activeLightCurveParameterDrag
      ? { ...state, activeLightCurveParameterDrag: null }
      : state),

  setLightCurveParameter: (lightId, value) =>
    set((state) => {
      const idx = state.objects.findIndex((object) => object.id === lightId && isLightObject(object));
      if (idx === -1) return state;
      const light = state.objects[idx] as LightObject;
      const curve = pinnedCurveForLight(light, state.objects);
      const nextValue = curve ? clampCurveParameter(curve, value) : null;
      if (nextValue === null || nextValue === light.curvePin.parameterValue) return state;
      const next = produce(state, (draft) => {
        (draft.objects[idx] as LightObject).curvePin.parameterValue = nextValue;
      });
      if (state.activeLightCurveParameterDrag?.lightId === lightId) return next;
      return {
        ...next,
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  setLightCurveAnimation: (lightId, patch) =>
    set((state) => {
      const idx = state.objects.findIndex((object) => object.id === lightId && isLightObject(object));
      if (idx === -1) return state;
      const light = state.objects[idx] as LightObject;
      const curve = pinnedCurveForLight(light, state.objects);
      if (
        patch.animating === true
        && (!curve || !curveParameterBounds(curve) || curve.equation.source.parseStatus !== 'ok')
      ) {
        return state;
      }
      if (!curve && patch.animating !== false) return state;
      return produce(state, (draft) => {
        const pin = (draft.objects[idx] as LightObject).curvePin;
        if (patch.animating !== undefined) pin.animating = patch.animating;
        if (patch.animationSpeed !== undefined) pin.animationSpeed = clampAnimationSpeed(patch.animationSpeed);
      });
    }),

  applyLightCurveAnimationValues: (updates) =>
    set((state) => {
      if (updates.length === 0) return state;
      return produce(state, (draft) => {
        for (const update of updates) {
          const light = draft.objects.find(
            (object): object is LightObject => object.id === update.lightId && isLightObject(object),
          );
          if (!light) continue;
          const source = state.objects.find((object) => object.id === light.curvePin.curveId);
          if (!isParametricCurvePlot(source)) continue;
          const value = clampCurveParameter(source, update.parameterValue);
          if (value !== null) light.curvePin.parameterValue = value;
        }
      });
    }),

  updateIntersectionCurveStyle: (id, patch) =>
    set((state) => {
      const idx = state.objects.findIndex((object) => object.id === id && object.type === 'intersection');
      if (idx === -1) return state;
      const intersection = state.objects[idx] as IntersectionObject;
      const curveStyle = { ...intersection.curveStyle, ...patch };
      if (
        curveStyle.tubeRadius === intersection.curveStyle.tubeRadius
        && curveStyle.renderAsTube === intersection.curveStyle.renderAsTube
      ) {
        return state;
      }
      const next = produce(state, (draft) => {
        const draftIntersection = draft.objects[idx] as IntersectionObject;
        draftIntersection.curveStyle = curveStyle;
      });
      return {
        ...next,
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
        objects: clearInvalidIntersectionSources(next.objects, state.objects),
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
      const nextWithValidReferences = {
        ...next,
        objects: clearInvalidIntersectionSources(next.objects, state.objects),
      };
      if (state.activeEquationParameterDrag?.plotId === id) {
        return nextWithValidReferences;
      }
      return {
        ...nextWithValidReferences,
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  updatePlotMaterial: (id, patch) =>
    set((state) => {
      const idx = state.objects.findIndex((obj) => obj.id === id && isRenderableObject(obj));
      if (idx === -1) return state;
      const next = produce(state, (draft) => {
        const object = draft.objects[idx] as RenderableObject;
        object.material = { ...object.material, ...patch };
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
      const idx = state.objects.findIndex((obj) => obj.id === id && isRenderableObject(obj));
      if (idx === -1) return state;
      const next = produce(state, (draft) => {
        const object = draft.objects[idx] as RenderableObject;
        object.material = {
          ...preset,
          ...surfaceDecorationSettings(object.material),
        };
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

  updateDirectionalLight: (id, patch) =>
    set((state) => {
      const idx = state.objects.findIndex((obj) => obj.id === id && obj.type === 'directional_light');
      if (idx === -1) return state;
      const next = produce(state, (draft) => {
        const light = draft.objects[idx] as DirectionalLightObject;
        Object.assign(light, patch);
        light.direction = directionTowardOrigin(light.position);
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
    set((state) => ({
      ...state,
      render: { ...state.render, ...patch },
      historyPast: [...state.historyPast, snapshotOf(state)],
      historyFuture: [],
    })),

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
      if (state.objects[idx].type === 'intersection') return state;
      if (isLightObject(state.objects[idx]) && pinnedCurveForLight(state.objects[idx], state.objects)) return state;
      const currentPos = getObjectPosition(state.objects[idx]);
      if (positionsEqual(currentPos, pos)) return state;
      const next = produce(state, (draft) => {
        const obj = draft.objects[idx];
        if (obj.type === 'plot') {
          obj.transform.position = { ...pos };
        } else if (obj.type === 'point_light') {
          obj.position = { ...pos };
        } else if (obj.type === 'directional_light') {
          obj.position = { ...pos };
          obj.direction = directionTowardOrigin(pos);
        }
      });
      return next;
    }),

  beginObjectDragHistory: (id) =>
    set((state) => {
      const obj = state.objects.find((candidate) => candidate.id === id);
      if (!obj || obj.type === 'intersection') return state;
      if (isLightObject(obj) && pinnedCurveForLight(obj, state.objects)) return state;
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

  beginEquationParameterDrag: (plotId, parameterName) =>
    set((state) => {
      const startValue = plotParameterValue(state.objects, plotId, parameterName);
      if (startValue === null) {
        return state;
      }
      if (
        state.activeEquationParameterDrag
        && state.activeEquationParameterDrag.plotId === plotId
        && state.activeEquationParameterDrag.parameterName === parameterName
      ) {
        return state;
      }
      return {
        ...state,
        activeEquationParameterDrag: {
          plotId,
          parameterName,
          startValue,
          before: snapshotOf(state),
        },
      };
    }),

  commitEquationParameterDrag: (plotId, parameterName) =>
    set((state) => {
      const active = state.activeEquationParameterDrag;
      if (!active) return state;
      if (active.plotId !== plotId || active.parameterName !== parameterName) {
        return { ...state, activeEquationParameterDrag: null };
      }
      const currentValue = plotParameterValue(state.objects, plotId, parameterName);
      if (currentValue === null || currentValue === active.startValue) {
        return { ...state, activeEquationParameterDrag: null };
      }
      return {
        ...state,
        activeEquationParameterDrag: null,
        historyPast: [...state.historyPast, active.before],
        historyFuture: [],
      };
    }),

  cancelEquationParameterDrag: () =>
    set((state) => (state.activeEquationParameterDrag ? { ...state, activeEquationParameterDrag: null } : state)),

  // Play/pause and speed are runtime toggles, not document edits, so neither
  // this nor the per-frame animation ticks touch undo history.
  setParameterAnimation: (plotId, parameterName, patch) =>
    set((state) => {
      const idx = state.objects.findIndex((obj) => obj.id === plotId && obj.type === 'plot');
      if (idx === -1) return state;
      const plot = state.objects[idx] as PlotObject;
      if (!plot.equation.parameters.some((parameter) => parameter.name === parameterName)) {
        return state;
      }
      return produce(state, (draft) => {
        const draftPlot = draft.objects[idx] as PlotObject;
        draftPlot.equation.parameters = draftPlot.equation.parameters.map((parameter) =>
          parameter.name === parameterName ? { ...parameter, ...patch } : parameter,
        );
      });
    }),

  applyParameterAnimationValues: (updates) =>
    set((state) => {
      if (updates.length === 0) return state;
      return produce(state, (draft) => {
        for (const update of updates) {
          const plot = draft.objects.find(
            (obj): obj is PlotObject => obj.id === update.plotId && obj.type === 'plot',
          );
          if (!plot) continue;
          plot.equation.parameters = plot.equation.parameters.map((parameter) =>
            parameter.name === update.parameterName ? { ...parameter, value: update.value } : parameter,
          );
        }
      });
    }),

  deleteSelected: () =>
    set((state) => {
      if (!state.selectedId) return state;
      const objects = clearInvalidIntersectionSources(
        state.objects.filter((obj) => obj.id !== state.selectedId),
        state.objects,
      );
      return {
        ...state,
        objects,
        selectedId: null,
        ui: { ...state.ui, intersectionSourcePick: null, lightCurveSourcePick: null },
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  deleteObject: (id) =>
    set((state) => {
      if (!state.objects.some((obj) => obj.id === id)) return state;
      const objects = clearInvalidIntersectionSources(
        state.objects.filter((obj) => obj.id !== id),
        state.objects,
      );
      return {
        ...state,
        objects,
        selectedId: state.selectedId === id ? null : state.selectedId,
        ui: {
          ...state.ui,
          intersectionSourcePick: state.ui.intersectionSourcePick?.intersectionId === id
            ? null
            : state.ui.intersectionSourcePick,
          lightCurveSourcePick: state.ui.lightCurveSourcePick?.lightId === id
            ? null
            : state.ui.lightCurveSourcePick,
        },
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  duplicateObject: (id) =>
    set((state) => {
      const index = state.objects.findIndex((obj) => obj.id === id);
      if (index === -1) return state;
      const cloned = cloneWithNewId(state.objects[index]);
      const objects = [...state.objects];
      objects.splice(index + 1, 0, cloned);
      return {
        ...state,
        objects,
        selectedId: cloned.id,
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: [],
      };
    }),

  copySelectedToClipboard: async () => {
    const state = get();
    const selected = state.objects.find((obj) => obj.id === state.selectedId);
    if (!selected) {
      return;
    }
    const json = JSON.stringify(selected);
    const plainText = clipboardPlainText(selected);
    try {
      await maybeWriteClipboard(json, plainText);
      set((s) => ({ ...s, clipboardObject: structuredClone(selected) }));
    } catch {
      set((s) => ({ ...s, clipboardObject: structuredClone(selected) }));
    }
  },

  pasteClipboard: async () => {
    const state = get();
    const pasteFromObject = (obj: SceneObject) => {
      const cloned = cloneWithNewId(obj, false);
      set((s) => ({
        ...s,
        objects: clearInvalidIntersectionSources([...s.objects, cloned]),
        selectedId: cloned.id,
        historyPast: [...s.historyPast, snapshotOf(s)],
        historyFuture: [],
      }));
    };
    const pasteFromUnknown = (input: unknown): boolean => {
      const normalized = normalizeSceneObjectImport(input, get().objects.length);
      if (!normalized) return false;
      pasteFromObject(normalized.object);
      return true;
    };

    try {
      const clip = await maybeReadClipboard();
      if (clip.json) {
        if (pasteFromUnknown(JSON.parse(clip.json))) return;
      }
      if (clip.text) {
        const trimmed = clip.text.trim();
        if (state.clipboardObject && trimmed === clipboardPlainText(state.clipboardObject).trim()) {
          pasteFromObject(state.clipboardObject);
          return;
        }
        try {
          if (pasteFromUnknown(JSON.parse(trimmed))) return;
        } catch {
          // use text as equation
        }
        const newPlot = createBlankPlot(`Surface ${countPlotsByKind(state.objects, 'graph') + 1}`);
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
      renderDiagnostics: defaultRenderDiagnostics(),
      plotJobs: {},
      historyPast: [],
      historyFuture: [],
      activeObjectDragHistory: null,
      activeEquationParameterDrag: null,
      activeLightCurveParameterDrag: null,
      ui: { ...state.ui, intersectionSourcePick: null, lightCurveSourcePick: null },
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
        ui: { ...state.ui, intersectionSourcePick: null, lightCurveSourcePick: null },
        historyPast: state.historyPast.slice(0, -1),
        historyFuture: [snapshotOf(state), ...state.historyFuture],
        activeObjectDragHistory: null,
        activeEquationParameterDrag: null,
        activeLightCurveParameterDrag: null,
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
        ui: { ...state.ui, intersectionSourcePick: null, lightCurveSourcePick: null },
        historyPast: [...state.historyPast, snapshotOf(state)],
        historyFuture: state.historyFuture.slice(1),
        activeObjectDragHistory: null,
        activeEquationParameterDrag: null,
        activeLightCurveParameterDrag: null,
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
  return obj.type === 'point_light' || obj.type === 'directional_light'
    ? { ...obj.position }
    : { ...obj.transform.position };
}

function positionsEqual(
  a: { x: number; y: number; z: number } | null,
  b: { x: number; y: number; z: number } | null,
): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
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
    cameraProjection: asEnum(sceneInput.cameraProjection, ['perspective', 'orthographic']) ?? defaults.cameraProjection,
    turntableEnabled: asBoolean(sceneInput.turntableEnabled) ?? defaults.turntableEnabled,
    turntableSpeed: clampNumber(
      asFiniteNumber(sceneInput.turntableSpeed) ?? defaults.turntableSpeed,
      MIN_TURNTABLE_SPEED,
      MAX_TURNTABLE_SPEED,
    ),
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
    axisLabelsVisible: asBoolean(sceneInput.axisLabelsVisible) ?? defaults.axisLabelsVisible,
    defaultGraphBounds: normalizeBounds3D(sceneInput.defaultGraphBounds, defaults.defaultGraphBounds),
    ambient: {
      ...defaults.ambient,
      enabled: asBoolean(ambientInput.enabled) ?? defaults.ambient.enabled,
      color: asNonEmptyString(ambientInput.color) ?? defaults.ambient.color,
      intensity: asFiniteNumber(ambientInput.intensity) ?? defaults.ambient.intensity,
    },
    directional: {
      ...defaults.directional,
      enabled: asBoolean(directionalInput.enabled) ?? defaults.directional.enabled,
      direction: normalizeVec3(directionalInput.direction, defaults.directional.direction),
      color: asNonEmptyString(directionalInput.color) ?? defaults.directional.color,
      intensity: asFiniteNumber(directionalInput.intensity) ?? defaults.directional.intensity,
      castShadows: asBoolean(directionalInput.castShadows) ?? defaults.directional.castShadows,
    },
    shadow: {
      ...defaults.shadow,
      shadowMapResolution: asFiniteInteger(shadowInput.shadowMapResolution) ?? defaults.shadow.shadowMapResolution,
      shadowSoftness: clampNumber(asFiniteNumber(shadowInput.shadowSoftness) ?? defaults.shadow.shadowSoftness, 0, 1),
    },
  };
}

function normalizeRenderSettingsImport(
  renderInput: Record<string, unknown>,
  defaults: RenderSettings,
): RenderSettings {
  return {
    toneMapping: asEnum(renderInput.toneMapping, ['aces', 'filmic', 'none']) ?? defaults.toneMapping,
    interactiveQuality: asEnum(renderInput.interactiveQuality, ['performance', 'balanced', 'quality']) ?? defaults.interactiveQuality,
    gifMaxDimension: asNumberEnum(renderInput.gifMaxDimension, [480, 720, 1080]) ?? defaults.gifMaxDimension,
    gifFrameRate: asNumberEnum(renderInput.gifFrameRate, [10, 15, 20]) ?? defaults.gifFrameRate,
    exposure: asFiniteNumber(renderInput.exposure) ?? defaults.exposure,
    bloomEnabled: asBoolean(renderInput.bloomEnabled) ?? defaults.bloomEnabled,
    bloomStrength: clampNumber(
      asFiniteNumber(renderInput.bloomStrength) ?? defaults.bloomStrength,
      0,
      2,
    ),
    bloomRadius: clampNumber(
      asFiniteNumber(renderInput.bloomRadius) ?? defaults.bloomRadius,
      0.25,
      4,
    ),
    bloomThreshold: clampNumber(
      asFiniteNumber(renderInput.bloomThreshold) ?? defaults.bloomThreshold,
      0,
      5,
    ),
  };
}

function normalizeSceneObjectImport(input: unknown, index: number): { object: SceneObject } | null {
  const record = asRecord(input);
  if (!record) return null;
  const type = asEnum(record.type, ['plot', 'intersection', 'point_light', 'directional_light']);
  if (type === 'plot') {
    return { object: normalizePlotObjectImport(record, index) };
  }
  if (type === 'intersection') {
    return { object: normalizeIntersectionObjectImport(record, index) };
  }
  if (type === 'point_light') {
    return { object: normalizePointLightObjectImport(record, index) };
  }
  if (type === 'directional_light') {
    return { object: normalizeDirectionalLightObjectImport(record, index) };
  }
  return null;
}

function normalizeIntersectionObjectImport(record: Record<string, unknown>, index: number): IntersectionObject {
  const fallback = createDefaultIntersection(`Imported Intersection ${index + 1}`);
  const materialInput = asRecord(record.material);
  const curveStyleInput = asRecord(record.curveStyle);
  const sourceSurfaceIdsInput = Array.isArray(record.sourceSurfaceIds) ? record.sourceSurfaceIds : [];
  return {
    ...fallback,
    id: asNonEmptyString(record.id) ?? fallback.id,
    name: asNonEmptyString(record.name) ?? fallback.name,
    visible: asBoolean(record.visible) ?? fallback.visible,
    transform: structuredClone(fallback.transform),
    material: normalizeMaterialImport(materialInput, fallback.material),
    sourceSurfaceIds: [
      asNonEmptyString(sourceSurfaceIdsInput[0]),
      asNonEmptyString(sourceSurfaceIdsInput[1]),
    ],
    curveStyle: {
      tubeRadius: Math.max(0, asFiniteNumber(curveStyleInput?.tubeRadius) ?? fallback.curveStyle.tubeRadius),
      renderAsTube: asBoolean(curveStyleInput?.renderAsTube) ?? fallback.curveStyle.renderAsTube,
    },
  };
}

function normalizePlotObjectImport(record: Record<string, unknown>, index: number): PlotObject {
  const fallback = createBlankPlot(`Imported Surface ${index + 1}`);
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
    curvePin: normalizeLightCurvePin(asRecord(record.curvePin), fallback.curvePin),
  };
}

function normalizeDirectionalLightObjectImport(record: Record<string, unknown>, index: number): DirectionalLightObject {
  const fallback = createDirectionalLight(`Imported Directional Light ${index + 1}`);
  const position = normalizeVec3(record.position, fallback.position);
  return {
    ...fallback,
    id: asNonEmptyString(record.id) ?? fallback.id,
    name: asNonEmptyString(record.name) ?? fallback.name,
    visible: asBoolean(record.visible) ?? fallback.visible,
    position,
    direction: directionTowardOrigin(position),
    color: asNonEmptyString(record.color) ?? fallback.color,
    intensity: Math.max(0, asFiniteNumber(record.intensity) ?? fallback.intensity),
    castShadows: asBoolean(record.castShadows) ?? fallback.castShadows,
    curvePin: normalizeLightCurvePin(asRecord(record.curvePin), fallback.curvePin),
  };
}

function normalizeLightCurvePin(
  input: Record<string, unknown> | null,
  fallback: LightObject['curvePin'],
): LightObject['curvePin'] {
  if (!input) return { ...fallback };
  return {
    enabled: asBoolean(input.enabled) ?? fallback.enabled,
    curveId: asNonEmptyString(input.curveId),
    parameterValue: asFiniteNumber(input.parameterValue) ?? fallback.parameterValue,
    animating: asBoolean(input.animating) ?? fallback.animating,
    animationSpeed: clampAnimationSpeed(asFiniteNumber(input.animationSpeed) ?? fallback.animationSpeed),
  };
}

function normalizeMaterialImport(
  materialInput: Record<string, unknown> | null,
  fallback: PlotObject['material'],
): PlotObject['material'] {
  if (!materialInput) return { ...fallback };
  const importedEmissionStrength = asFiniteNumber(materialInput.emissionStrength);
  const emissionStrength = clampNumber(importedEmissionStrength ?? fallback.emissionStrength ?? 0, 0, 10);
  return {
    ...fallback,
    baseColor: asHexColor(materialInput.baseColor) ?? fallback.baseColor,
    opacity: clampNumber(asFiniteNumber(materialInput.opacity) ?? fallback.opacity, 0, 1),
    reflectiveness: clampNumber(asFiniteNumber(materialInput.reflectiveness) ?? fallback.reflectiveness, 0, 1),
    roughness: clampNumber(asFiniteNumber(materialInput.roughness) ?? fallback.roughness, 0, 1),
    emissionEnabled: asBoolean(materialInput.emissionEnabled)
      ?? (importedEmissionStrength != null ? importedEmissionStrength > 0 : fallback.emissionEnabled ?? false),
    emissionColor: asHexColor(materialInput.emissionColor) ?? fallback.emissionColor ?? fallback.baseColor,
    emissionStrength,
    refractionEnabled: asBoolean(materialInput.refractionEnabled) ?? fallback.refractionEnabled ?? false,
    ior: clampNumber(asFiniteNumber(materialInput.ior) ?? fallback.ior ?? 1.45, 1, 2.5),
    presetName: asNonEmptyString(materialInput.presetName) ?? fallback.presetName,
    wireframeVisible: asBoolean(materialInput.wireframeVisible) ?? fallback.wireframeVisible,
    wireframeCellSize: positiveFiniteNumber(materialInput.wireframeCellSize) ?? fallback.wireframeCellSize,
    wireframeColor: asHexColor(materialInput.wireframeColor) ?? fallback.wireframeColor,
    xContoursVisible: asBoolean(materialInput.xContoursVisible) ?? fallback.xContoursVisible,
    xContourSpacing: clampNumber(positiveFiniteNumber(materialInput.xContourSpacing) ?? fallback.xContourSpacing ?? 1, 0.1, 5),
    xContourColor: asHexColor(materialInput.xContourColor) ?? fallback.xContourColor,
    yContoursVisible: asBoolean(materialInput.yContoursVisible) ?? fallback.yContoursVisible,
    yContourSpacing: clampNumber(positiveFiniteNumber(materialInput.yContourSpacing) ?? fallback.yContourSpacing ?? 1, 0.1, 5),
    yContourColor: asHexColor(materialInput.yContourColor) ?? fallback.yContourColor,
    zContoursVisible: asBoolean(materialInput.zContoursVisible) ?? fallback.zContoursVisible,
    zContourSpacing: clampNumber(positiveFiniteNumber(materialInput.zContourSpacing) ?? fallback.zContourSpacing ?? 1, 0.1, 5),
    zContourColor: asHexColor(materialInput.zContourColor) ?? fallback.zContourColor,
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
  const graphExpression = asBoolean(equationInput.graphExpression) ?? false;
  const coercionFallback = graphExpression && fallback.kind === 'explicit_surface'
    ? { ...fallback, graphExpression: true }
    : fallback;
  const base = coerceEquationSpec(coercionFallback, rawText, requestedKind);

  if (base.kind === 'parametric_curve') {
    const tDomainInput = asRecord(equationInput.tDomain);
    return {
      ...base,
      parameters: normalizeEquationParameters(equationInput.parameters, base.parameters),
      tDomain: normalizeDomain1D(tDomainInput, base.tDomain),
      tubeRadius: Math.max(0, asFiniteNumber(equationInput.tubeRadius) ?? base.tubeRadius),
      renderAsTube: asBoolean(equationInput.renderAsTube) ?? base.renderAsTube,
    };
  }

  if (base.kind === 'parametric_surface') {
    return {
      ...base,
      parameters: normalizeEquationParameters(equationInput.parameters, base.parameters),
      domain: normalizeDomain2D(asRecord(equationInput.domain), base.domain),
    };
  }

  if (base.kind === 'explicit_surface') {
    return {
      ...base,
      graphExpression: graphExpression || base.graphExpression || undefined,
      parameters: normalizeEquationParameters(equationInput.parameters, base.parameters),
      solvedAxis: asEnum(equationInput.solvedAxis, ['x', 'y', 'z']) ?? base.solvedAxis,
      domainAxes: normalizeExplicitDomainAxes(equationInput.domainAxes, base.domainAxes),
      domain: normalizeDomain2D(asRecord(equationInput.domain), base.domain),
      compileAsParametric: true,
    };
  }

  return {
    ...base,
    parameters: normalizeEquationParameters(equationInput.parameters, base.parameters),
    bounds: normalizeBounds3D(equationInput.bounds, base.bounds),
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

function normalizeEquationParameters(
  input: unknown,
  fallback: PlotObject['equation']['parameters'],
): PlotObject['equation']['parameters'] {
  if (!Array.isArray(input)) return fallback.map((parameter) => ({ ...parameter }));
  const inputByName = new Map<string, Record<string, unknown>>();
  for (const item of input) {
    const record = asRecord(item);
    const name = asNonEmptyString(record?.name);
    if (!record || !name) continue;
    inputByName.set(name, record);
  }
  return fallback.map((parameter) => {
    const record = inputByName.get(parameter.name);
    if (!record) {
      return { ...parameter };
    }
    const value = asFiniteNumber(record.value) ?? parameter.value;
    const rawMin = asFiniteNumber(record.min);
    const rawMax = asFiniteNumber(record.max);
    const min = rawMin ?? Math.min(parameter.min, value);
    const max = rawMax ?? Math.max(parameter.max, value);
    const normalizedMin = Math.min(min, max, value);
    const normalizedMax = Math.max(min, max, value);
    const animationSpeed = asFiniteNumber(record.animationSpeed) ?? parameter.animationSpeed;
    const samplingMode = asEnum(record.samplingMode, ['continuous', 'discrete']) ?? parameter.samplingMode;
    const discreteCount = clampDiscreteParameterCount(
      asFiniteInteger(record.discreteCount) ?? parameter.discreteCount ?? DEFAULT_DISCRETE_PARAMETER_COUNT,
    );
    return {
      ...parameter,
      value: samplingMode === 'discrete'
        ? snapDiscreteParameterValue(value, normalizedMin, normalizedMax, discreteCount)
        : value,
      min: normalizedMin,
      max: normalizedMax,
      step: positiveFiniteNumber(record.step) ?? parameter.step,
      animating: asBoolean(record.animating) ?? parameter.animating,
      animationSpeed: animationSpeed === undefined ? undefined : clampAnimationSpeed(animationSpeed),
      samplingMode,
      discreteCount,
    };
  });
}

function countPlotsByKind(objects: SceneObject[], kind: 'curve' | 'graph' | 'parametric' | 'implicit'): number {
  return objects.filter((obj) => {
    if (obj.type !== 'plot') {
      return false;
    }
    if (kind === 'curve') {
      return obj.equation.kind === 'parametric_curve';
    }
    if (kind === 'graph') {
      return obj.equation.kind === 'explicit_surface';
    }
    if (kind === 'parametric') {
      return obj.equation.kind === 'parametric_surface';
    }
    if (kind === 'implicit') {
      return obj.equation.kind === 'implicit_surface';
    }
    return false;
  }).length;
}

function countPointLights(objects: SceneObject[]): number {
  return objects.filter((obj) => obj.type === 'point_light').length;
}

function countDirectionalLights(objects: SceneObject[]): number {
  return objects.filter((obj) => obj.type === 'directional_light').length;
}

function nextIntersectionName(objects: SceneObject[]): string {
  const usedNames = new Set(
    objects
      .filter((object) => object.type === 'intersection')
      .map((object) => object.name),
  );
  let suffix = 1;
  while (usedNames.has(`Intersection ${suffix}`)) suffix += 1;
  return `Intersection ${suffix}`;
}

function shallowDiagnosticsEqual(a: RenderDiagnostics, b: RenderDiagnostics): boolean {
  return (
    a.backend === b.backend &&
    a.webglReady === b.webglReady &&
    a.plotCount === b.plotCount &&
    a.pointLightCount === b.pointLightCount &&
    a.transparentPlotCount === b.transparentPlotCount &&
    a.frameTimeMs === b.frameTimeMs &&
    a.fps === b.fps &&
    a.shadowMapResolution === b.shadowMapResolution &&
    a.shadowAtlasUsage === b.shadowAtlasUsage &&
    a.opaqueShadowCasters === b.opaqueShadowCasters &&
    a.transmittanceShadowCasters === b.transmittanceShadowCasters &&
    a.pointShadowCount === b.pointShadowCount &&
    a.activeProbeCount === b.activeProbeCount &&
    a.outlineMode === b.outlineMode &&
    a.reflectionSource === b.reflectionSource &&
    a.reflectionProbeRefreshCount === b.reflectionProbeRefreshCount
  );
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

function asHexColor(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const digits = match[1];
  const normalized = digits.length === 3
    ? digits.split('').map((digit) => `${digit}${digit}`).join('')
    : digits;
  return `#${normalized.toLowerCase()}`;
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

function plotParameterValue(objects: SceneObject[], plotId: UUID, parameterFieldKey: string): number | null {
  const plot = objects.find((candidate): candidate is PlotObject => candidate.id === plotId && candidate.type === 'plot');
  if (!plot) {
    return null;
  }
  const [parameterName, field = 'value'] = parameterFieldKey.split(':');
  const parameter = plot.equation.parameters.find((candidate) => candidate.name === parameterName);
  if (!parameter) {
    return null;
  }
  if (field === 'value') {
    return typeof parameter.value === 'number' ? parameter.value : null;
  }
  if (field === 'discreteCount') {
    return typeof parameter.discreteCount === 'number' ? parameter.discreteCount : null;
  }
  return null;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (typeof value !== 'string') return null;
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function asNumberEnum<T extends number>(value: unknown, allowed: readonly T[]): T | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return (allowed as readonly number[]).includes(value) ? (value as T) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
