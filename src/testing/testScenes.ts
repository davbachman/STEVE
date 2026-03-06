import type { ProjectFileV1, SceneObject } from '../types/contracts';
import {
  APP_VERSION,
  createDefaultCurve,
  createDefaultImplicit,
  createDefaultSurface,
  createPointLight,
  defaultRenderSettings,
  defaultSceneSettings,
  materialPresets,
} from '../state/defaults';
import { analyzeEquationText } from '../math/classifier';

export type BuiltInTestSceneId = 'shadow-regression' | 'point-shadow-regression' | 'phase5b-path-mixed-geometry';

export function createBuiltInTestScene(id: BuiltInTestSceneId): ProjectFileV1 {
  switch (id) {
    case 'shadow-regression':
      return createShadowRegressionScene();
    case 'point-shadow-regression':
      return createPointShadowRegressionScene();
    case 'phase5b-path-mixed-geometry':
      return createPhase5BPathMixedGeometryScene();
    default:
      return createShadowRegressionScene();
  }
}

function createShadowRegressionScene(): ProjectFileV1 {
  const ribbon = createDefaultSurface('Shadow Ribbon');
  ribbon.transform.position = { x: -1.6, y: -0.8, z: 1.2 };
  ribbon.material = {
    ...materialPresets['Matte Plastic'],
    baseColor: '#b7795b',
    roughness: 0.62,
    reflectiveness: 0.04,
  };
  if (ribbon.equation.kind === 'parametric_surface') {
    ribbon.equation.domain = {
      uMin: -1.8,
      uMax: 1.8,
      vMin: -2.4,
      vMax: 2.4,
      uSamples: 64,
      vSamples: 88,
    };
  }

  const sphere = createDefaultImplicit('Shadow Sphere');
  sphere.transform.position = { x: 2.25, y: 1.5, z: 1.75 };
  sphere.material = {
    ...materialPresets.Ceramic,
    baseColor: '#ece9e2',
    roughness: 0.22,
    reflectiveness: 0.12,
  };
  if (sphere.equation.kind === 'implicit_surface') {
    sphere.equation.source = analyzeEquationText('x^2 + y^2 + z^2 = 1.8^2').source;
    sphere.equation.quality = 'medium';
    sphere.equation.bounds = {
      min: { x: -2.4, y: -2.4, z: -2.4 },
      max: { x: 2.4, y: 2.4, z: 2.4 },
    };
  }

  const key = createPointLight('Key Light', { x: 4.8, y: -4.2, z: 5.4 });
  key.color = '#ffd7a8';
  key.intensity = 46;
  key.range = 50;
  key.castShadows = true;

  const fill = createPointLight('Cool Fill', { x: -5.8, y: 3.8, z: 4.2 });
  fill.color = '#a8d4ff';
  fill.intensity = 18;
  fill.range = 40;
  fill.castShadows = false;

  const scene = defaultSceneSettings();
  scene.backgroundMode = 'gradient';
  scene.gradientTopColor = '#d7dbef';
  scene.gradientBottomColor = '#bfc4e7';
  scene.backgroundColor = '#c8cceb';
  scene.groundPlaneVisible = false;
  scene.gridVisible = true;
  scene.gridExtent = 12;
  scene.gridSpacing = 1;
  scene.gridLineOpacity = 0.55;
  scene.axesVisible = false;
  scene.ambient = { color: '#fff7ef', intensity: 0.06 };
  scene.directional = {
    direction: { x: -0.5, y: 0.25, z: -1.0 },
    color: '#fff6ea',
    intensity: 2.1,
    castShadows: true,
  };
  scene.shadow = {
    directionalShadowEnabled: true,
    pointShadowMode: 'off',
    pointShadowMaxLights: 2,
    shadowMapResolution: 2048,
    shadowSoftness: 0.55,
  };
  scene.defaultGraphBounds = {
    min: { x: -8, y: -8, z: -4 },
    max: { x: 8, y: 8, z: 8 },
  };

  const render = defaultRenderSettings();
  render.mode = 'interactive';
  render.toneMapping = 'aces';
  render.exposure = 1.05;
  render.interactiveQuality = 'quality';
  render.showDiagnostics = false;
  render.qualityCurrentSamples = 0;
  render.qualityRunning = false;

  const objects: SceneObject[] = [ribbon, sphere, key, fill];

  return {
    schemaVersion: 1,
    appVersion: APP_VERSION,
    scene,
    render,
    objects,
  };
}

function createPointShadowRegressionScene(): ProjectFileV1 {
  const project = createShadowRegressionScene();

  project.scene.directional = {
    ...project.scene.directional,
    intensity: 0.18,
    castShadows: false,
  };
  project.scene.shadow = {
    ...project.scene.shadow,
    directionalShadowEnabled: false,
    pointShadowMode: 'on',
    pointShadowMaxLights: 1,
    shadowMapResolution: 1536,
    shadowSoftness: 0.4,
  };
  project.scene.ambient = { color: '#fff8f0', intensity: 0.03 };
  project.render = {
    ...project.render,
    interactiveQuality: 'quality',
    showDiagnostics: false,
  };

  const pointLights = project.objects.filter((obj) => obj.type === 'point_light');
  const key = pointLights[0];
  const fill = pointLights[1];
  if (key && key.type === 'point_light') {
    key.name = 'Point Shadow Key';
    key.position = { x: 4.2, y: -1.8, z: 4.2 };
    key.color = '#ffd1a1';
    key.intensity = 52;
    key.range = 42;
    key.castShadows = true;
  }
  if (fill && fill.type === 'point_light') {
    fill.name = 'Point Shadow Fill';
    fill.position = { x: -6, y: 4, z: 4.6 };
    fill.intensity = 8;
    fill.castShadows = false;
  }

  for (const obj of project.objects) {
    if (obj.type !== 'plot') continue;
    if (obj.name.includes('Shadow Ribbon')) {
      obj.transform.position = { x: -2.0, y: -1.0, z: 1.35 };
      obj.material = {
        ...obj.material,
        baseColor: '#c07b5c',
        roughness: 0.58,
      };
      if (obj.equation.kind === 'parametric_surface') {
        obj.equation.domain = {
          uMin: -1.6,
          uMax: 1.6,
          vMin: -2.2,
          vMax: 2.2,
          uSamples: 62,
          vSamples: 84,
        };
      }
    }
    if (obj.name.includes('Shadow Sphere')) {
      obj.transform.position = { x: 1.8, y: 1.4, z: 1.55 };
      obj.material = {
        ...obj.material,
        baseColor: '#edeae4',
        roughness: 0.2,
        reflectiveness: 0.1,
      };
    }
  }

  return project;
}

