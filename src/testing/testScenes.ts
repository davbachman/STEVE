import type { ProjectFileV1, SceneObject } from '../types/contracts';
import {
  APP_VERSION,
  createDefaultImplicit,
  createDefaultSurface,
  createPointLight,
  defaultRenderSettings,
  defaultSceneSettings,
  materialPresets,
} from '../state/defaults';
import { analyzeEquationText } from '../math/classifier';

export type BuiltInTestSceneId = 'shadow-regression' | 'point-shadow-regression';

export function createBuiltInTestScene(id: BuiltInTestSceneId): ProjectFileV1 {
  switch (id) {
    case 'shadow-regression':
      return createShadowRegressionScene();
    case 'point-shadow-regression':
      return createPointShadowRegressionScene();
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
    gridShadowReceiverEnabled: true,
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
    gridShadowReceiverEnabled: true,
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
