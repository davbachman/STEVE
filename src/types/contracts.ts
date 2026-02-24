export type UUID = string;

export type EquationObjectKind =
  | 'parametric_curve'
  | 'parametric_surface'
  | 'implicit_surface'
  | 'explicit_surface';

export type Axis = 'x' | 'y' | 'z';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Transform {
  position: Vec3;
}

export interface Domain1D {
  min: number;
  max: number;
  samples: number;
}

export interface Domain2D {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  uSamples: number;
  vSamples: number;
}

export interface Bounds3D {
  min: Vec3;
  max: Vec3;
}

export interface ParseDiagnostic {
  message: string;
  start: number;
  end: number;
  severity: 'error' | 'warning';
}

export interface EquationClassification {
  kind: EquationObjectKind | 'unknown';
  label: 'Curve' | 'Surface' | 'Implicit' | 'Explicit->Parametric' | 'Unknown';
  warning?: string;
}

export interface EquationSource {
  rawText: string;
  formattedLatex?: string;
  parseStatus: 'ok' | 'partial' | 'error';
  parseErrors: ParseDiagnostic[];
  classification?: EquationClassification;
}

export interface MaterialParams {
  baseColor: string;
  opacity: number;
  transmission: number;
  ior: number;
  reflectiveness: number;
  roughness: number;
  presetName?: string;
  wireframeVisible?: boolean;
  wireframeCellSize?: number;
}

export interface ParametricCurveSpec {
  kind: 'parametric_curve';
  source: EquationSource;
  tDomain: Domain1D;
  tubeRadius: number;
  renderAsTube: boolean;
}

export interface ParametricSurfaceSpec {
  kind: 'parametric_surface';
  source: EquationSource;
  domain: Domain2D;
}

export interface ExplicitSurfaceSpec {
  kind: 'explicit_surface';
  source: EquationSource;
  solvedAxis: Axis;
  domainAxes: [Axis, Axis];
  domain: Domain2D;
  compileAsParametric: true;
}

export interface ImplicitSurfaceSpec {
  kind: 'implicit_surface';
  source: EquationSource;
  bounds: Bounds3D;
  isoValue: number;
  quality: 'draft' | 'medium' | 'high';
}

export type EquationSpec =
  | ParametricCurveSpec
  | ParametricSurfaceSpec
  | ExplicitSurfaceSpec
  | ImplicitSurfaceSpec;

export interface PlotObject {
  id: UUID;
  name: string;
  type: 'plot';
  visible: boolean;
  transform: Transform;
  equation: EquationSpec;
  material: MaterialParams;
}

export interface PointLightObject {
  id: UUID;
  name: string;
  type: 'point_light';
  visible: boolean;
  position: Vec3;
  color: string;
  intensity: number;
  range: number;
  castShadows: boolean;
}

export interface DirectionalLightSettings {
  direction: Vec3;
  color: string;
  intensity: number;
  castShadows: boolean;
}

export interface AmbientLightSettings {
  color: string;
  intensity: number;
}

export type PointShadowMode = 'off' | 'auto' | 'on';

export interface ShadowSettings {
  directionalShadowEnabled: boolean;
  pointShadowMode: PointShadowMode;
  pointShadowMaxLights: number;
  shadowMapResolution: number;
  shadowSoftness: number; // 0..1
  gridShadowReceiverEnabled: boolean;
}

export interface SceneSettings {
  backgroundMode: 'solid' | 'gradient';
  backgroundColor: string;
  gradientTopColor: string;
  gradientBottomColor: string;
  groundPlaneVisible: boolean;
  groundPlaneSize: number;
  groundPlaneColor: string;
  groundPlaneRoughness: number;
  groundPlaneReflective: boolean;
  gridVisible: boolean;
  gridExtent: number;
  gridSpacing: number;
  gridLineOpacity: number;
  axesVisible: boolean;
  axesLength: number;
  axesLabelsVisible: boolean;
  defaultGraphBounds: Bounds3D;
  ambient: AmbientLightSettings;
  directional: DirectionalLightSettings;
  shadow: ShadowSettings;
}