function createPhase5BPathMixedGeometryScene(): ProjectFileV1 {
  const glassSheet = createDefaultSurface('Glass Sheet');
  glassSheet.transform.position = { x: 0, y: 0, z: 0.9 };
  glassSheet.material = {
    ...materialPresets['Tinted Glass'],
    baseColor: '#78d4bd',
    opacity: 0.28,
    reflectiveness: 0.42,
    roughness: 0.12,
  };
  if (glassSheet.equation.kind === 'parametric_surface') {
    glassSheet.equation.source = analyzeEquationText('(u, v, 0.22*sin(1.3*u)*cos(1.1*v))').source;
    glassSheet.equation.domain = {
      uMin: -3.2,
      uMax: 3.2,
      vMin: -3.2,
      vMax: 3.2,
      uSamples: 86,
      vSamples: 86,
    };
  }

  const lineCurve = createDefaultCurve('Line Curve (No Tube)');
  lineCurve.transform.position = { x: 0, y: 0, z: 0.8 };
  lineCurve.material = {
    ...materialPresets.Chrome,
    baseColor: '#f8efe2',
    roughness: 0.04,
    reflectiveness: 0.96,
  };
  if (lineCurve.equation.kind === 'parametric_curve') {
    lineCurve.equation.renderAsTube = false;
    lineCurve.equation.tDomain = { min: -8.5, max: 8.5, samples: 520 };
    lineCurve.equation.source = analyzeEquationText(
      '(2.6*cos(1.2*t), 2.2*sin(2.0*t), 0.55*sin(3.0*t) + 0.18*t)',
    ).source;
  }

  const backdrop = createDefaultImplicit('Refraction Target');
  backdrop.transform.position = { x: 0, y: 0, z: 1.8 };
  backdrop.material = {
    ...materialPresets.Ceramic,
    baseColor: '#f2eee7',
    roughness: 0.2,
    reflectiveness: 0.12,
  };
  if (backdrop.equation.kind === 'implicit_surface') {
    backdrop.equation.source = analyzeEquationText('x^2 + (y*0.85)^2 + (z-0.2)^2 = 1.4^2').source;
    backdrop.equation.quality = 'draft';
    backdrop.equation.bounds = {
      min: { x: -2.3, y: -2.3, z: -1.8 },
      max: { x: 2.3, y: 2.3, z: 2.8 },
    };
  }

  const key = createPointLight('Warm Key', { x: 4.2, y: -4.4, z: 5.1 });
  key.color = '#ffd2ab';
  key.intensity = 34;
  key.range = 36;
  key.castShadows = true;

  const rim = createPointLight('Cool Rim', { x: -4.8, y: 4.1, z: 3.6 });
  rim.color = '#9fd6ff';
  rim.intensity = 11;
  rim.range = 28;
  rim.castShadows = false;

  const scene = defaultSceneSettings();
  scene.backgroundMode = 'gradient';
  scene.gradientTopColor = '#111827';
  scene.gradientBottomColor = '#06080e';
  scene.backgroundColor = '#0b1020';
  scene.ambient = { color: '#e9f2ff', intensity: 0.04 };
  scene.directional = {
    direction: { x: -0.55, y: 0.25, z: -1 },
    color: '#fff4e9',
    intensity: 1.5,
    castShadows: true,
  };
  scene.groundPlaneVisible = true;
  scene.gridVisible = false;
  scene.axesVisible = false;
  scene.shadow = {
    directionalShadowEnabled: true,
    pointShadowMode: 'auto',
    pointShadowMaxLights: 1,
    shadowMapResolution: 1536,
    shadowSoftness: 0.45,
  };
  scene.defaultGraphBounds = {
    min: { x: -6, y: -6, z: -3 },
    max: { x: 6, y: 6, z: 7 },
  };

  const render = defaultRenderSettings();
  render.mode = 'quality';
  render.qualityRenderer = 'path';
  render.qualitySamplesTarget = 12;
  render.qualityResolutionScale = 0.5;
  render.qualityMaxBounces = 4;
  render.qualityClampFireflies = true;
  render.toneMapping = 'aces';
  render.exposure = 1.02;
  render.showDiagnostics = true;
  render.qualityCurrentSamples = 0;
  render.qualityRunning = false;

  const objects: SceneObject[] = [glassSheet, lineCurve, backdrop, key, rim];

  return {
    schemaVersion: 1,
    appVersion: APP_VERSION,
    scene,
    render,
    objects,
  };
}
