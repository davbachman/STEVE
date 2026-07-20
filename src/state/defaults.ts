import { v4 as uuidv4 } from 'uuid';
import type {
  Bounds3D,
  IntersectionObject,
  MaterialParams,
  PlotObject,
  PointLightObject,
  DirectionalLightObject,
  RenderSettings,
  SceneSettings,
  SceneObject,
} from '../types/contracts';
import { analyzeEquationText, analyzeGraphExpression } from '../math/classifier';
import { DEFAULT_PARAMETER_ANIMATION_SPEED, syncEquationParameters } from '../math/parameters';

export const APP_VERSION = '0.1.0-dev';
export const DEFAULT_TURNTABLE_SPEED = 20;
export const MIN_TURNTABLE_SPEED = 1;
export const MAX_TURNTABLE_SPEED = 90;

export const defaultBounds: Bounds3D = {
  min: { x: -5, y: -5, z: -5 },
  max: { x: 5, y: 5, z: 5 },
};

export const materialPresets: Record<string, MaterialParams> = {
  'Matte Plastic': {
    baseColor: '#4ea1ff',
    opacity: 1,
    reflectiveness: 0.05,
    roughness: 0.78,
    refractionEnabled: false,
    ior: 1.45,
    presetName: 'Matte Plastic',
    wireframeVisible: false,
    wireframeCellSize: 4,
    wireframeColor: '#000000',
    xContoursVisible: false,
    xContourSpacing: 1,
    xContourColor: '#000000',
    yContoursVisible: false,
    yContourSpacing: 1,
    yContourColor: '#000000',
    zContoursVisible: false,
    zContourSpacing: 1,
    zContourColor: '#000000',
  },
  'Glossy Plastic': {
    baseColor: '#ff7a59',
    opacity: 1,
    reflectiveness: 0.14,
    roughness: 0.2,
    refractionEnabled: false,
    ior: 1.45,
    presetName: 'Glossy Plastic',
    wireframeVisible: false,
    wireframeCellSize: 4,
    wireframeColor: '#000000',
    xContoursVisible: false,
    xContourSpacing: 1,
    xContourColor: '#000000',
    yContoursVisible: false,
    yContourSpacing: 1,
    yContourColor: '#000000',
    zContoursVisible: false,
    zContourSpacing: 1,
    zContourColor: '#000000',
  },
  Ceramic: {
    baseColor: '#f1f1ea',
    opacity: 1,
    reflectiveness: 0.18,
    roughness: 0.28,
    refractionEnabled: false,
    ior: 1.45,
    presetName: 'Ceramic',
    wireframeVisible: false,
    wireframeCellSize: 4,
    wireframeColor: '#000000',
    xContoursVisible: false,
    xContourSpacing: 1,
    xContourColor: '#000000',
    yContoursVisible: false,
    yContourSpacing: 1,
    yContourColor: '#000000',
    zContoursVisible: false,
    zContourSpacing: 1,
    zContourColor: '#000000',
  },
  'Brushed Metal': {
    baseColor: '#9fa8b3',
    opacity: 1,
    reflectiveness: 0.92,
    roughness: 0.28,
    refractionEnabled: false,
    ior: 1.45,
    presetName: 'Brushed Metal',
    wireframeVisible: false,
    wireframeCellSize: 4,
    wireframeColor: '#000000',
    xContoursVisible: false,
    xContourSpacing: 1,
    xContourColor: '#000000',
    yContoursVisible: false,
    yContourSpacing: 1,
    yContourColor: '#000000',
    zContoursVisible: false,
    zContourSpacing: 1,
    zContourColor: '#000000',
  },
  Chrome: {
    baseColor: '#dce3ea',
    opacity: 1,
    reflectiveness: 1,
    roughness: 0.03,
    refractionEnabled: false,
    ior: 1.45,
    presetName: 'Chrome',
    wireframeVisible: false,
    wireframeCellSize: 4,
    wireframeColor: '#000000',
    xContoursVisible: false,
    xContourSpacing: 1,
    xContourColor: '#000000',
    yContoursVisible: false,
    yContourSpacing: 1,
    yContourColor: '#000000',
    zContoursVisible: false,
    zContourSpacing: 1,
    zContourColor: '#000000',
  },
  'Clear Glass': {
    baseColor: '#cbe8ff',
    opacity: 0.26,
    reflectiveness: 0.48,
    roughness: 0.03,
    refractionEnabled: true,
    ior: 1.45,
    presetName: 'Clear Glass',
    wireframeVisible: false,
    wireframeCellSize: 4,
    wireframeColor: '#000000',
    xContoursVisible: false,
    xContourSpacing: 1,
    xContourColor: '#000000',
    yContoursVisible: false,
    yContourSpacing: 1,
    yContourColor: '#000000',
    zContoursVisible: false,
    zContourSpacing: 1,
    zContourColor: '#000000',
  },
  'Frosted Glass': {
    baseColor: '#d8f0ff',
    opacity: 0.4,
    reflectiveness: 0.36,
    roughness: 0.5,
    refractionEnabled: true,
    ior: 1.4,
    presetName: 'Frosted Glass',
    wireframeVisible: false,
    wireframeCellSize: 4,
    wireframeColor: '#000000',
    xContoursVisible: false,
    xContourSpacing: 1,
    xContourColor: '#000000',
    yContoursVisible: false,
    yContourSpacing: 1,
    yContourColor: '#000000',
    zContoursVisible: false,
    zContourSpacing: 1,
    zContourColor: '#000000',
  },
  'Tinted Glass': {
    baseColor: '#60c2a2',
    opacity: 0.42,
    reflectiveness: 0.4,
    roughness: 0.18,
    refractionEnabled: true,
    ior: 1.4,
    presetName: 'Tinted Glass',
    wireframeVisible: false,
    wireframeCellSize: 4,
    wireframeColor: '#000000',
    xContoursVisible: false,
    xContourSpacing: 1,
    xContourColor: '#000000',
    yContoursVisible: false,
    yContourSpacing: 1,
    yContourColor: '#000000',
    zContoursVisible: false,
    zContourSpacing: 1,
    zContourColor: '#000000',
  },
  Rubber: {
    baseColor: '#2b2b2b',
    opacity: 1,
    reflectiveness: 0.02,
    roughness: 0.9,
    refractionEnabled: false,
    ior: 1.45,
    presetName: 'Rubber',
    wireframeVisible: false,
    wireframeCellSize: 4,
    wireframeColor: '#000000',
    xContoursVisible: false,
    xContourSpacing: 1,
    xContourColor: '#000000',
    yContoursVisible: false,
    yContourSpacing: 1,
    yContourColor: '#000000',
    zContoursVisible: false,
    zContourSpacing: 1,
    zContourColor: '#000000',
  },
  Mirror: {
    baseColor: '#ffffff',
    opacity: 1,
    reflectiveness: 1,
    roughness: 0,
    refractionEnabled: false,
    ior: 1.45,
    presetName: 'Mirror',
    wireframeVisible: false,
    wireframeCellSize: 4,
    wireframeColor: '#000000',
    xContoursVisible: false,
    xContourSpacing: 1,
    xContourColor: '#000000',
    yContoursVisible: false,
    yContourSpacing: 1,
    yContourColor: '#000000',
    zContoursVisible: false,
    zContourSpacing: 1,
    zContourColor: '#000000',
  },
};