export interface RenderSettings {
  mode: 'interactive' | 'quality';
  toneMapping: 'aces' | 'filmic' | 'none';
  exposure: number;
  interactiveQuality: 'performance' | 'balanced' | 'quality';
  qualitySamplesTarget: number;
  qualityResolutionScale: number;
  denoise: boolean;
  qualityRunning: boolean;
  qualityCurrentSamples: number;
  showDiagnostics: boolean;
}

export type SceneObject = PlotObject | PointLightObject;

export interface ProjectFileV1 {
  schemaVersion: 1;
  appVersion: string;
  scene: SceneSettings;
  render: RenderSettings;
  objects: SceneObject[];
}

export interface SerializedMesh {
  positions: Float32Array;
  indices: Uint32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  lines?: Float32Array[];
  curvePath?: Float32Array;
}

export interface ParseClassifyResult {
  source: EquationSource;
  inferredKind: EquationObjectKind | 'unknown';
  explicitAxis?: Axis;
  explicitDomainAxes?: [Axis, Axis];
  warning?: string;
}

export type WorkerJobPriority = 'preview' | 'refine' | 'interactive' | 'background';

export type WorkerRequest =
  | { type: 'parse_and_classify'; jobId: UUID; objectId: UUID; rawText: string }
  | {
      type: 'build_parametric_mesh';
      jobId: UUID;
      objectId: UUID;
      spec: ParametricSurfaceSpec | ExplicitSurfaceSpec;
      priority: WorkerJobPriority;
      wireframeCellSize?: number;
    }
  | { type: 'build_curve_mesh'; jobId: UUID; objectId: UUID; spec: ParametricCurveSpec; priority: WorkerJobPriority }
  | { type: 'build_implicit_mesh'; jobId: UUID; objectId: UUID; spec: ImplicitSurfaceSpec; priority: WorkerJobPriority }
  | { type: 'cancel_jobs'; jobId: UUID; objectId: UUID };

export type WorkerResponse =
  | { type: 'parse_result'; jobId: UUID; objectId: UUID; result: ParseClassifyResult }
  | { type: 'parse_progress'; jobId: UUID; objectId: UUID; phase: string; progress: number }
  | { type: 'mesh_progress'; jobId: UUID; objectId: UUID; phase: string; progress: number }
  | {
      type: 'mesh_preview';
      jobId: UUID;
      objectId: UUID;
      mesh: SerializedMesh;
      transferables?: ArrayBuffer[];
    }
  | {
      type: 'mesh_final';
      jobId: UUID;
      objectId: UUID;
      mesh: SerializedMesh;
      transferables?: ArrayBuffer[];
    }
  | { type: 'cancel_ack'; jobId: UUID; objectId: UUID }
  | { type: 'job_error'; jobId: UUID; objectId: UUID; message: string; recoverable: boolean };

export interface RenderDiagnostics {
  webgpuReady: boolean;
  plotCount: number;
  pointLightCount: number;
  directionalShadowEnabled: boolean;
  directionalShadowCasterCount: number;
  pointShadowsEnabled: number;
  pointShadowLimit: number;
  pointShadowCasterCounts?: Record<string, number>;
  shadowReceiver: 'ground' | 'grid' | 'none';
  transparentPlotCount: number;
  shadowMapResolution: number;
  pointShadowMode: PointShadowMode;
  pointShadowCapability: 'unknown' | 'available' | 'unavailable';
}

export type PlotJobPhase = 'idle' | 'queued' | 'parsing' | 'mesh_preview' | 'mesh_final' | 'ready' | 'error' | 'skipped';

export interface PlotJobStatus {
  parsePhase: Exclude<PlotJobPhase, 'mesh_preview' | 'mesh_final' | 'ready'> | 'ready';
  meshPhase: PlotJobPhase;
  progress: number;
  message?: string;
  hasPreview: boolean;
  meshVersion: number;
  lastMeshBuildMs?: number;
  lastError?: string;
}

export interface HistorySnapshot {
  scene: SceneSettings;
  render: RenderSettings;
  objects: SceneObject[];
  selectedId: UUID | null;
}
