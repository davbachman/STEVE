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

export interface EquationParameter {
  name: string;
  value: number;
  min: number;
  max: number;
  step: number;
  samplingMode: 'continuous' | 'discrete';
  discreteCount: number;
  /** Continuous: sweep automatically. Discrete: show every sampled copy. */
  animating?: boolean;
  /** Continuous sweep speed as a fraction of the min→max range per second. */
  animationSpeed?: number;
}

export interface BaseEquationSpec {
  source: EquationSource;
  parameters: EquationParameter[];
}

export interface MaterialParams {
  baseColor: string;
  opacity: number;
  reflectiveness: number;
  roughness: number;
  /** Bend the background seen through transparent surfaces (screen-space refraction). */
  refractionEnabled?: boolean;
  /** Index of refraction used when refractionEnabled; 1 = no bending, glass ≈ 1.45. */
  ior?: number;
  presetName?: string;
  wireframeVisible?: boolean;
  wireframeCellSize?: number;
  wireframeColor?: string;
  xContoursVisible?: boolean;
  xContourSpacing?: number;
  xContourColor?: string;
  yContoursVisible?: boolean;
  yContourSpacing?: number;
  yContourColor?: string;
  zContoursVisible?: boolean;
  zContourSpacing?: number;
  zContourColor?: string;
}

export interface ParametricCurveSpec extends BaseEquationSpec {
  kind: 'parametric_curve';
  tDomain: Domain1D;
  tubeRadius: number;
  renderAsTube: boolean;
}

export interface ParametricSurfaceSpec extends BaseEquationSpec {
  kind: 'parametric_surface';
  domain: Domain2D;
}

export interface ExplicitSurfaceSpec extends BaseEquationSpec {
  kind: 'explicit_surface';
  solvedAxis: Axis;
  domainAxes: [Axis, Axis];
  domain: Domain2D;
  compileAsParametric: true;
}

export interface ImplicitSurfaceSpec extends BaseEquationSpec {
  kind: 'implicit_surface';
  bounds: Bounds3D;
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
  enabled: boolean;
  direction: Vec3;
  color: string;
  intensity: number;
  castShadows: boolean;
}

export interface AmbientLightSettings {
  enabled: boolean;
  color: string;
  intensity: number;
}

export interface ShadowSettings {
  shadowMapResolution: number;
  shadowSoftness: number; // 0..1
}

export interface SceneSettings {
  cameraProjection: 'perspective' | 'orthographic';
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
  axisLabelsVisible: boolean;
  defaultGraphBounds: Bounds3D;
  ambient: AmbientLightSettings;
  directional: DirectionalLightSettings;
  shadow: ShadowSettings;
}

export interface RenderSettings {
  toneMapping: 'aces' | 'filmic' | 'none';
  exposure: number;
  interactiveQuality: 'performance' | 'balanced' | 'quality';
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

export interface MeshBounds {
  min: Vec3;
  max: Vec3;
  center: Vec3;
  radius: number;
}

export interface SerializedMeshTopology {
  isClosedManifold: boolean;
  hasBoundaryEdges: boolean;
  hasFeatureEdges: boolean;
  boundaryEdgeCount: number;
  featureEdgeCount: number;
}

export interface SerializedMesh {
  positions: Float32Array;
  indices: Uint32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  lines?: Float32Array[];
  curvePath?: Float32Array;
  curvePaths?: Float32Array[];
  bounds?: MeshBounds;
  boundaryEdges?: Float32Array;
  featureEdges?: Float32Array;
  topology?: SerializedMeshTopology;
}

export interface ParseClassifyResult {
  source: EquationSource;
  inferredKind: EquationObjectKind | 'unknown';
  parameterNames: string[];
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
  backend: 'webgl2' | 'unsupported';
  webglReady: boolean;
  plotCount: number;
  pointLightCount: number;
  transparentPlotCount: number;
  frameTimeMs: number;
  fps: number;
  shadowMapResolution: number;
  shadowAtlasUsage: number;
  opaqueShadowCasters: number;
  transmittanceShadowCasters: number;
  pointShadowCount: number;
  activeProbeCount: number;
  outlineMode: 'screen_space_edges' | 'object_mask' | 'disabled';
  reflectionSource: 'none' | 'environment' | 'probe';
  reflectionProbeRefreshCount: number;
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