export const defaultMaterial = (): MaterialParams => ({ ...materialPresets['Glossy Plastic'] });

export const defaultSceneSettings = (): SceneSettings => ({
  cameraProjection: 'perspective',
  turntableEnabled: false,
  turntableSpeed: DEFAULT_TURNTABLE_SPEED,
  backgroundMode: 'gradient',
  backgroundColor: '#0f172a',
  gradientTopColor: '#263652',
  gradientBottomColor: '#090d15',
  groundPlaneVisible: false,
  groundPlaneSize: 16,
  groundPlaneColor: '#f5f0e8',
  groundPlaneRoughness: 0.35,
  groundPlaneReflective: false,
  gridVisible: true,
  gridExtent: 10,
  gridSpacing: 1,
  gridLineOpacity: 0.6,
  axesVisible: true,
  axesLength: 6,
  axisLabelsVisible: false,
  defaultGraphBounds: structuredClone(defaultBounds),
  ambient: { enabled: true, color: '#eef4ff', intensity: 0.22 },
  directional: {
    enabled: false,
    direction: { x: -0.6, y: -0.4, z: -1 },
    color: '#fff2df',
    intensity: 1.35,
    castShadows: true,
  },
  shadow: {
    shadowMapResolution: 2048,
    shadowSoftness: 0.6,
  },
});

export const defaultRenderSettings = (): RenderSettings => ({
  toneMapping: 'aces',
  exposure: 1,
  bloomEnabled: true,
  bloomStrength: 0.65,
  bloomRadius: 1.5,
  bloomThreshold: 1,
  interactiveQuality: 'balanced',
  gifMaxDimension: 720,
  gifFrameRate: 20,
});

function analyzedEquation(rawText: string) {
  const analyzed = analyzeEquationText(rawText);
  return {
    source: analyzed.source,
    parameters: syncEquationParameters(analyzed.parameterNames),
  };
}

function analyzedGraph(rawText: string) {
  const analyzed = analyzeGraphExpression(rawText);
  return {
    source: analyzed.source,
    parameters: syncEquationParameters(analyzed.parameterNames),
  };
}

export function createDefaultCurve(name = 'Curve'): PlotObject {
  const rawText = '(cos(t), sin(t), 0.2*t)';
  const equationMeta = analyzedEquation(rawText);
  return {
    id: uuidv4(),
    name,
    type: 'plot',
    visible: true,
    transform: { position: { x: 0, y: 0, z: 0 } },
    equation: {
      kind: 'parametric_curve',
      ...equationMeta,
      tDomain: { min: -12, max: 12, samples: 220 },
      tubeRadius: 0.06,
      renderAsTube: true,
    },
    material: { ...materialPresets['Chrome'] },
  };
}

