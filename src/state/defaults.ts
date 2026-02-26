import { v4 as uuidv4 } from 'uuid';
import type {
  Bounds3D,
  MaterialParams,
  PlotObject,
  PointLightObject,
  RenderSettings,
  SceneSettings,
  SceneObject,
} from '../types/contracts';
import { analyzeEquationText } from '../math/classifier';

export const APP_VERSION = '0.1.0-dev';

export const defaultBounds: Bounds3D = {
  min: { x: -5, y: -5, z: -5 },
  max: { x: 5, y: 5, z: 5 },
};

export const materialPresets: Record<string, MaterialParams> = {
  'Matte Plastic': {
    baseColor: '#4ea1ff',
    opacity: 1,
    transmission: 0,
    ior: 1.5,
    reflectiveness: 0.08,
    roughness: 0.7,
    presetName: 'Matte Plastic',
    wireframeVisible: false,
    wireframeCellSize: 4,
  },
  'Glossy Plastic': {
    baseColor: '#ff7a59',
    opacity: 1,
    transmission: 0,
    ior: 1.5,
    reflectiveness: 0.18,
    roughness: 0.25,
    presetName: 'Glossy Plastic',
    wireframeVisible: false,
    wireframeCellSize: 4,
  },
  Ceramic: {
    baseColor: '#f1f1ea',
    opacity: 1,
    transmission: 0,
    ior: 1.52,
    reflectiveness: 0.12,
    roughness: 0.35,
    presetName: 'Ceramic',
    wireframeVisible: false,
    wireframeCellSize: 4,
  },
  'Brushed Metal': {
    baseColor: '#9fa8b3',
    opacity: 1,
    transmission: 0,
    ior: 1.45,
    reflectiveness: 0.8,
    roughness: 0.35,
    presetName: 'Brushed Metal',
    wireframeVisible: false,
    wireframeCellSize: 4,
  },
  Chrome: {
    baseColor: '#dce3ea',
    opacity: 1,
    transmission: 0,
    ior: 1.4,
    reflectiveness: 1,
    roughness: 0.05,
    presetName: 'Chrome',
    wireframeVisible: false,
    wireframeCellSize: 4,
  },
  'Clear Glass': {
    baseColor: '#cbe8ff',
    opacity: 0.2,
    transmission: 0.95,
    ior: 1.52,
    reflectiveness: 0.4,
    roughness: 0.02,
    presetName: 'Clear Glass',
    wireframeVisible: false,
    wireframeCellSize: 4,
  },
  'Frosted Glass': {
    baseColor: '#d8f0ff',
    opacity: 0.35,
    transmission: 0.9,
    ior: 1.45,
    reflectiveness: 0.3,
    roughness: 0.55,
    presetName: 'Frosted Glass',
    wireframeVisible: false,
    wireframeCellSize: 4,
  },
  'Tinted Glass': {
    baseColor: '#60c2a2',
    opacity: 0.35,
    transmission: 0.85,
    ior: 1.5,
    reflectiveness: 0.35,
    roughness: 0.15,
    presetName: 'Tinted Glass',
    wireframeVisible: false,
    wireframeCellSize: 4,
  },
  Rubber: {
    baseColor: '#2b2b2b',
    opacity: 1,
    transmission: 0,
    ior: 1.4,
    reflectiveness: 0.02,
    roughness: 0.9,
    presetName: 'Rubber',
    wireframeVisible: false,
    wireframeCellSize: 4,
  },
  Mirror: {
    baseColor: '#ffffff',
    opacity: 1,
    transmission: 0,
    ior: 1.4,
    reflectiveness: 1,
    roughness: 0,
    presetName: 'Mirror',
    wireframeVisible: false,
    wireframeCellSize: 4,
  },
};

export const defaultMaterial = (): MaterialParams => ({ ...materialPresets['Glossy Plastic'] });

export const defaultSceneSettings = (): SceneSettings => ({
  backgroundMode: 'gradient',
  backgroundColor: '#0f172a',
  gradientTopColor: '#1f2940',
  gradientBottomColor: '#0a0d14',
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
  axesLabelsVisible: false,
  defaultGraphBounds: structuredClone(defaultBounds),
  ambient: { color: '#ffffff', intensity: 0.35 },
  directional: {
    direction: { x: -0.6, y: -0.4, z: -1 },
    color: '#fff7ed',
    intensity: 1.2,
    castShadows: true,
  },
  shadow: {
    directionalShadowEnabled: true,
    pointShadowMode: 'auto',
    pointShadowMaxLights: 2,
    shadowMapResolution: 2048,
    shadowSoftness: 0.6,
  },
});

export const defaultRenderSettings = (): RenderSettings => ({
  mode: 'interactive',
  toneMapping: 'aces',
  exposure: 1,
  interactiveQuality: 'balanced',
  qualityRenderer: 'taa_preview',
  qualitySamplesTarget: 256,
  qualityResolutionScale: 1,
  qualityMaxBounces: 4,
  qualityClampFireflies: true,
  qualityEarlyExportBehavior: 'wait',
  denoise: false,
  qualityRunning: false,
  qualityCurrentSamples: 0,
  showDiagnostics: false,
});

function analyzedSource(rawText: string) {
  return analyzeEquationText(rawText).source;
}

export function createDefaultCurve(name = 'Curve'): PlotObject {
  const rawText = '(cos(t), sin(t), 0.2*t)';
  return {
    id: uuidv4(),
    name,
    type: 'plot',
    visible: true,
    transform: { position: { x: 0, y: 0, z: 0 } },
    equation: {
      kind: 'parametric_curve',
      source: analyzedSource(rawText),
      tDomain: { min: -12, max: 12, samples: 220 },
      tubeRadius: 0.06,
      renderAsTube: true,
    },
    material: { ...materialPresets['Chrome'] },
  };
}

export function createDefaultSurface(name = 'Surface'): PlotObject {
  const rawText = '(u*cos(v), u*sin(v), 0.7*sin(2*u)+0.15*v)';
  return {
    id: uuidv4(),
    name,
    type: 'plot',
    visible: true,
    transform: { position: { x: 0, y: 0, z: 0 } },
    equation: {
      kind: 'parametric_surface',
      source: analyzedSource(rawText),
      domain: { uMin: -2, uMax: 2, vMin: -3.14, vMax: 3.14, uSamples: 60, vSamples: 80 },
    },
    material: { ...materialPresets['Glossy Plastic'], baseColor: '#4ea1ff' },
  };
}

export function createDefaultImplicit(name = 'Implicit'): PlotObject {
  const rawText = 'x^2 + y^2 + z^2 = 4';
  return {
    id: uuidv4(),
    name,
    type: 'plot',
    visible: true,
    transform: { position: { x: 0, y: 0, z: 2.2 } },
    equation: {
      kind: 'implicit_surface',
      source: analyzedSource(rawText),
      bounds: structuredClone(defaultBounds),
      isoValue: 0,
      quality: 'draft',
    },
    material: { ...materialPresets['Glossy Plastic'] },
  };
}

export function createBlankPlot(name = 'Plot'): PlotObject {
  const rawText = 'z = sin(x*y)';
  return {
    id: uuidv4(),
    name,
    type: 'plot',
    visible: true,
    transform: { position: { x: 0, y: 0, z: 0 } },
    equation: {
      kind: 'explicit_surface',
      source: analyzedSource(rawText),
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
  };
}

export function createDefaultObjects(): SceneObject[] {
  return [createDefaultSurface('Ribbon Surface'), createDefaultCurve('Helix'), createPointLight('Warm Fill')];
}