export function createDefaultIntersection(name = 'Intersection'): IntersectionObject {
  return {
    id: uuidv4(),
    name,
    type: 'intersection',
    visible: true,
    transform: { position: { x: 0, y: 0, z: 0 } },
    material: { ...materialPresets['Chrome'] },
    sourceSurfaceIds: [null, null],
    curveStyle: {
      tubeRadius: 0.06,
      renderAsTube: true,
    },
  };
}

export function createDefaultSurface(name = 'Surface'): PlotObject {
  const rawText = '((2 + 0.7*cos(v))*cos(u), (2 + 0.7*cos(v))*sin(u), 0.7*sin(v))';
  const equationMeta = analyzedEquation(rawText);
  return {
    id: uuidv4(),
    name,
    type: 'plot',
    visible: true,
    transform: { position: { x: 0, y: 0, z: 0 } },
    equation: {
      kind: 'parametric_surface',
      ...equationMeta,
      domain: { uMin: -Math.PI, uMax: Math.PI, vMin: -Math.PI, vMax: Math.PI, uSamples: 80, vSamples: 48 },
    },
    material: { ...materialPresets['Glossy Plastic'], baseColor: '#4ea1ff' },
  };
}

export function createDefaultGraph(name = 'Graph'): PlotObject {
  const rawText = 'x^2 - y^2';
  const equationMeta = analyzedGraph(rawText);
  return {
    id: uuidv4(),
    name,
    type: 'plot',
    visible: true,
    transform: { position: { x: 0, y: 0, z: 0 } },
    equation: {
      kind: 'explicit_surface',
      graphExpression: true,
      ...equationMeta,
      solvedAxis: 'z',
      domainAxes: ['x', 'y'],
      domain: { uMin: -4, uMax: 4, vMin: -4, vMax: 4, uSamples: 80, vSamples: 80 },
      compileAsParametric: true,
    },
    material: defaultMaterial(),
  };
}

export function createDefaultImplicit(name = 'Implicit'): PlotObject {
  const rawText = 'x^2 + y^2 + z^2 = 4';
  const equationMeta = analyzedEquation(rawText);
  return {
    id: uuidv4(),
    name,
    type: 'plot',
    visible: true,
    transform: { position: { x: 0, y: 0, z: 0 } },
    equation: {
      kind: 'implicit_surface',
      ...equationMeta,
      bounds: structuredClone(defaultBounds),
      quality: 'high',
    },
    material: { ...materialPresets['Glossy Plastic'] },
  };
}

export function createBlankPlot(name = 'Surface'): PlotObject {
  const rawText = 'z = sin(x*y)';
  const equationMeta = analyzedEquation(rawText);
  return {
    id: uuidv4(),
    name,
    type: 'plot',
    visible: true,
    transform: { position: { x: 0, y: 0, z: 0 } },
    equation: {
      kind: 'explicit_surface',
      ...equationMeta,
      solvedAxis: 'z',
      domainAxes: ['x', 'y'],
      domain: { uMin: -4, uMax: 4, vMin: -4, vMax: 4, uSamples: 80, vSamples: 80 },
      compileAsParametric: true,
    },
    material: defaultMaterial(),
  };
}

export function createPointLight(name = 'Point Light', position = { x: 3, y: -3, z: 5 }): PointLightObject {
  return {
    id: uuidv4(),
    name,
    type: 'point_light',
    visible: true,
    position,
    color: '#ffdcb3',
    intensity: 40,
    range: 40,
    castShadows: true,
    curvePin: createDefaultLightCurvePin(),
  };
}

export function createDirectionalLight(
  name = 'Directional Light',
  position = { x: 3, y: -3, z: 5 },
): DirectionalLightObject {
  return {
    id: uuidv4(),
    name,
    type: 'directional_light',
    visible: true,
    position,
    direction: directionTowardOrigin(position),
    color: '#fff2df',
    intensity: 1.35,
    castShadows: true,
    curvePin: createDefaultLightCurvePin(),
  };
}

function createDefaultLightCurvePin() {
  return {
    enabled: false,
    curveId: null,
    parameterValue: 0,
    animating: false,
    animationSpeed: DEFAULT_PARAMETER_ANIMATION_SPEED,
  };
}

export function directionTowardOrigin(position: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const length = Math.hypot(position.x, position.y, position.z);
  if (!Number.isFinite(length) || length < 1e-6) {
    return { x: 0, y: 0, z: -1 };
  }
  return {
    x: -position.x / length,
    y: -position.y / length,
    z: -position.z / length,
  };
}

export function createDefaultObjects(): SceneObject[] {
  const directional = createDirectionalLight('Directional Light 1');
  directional.visible = false;
  return [directional];
}
