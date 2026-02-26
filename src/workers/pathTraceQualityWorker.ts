/// <reference lib="webworker" />

import { Ray, Vector3 } from '@babylonjs/core';
import type {
  PathTraceWorkerLight,
  PathTraceWorkerLineAccel,
  PathTraceWorkerRequest,
  PathTraceWorkerResponse,
  PathTraceWorkerSceneSnapshot,
  PathTraceWorkerTriangleAccel,
  PathTraceWorkerTriangleBvhNode,
  PathTraceWorkerVec3,
} from './pathTraceQualityWorkerContracts';

interface WorkerMeshEntry {
  meshIndex: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  material: WorkerMaterial;
  triangleAccel: PathTraceWorkerTriangleAccel | null;
  lineAccel: PathTraceWorkerLineAccel | null;
}

interface WorkerMaterial {
  baseColor: Vector3;
  metallic: number;
  roughness: number;
  reflectance: number;
  transmission: number;
  ior: number;
  opacity: number;
}

interface WorkerMeshBvhNode {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  left: WorkerMeshBvhNode | null;
  right: WorkerMeshBvhNode | null;
  items: WorkerMeshEntry[] | null;
}

interface WorkerHemisphericLight {
  kind: 'hemispheric';
  direction: Vector3;
  diffuse: Vector3;
  ground: Vector3;
  intensity: number;
}

interface WorkerDirectionalLight {
  kind: 'directional';
  direction: Vector3;
  diffuse: Vector3;
  intensity: number;
}

interface WorkerPointLight {
  kind: 'point';
  position: Vector3;
  diffuse: Vector3;
  intensity: number;
  range: number;
}

type WorkerLight = WorkerHemisphericLight | WorkerDirectionalLight | WorkerPointLight;

interface WorkerSceneState {
  version: number;
  clearColor: Vector3;
  ambientColor: Vector3;
  lights: WorkerLight[];
  meshes: WorkerMeshEntry[];
  meshBvhRoot: WorkerMeshBvhNode | null;
}

interface WorkerHit {
  distance: number;
  point: Vector3;
  normal: Vector3;
  meshIndex: number;
  material: WorkerMaterial;
}

interface WorkerBounceSample {
  direction: Vector3;
  throughput: Vector3;
  nextMediumIor: number;
  wasTransmission: boolean;
}

interface WorkerEnvironmentSample {
  radiance: Vector3;
  alpha: number;
}

interface TriangleHitResult {
  distance: number;
  point: Vector3;
  normal: Vector3;
}

interface LineHitResult {
  distance: number;
  point: Vector3;
  normal: Vector3;
}

const TRACE_MESH_BVH_LEAF_SIZE = 4;
const RAY_SEGMENT_INTERSECTION_RAY_LENGTH = 1_000_000_000;
const RAY_SEGMENT_INTERSECTION_SMALL_NUM = 1e-8;
const shadowRayScratchOrigin = new Vector3(0, 0, 0);
const shadowRayScratchDirection = new Vector3(0, 0, 1);
const shadowRayScratch = new Ray(shadowRayScratchOrigin, shadowRayScratchDirection, 1e6);
const environmentSampleScratch: WorkerEnvironmentSample = {
  radiance: new Vector3(0, 0, 0),
  alpha: 1,
};
const directLightingScratchOut = new Vector3(0, 0, 0);
const continuationBounceSampleScratch: WorkerBounceSample = {
  direction: new Vector3(0, 0, 1),
  throughput: new Vector3(1, 1, 1),
  nextMediumIor: 1,
  wasTransmission: false,
};
const continuationIncidentScratch = new Vector3(0, 0, 1);
const continuationInterfaceNormalScratch = new Vector3(0, 0, 1);
const continuationTangentScratch = new Vector3(1, 0, 0);
const continuationBitangentScratch = new Vector3(0, 1, 0);

let currentScene: WorkerSceneState | null = null;

self.onmessage = (event: MessageEvent<PathTraceWorkerRequest>) => {
  const req = event.data;
  if (req.type === 'dispose') {
    currentScene = null;
    return;
  }

  if (req.type === 'init_scene') {
    try {
      currentScene = buildWorkerScene(req.scene);
      const res: PathTraceWorkerResponse = { type: 'scene_ready', sceneVersion: req.scene.version };
      self.postMessage(res);
    } catch (error) {
      const res: PathTraceWorkerResponse = {
        type: 'scene_error',
        sceneVersion: req.scene.version,
        message: error instanceof Error ? error.message : 'path trace worker scene init failed',
      };
      self.postMessage(res);
    }
    return;
  }

  if (req.type === 'trace_batch') {
    try {
      if (!currentScene || currentScene.version !== req.sceneVersion) {
        const res: PathTraceWorkerResponse = {
          type: 'trace_batch_error',
          requestId: req.requestId,
          sceneVersion: req.sceneVersion,
          message: 'path trace worker scene version mismatch',
        };
        self.postMessage(res);
        return;
      }
      const pixelCount = req.pixelIndices.length;
      if (req.rays.length !== pixelCount * 6) {
        throw new Error('ray buffer length mismatch');
      }
      const samples = new Float32Array(pixelCount * 4);
      const maxBounces = clamp(Math.round(req.render.qualityMaxBounces), 1, 6);
      const rayOrigin = new Vector3(0, 0, 0);
      const rayDirection = new Vector3(0, 0, 1);
      const ray = new Ray(rayOrigin, rayDirection, 1e6);
      for (let i = 0; i < pixelCount; i += 1) {
        const rayBase = i * 6;
        rayOrigin.x = req.rays[rayBase];
        rayOrigin.y = req.rays[rayBase + 1];
        rayOrigin.z = req.rays[rayBase + 2];
        rayDirection.x = req.rays[rayBase + 3];
        rayDirection.y = req.rays[rayBase + 4];
        rayDirection.z = req.rays[rayBase + 5];
        const pixelIndex = req.pixelIndices[i];
        const outBase = i * 4;
        traceHybridRay(currentScene, ray, maxBounces, req.sampleIndex, pixelIndex, samples, outBase);
      }
      const res: PathTraceWorkerResponse = {
        type: 'trace_batch_result',
        requestId: req.requestId,
        sceneVersion: req.sceneVersion,
        samples,
      };
      self.postMessage(res, { transfer: [samples.buffer] });
    } catch (error) {
      const res: PathTraceWorkerResponse = {
        type: 'trace_batch_error',
        requestId: req.requestId,
        sceneVersion: req.sceneVersion,
        message: error instanceof Error ? error.message : 'path trace worker batch failed',
      };
      self.postMessage(res);
    }
  }
};

function buildWorkerScene(snapshot: PathTraceWorkerSceneSnapshot): WorkerSceneState {
  const meshes: WorkerMeshEntry[] = snapshot.meshes.map((mesh) => ({
    meshIndex: mesh.meshIndex,
    minX: mesh.minX,
    minY: mesh.minY,
    minZ: mesh.minZ,
    maxX: mesh.maxX,
    maxY: mesh.maxY,
    maxZ: mesh.maxZ,
    centerX: mesh.centerX,
    centerY: mesh.centerY,
    centerZ: mesh.centerZ,
    material: {
      baseColor: vecFromPlain(mesh.material.baseColor),
      metallic: mesh.material.metallic,
      roughness: mesh.material.roughness,
      reflectance: mesh.material.reflectance,
      transmission: mesh.material.transmission,
      ior: mesh.material.ior,
      opacity: mesh.material.opacity,
    },
    triangleAccel: mesh.triangleAccel,
    lineAccel: mesh.lineAccel,
  }));

  return {
    version: snapshot.version,
    clearColor: vecFromPlain(snapshot.clearColor),
    ambientColor: vecFromPlain(snapshot.ambientColor),
    lights: snapshot.lights.map(convertLight),
    meshBvhRoot: buildWorkerMeshBvh(meshes),
    meshes,
  };
}

function convertLight(light: PathTraceWorkerLight): WorkerLight {
  if (light.kind === 'hemispheric') {
    return {
      kind: 'hemispheric',
      direction: vecFromPlain(light.direction),
      diffuse: vecFromPlain(light.diffuse),
      ground: vecFromPlain(light.ground),
      intensity: light.intensity,
    };
  }
  if (light.kind === 'directional') {
    return {
      kind: 'directional',
      direction: vecFromPlain(light.direction),
      diffuse: vecFromPlain(light.diffuse),
      intensity: light.intensity,
    };
  }
  return {
    kind: 'point',
    position: vecFromPlain(light.position),
    diffuse: vecFromPlain(light.diffuse),
    intensity: light.intensity,
    range: light.range,
  };
}

function traceHybridRay(
  scene: WorkerSceneState,
  initialRay: Ray,
  maxBounces: number,
  sampleIndex: number,
  pixelIndex: number,
  samples: Float32Array,
  outBase: number,
): void {
  let ray = initialRay;
  let throughput = new Vector3(1, 1, 1);
  const radiance = new Vector3(0, 0, 0);
  const outwardNormal = new Vector3(0, 0, 1);
  const shadingNormal = new Vector3(0, 0, 1);
  const viewDir = new Vector3(0, 0, 1);
  let alpha = 0;
  let currentMediumIor = 1;
  let previousBounceWasTransmission = false;

  for (let bounce = 0; bounce < maxBounces; bounce += 1) {
    const hit = pickTraceRayClosest(scene, ray, -1);
    if (!hit) {
      const env = sampleHybridEnvironment(scene, ray.direction);
      radiance.x += throughput.x * env.radiance.x;
      radiance.y += throughput.y * env.radiance.y;
      radiance.z += throughput.z * env.radiance.z;
      if (bounce === 0) {
        alpha = env.alpha;
      }
      break;
    }
    alpha = 1;

    const hitPoint = hit.point;
    outwardNormal.x = hit.normal.x;
    outwardNormal.y = hit.normal.y;
    outwardNormal.z = hit.normal.z;
    if (outwardNormal.lengthSquared() < 1e-10) {
      outwardNormal.x = -ray.direction.x;
      outwardNormal.y = -ray.direction.y;
      outwardNormal.z = -ray.direction.z;
    }
    outwardNormal.normalize();
    const frontFace = Vector3.Dot(outwardNormal, ray.direction) < 0;
    shadingNormal.x = frontFace ? outwardNormal.x : -outwardNormal.x;
    shadingNormal.y = frontFace ? outwardNormal.y : -outwardNormal.y;
    shadingNormal.z = frontFace ? outwardNormal.z : -outwardNormal.z;

    viewDir.x = -ray.direction.x;
    viewDir.y = -ray.direction.y;
    viewDir.z = -ray.direction.z;
    if (viewDir.lengthSquared() > 1e-12) {
      viewDir.normalize();
    }
    const direct = sampleHybridDirectLighting(
      scene,
      hitPoint,
      shadingNormal,
      viewDir,
      hit.material,
      hit.meshIndex,
      sampleIndex,
      pixelIndex,
      bounce,
      previousBounceWasTransmission,
    );
    radiance.x += throughput.x * direct.x;
    radiance.y += throughput.y * direct.y;
    radiance.z += throughput.z * direct.z;

    if (bounce >= maxBounces - 1) {
      break;
    }

    const bounceSample = sampleHybridContinuation(
      ray.direction,
      outwardNormal,
      shadingNormal,
      frontFace,
      currentMediumIor,
      hit.material,
      sampleIndex,
      pixelIndex,
      bounce,
    );
    if (!bounceSample) {
      break;
    }

    multiplyVec3InPlace(throughput, bounceSample.throughput);
    currentMediumIor = bounceSample.nextMediumIor;
    previousBounceWasTransmission = bounceSample.wasTransmission;
    const rrStartBounce = 1;
    if (bounce >= rrStartBounce) {
      const continueProb = clamp(Math.max(throughput.x, throughput.y, throughput.z), 0.05, 0.95);
      if (sampleHash01(pixelIndex, sampleIndex + bounce * 13, 91) > continueProb) {
        break;
      }
      throughput.scaleInPlace(1 / continueProb);
    }

    ray.origin.x = hitPoint.x + bounceSample.direction.x * 0.0025;
    ray.origin.y = hitPoint.y + bounceSample.direction.y * 0.0025;
    ray.origin.z = hitPoint.z + bounceSample.direction.z * 0.0025;
    ray.direction.x = bounceSample.direction.x;
    ray.direction.y = bounceSample.direction.y;
    ray.direction.z = bounceSample.direction.z;
    ray.length = 1e6;
  }

  samples[outBase] = clampFinite(radiance.x);
  samples[outBase + 1] = clampFinite(radiance.y);
  samples[outBase + 2] = clampFinite(radiance.z);
  samples[outBase + 3] = alpha;
}

function sampleHybridEnvironment(scene: WorkerSceneState, direction: Vector3): WorkerEnvironmentSample {
  const dirLenSq = direction.lengthSquared();
  if (dirLenSq < 1e-10) {
    environmentSampleScratch.radiance.x = 0;
    environmentSampleScratch.radiance.y = 0;
    environmentSampleScratch.radiance.z = 0;
    environmentSampleScratch.alpha = 1;
    return environmentSampleScratch;
  }
  const invDirLen = 1 / Math.sqrt(dirLenSq);
  const dirX = direction.x * invDirLen;
  const dirY = direction.y * invDirLen;
  const dirZ = direction.z * invDirLen;

  let baseX = scene.clearColor.x + scene.ambientColor.x * 0.35;
  let baseY = scene.clearColor.y + scene.ambientColor.y * 0.35;
  let baseZ = scene.clearColor.z + scene.ambientColor.z * 0.35;
  const alpha = 1;

  for (const light of scene.lights) {
    if (light.kind !== 'hemispheric' || light.intensity <= 0) {
      continue;
    }
    const hemiLenSq = light.direction.lengthSquared();
    if (hemiLenSq < 1e-10) {
      continue;
    }
    const invHemiLen = 1 / Math.sqrt(hemiLenSq);
    const dot = dirX * light.direction.x * invHemiLen
      + dirY * light.direction.y * invHemiLen
      + dirZ * light.direction.z * invHemiLen;
    const t = clamp(0.5 + 0.5 * dot, 0, 1);
    const li = light.intensity;
    const skyX = light.diffuse.x * li;
    const skyY = light.diffuse.y * li;
    const skyZ = light.diffuse.z * li;
    const groundX = light.ground.x * li;
    const groundY = light.ground.y * li;
    const groundZ = light.ground.z * li;
    baseX += groundX + (skyX - groundX) * t;
    baseY += groundY + (skyY - groundY) * t;
    baseZ += groundZ + (skyZ - groundZ) * t;
  }

  environmentSampleScratch.radiance.x = clampFinite(baseX);
  environmentSampleScratch.radiance.y = clampFinite(baseY);
  environmentSampleScratch.radiance.z = clampFinite(baseZ);
  environmentSampleScratch.alpha = alpha;
  return environmentSampleScratch;
}

function sampleHybridDirectLighting(
  scene: WorkerSceneState,
  hitPoint: Vector3,
  normal: Vector3,
  viewDir: Vector3,
  material: WorkerMaterial,
  hitMeshIndex: number,
  sampleIndex: number,
  pixelIndex: number,
  bounce: number,
  previousBounceWasTransmission: boolean,
): Vector3 {
  const out = directLightingScratchOut;
  out.x = 0;
  out.y = 0;
  out.z = 0;
  const baseColor = material.baseColor;
  const diffuseWeight = clamp01Safe((1 - material.metallic) * (1 - material.transmission) * material.opacity);
  const specWeight = clamp01Safe(Math.max(material.reflectance, material.metallic));
  const specColorX = 1 + (baseColor.x - 1) * material.metallic;
  const specColorY = 1 + (baseColor.y - 1) * material.metallic;
  const specColorZ = 1 + (baseColor.z - 1) * material.metallic;
  const roughness = clamp(material.roughness, 0.03, 1);
  const shininess = clamp(Math.round((1 - roughness) * 180 + 8), 8, 256);

  const sampleFiniteDirectThisBounce = bounce === 0 || (bounce === 1 && previousBounceWasTransmission);
  const useSingleFiniteLightSample = sampleFiniteDirectThisBounce;
  let finiteLightCount = 0;
  if (useSingleFiniteLightSample) {
    for (const light of scene.lights) {
      if (light.intensity <= 0) continue;
      if (light.kind === 'directional' || light.kind === 'point') {
        finiteLightCount += 1;
      }
    }
  }
  const selectedFiniteLightIndex = useSingleFiniteLightSample && finiteLightCount > 0
    ? Math.min(
      finiteLightCount - 1,
      Math.floor(sampleHash01(pixelIndex, sampleIndex + bounce * 71, 151) * finiteLightCount),
    )
    : -1;
  const finiteLightWeight = useSingleFiniteLightSample && finiteLightCount > 0 ? finiteLightCount : 1;

  let dirIndex = 0;
  let pointIndex = 0;
  let finiteLightIndex = 0;

  for (const light of scene.lights) {
    if (light.intensity <= 0) continue;

    if (light.kind === 'hemispheric') {
      const hemiLenSq = light.direction.lengthSquared();
      if (hemiLenSq < 1e-10) continue;
      const invHemiLen = 1 / Math.sqrt(hemiLenSq);
      const t = clamp(
        0.5 + 0.5 * (
          normal.x * light.direction.x * invHemiLen
          + normal.y * light.direction.y * invHemiLen
          + normal.z * light.direction.z * invHemiLen
        ),
        0,
        1,
      );
      const li = light.intensity;
      const hemiX = (light.ground.x + (light.diffuse.x - light.ground.x) * t) * li;
      const hemiY = (light.ground.y + (light.diffuse.y - light.ground.y) * t) * li;
      const hemiZ = (light.ground.z + (light.diffuse.z - light.ground.z) * t) * li;
      out.x += hemiX * baseColor.x * diffuseWeight;
      out.y += hemiY * baseColor.y * diffuseWeight;
      out.z += hemiZ * baseColor.z * diffuseWeight;
      continue;
    }

    if (light.kind === 'directional') {
      if (!sampleFiniteDirectThisBounce) continue;
      const currentDirIndex = dirIndex;
      dirIndex += 1;
      const currentFiniteLightIndex = finiteLightIndex;
      finiteLightIndex += 1;
      if (useSingleFiniteLightSample && finiteLightCount > 1 && currentFiniteLightIndex !== selectedFiniteLightIndex) {
        continue;
      }
      const jitteredDir =
        computeJitteredDirectionalLightDirection(light.direction, sampleIndex + bounce * 31 + pixelIndex, currentDirIndex)
        ?? light.direction;
      const jitteredLenSq = jitteredDir.lengthSquared();
      if (jitteredLenSq < 1e-10) continue;
      const invJitteredLen = 1 / Math.sqrt(jitteredLenSq);
      const lightDirX = -jitteredDir.x * invJitteredLen;
      const lightDirY = -jitteredDir.y * invJitteredLen;
      const lightDirZ = -jitteredDir.z * invJitteredLen;
      const ndl = Math.max(0, normal.x * lightDirX + normal.y * lightDirY + normal.z * lightDirZ);
      if (ndl <= 0) continue;
      if (isShadowedDirectional(scene, hitPoint, normal, lightDirX, lightDirY, lightDirZ, hitMeshIndex)) {
        continue;
      }
      const halfX = lightDirX + viewDir.x;
      const halfY = lightDirY + viewDir.y;
      const halfZ = lightDirZ + viewDir.z;
      const halfLenSq = halfX * halfX + halfY * halfY + halfZ * halfZ;
      let specTerm = 0;
      if (specWeight > 0 && halfLenSq > 1e-12) {
        const invHalfLen = 1 / Math.sqrt(halfLenSq);
        const ndh = Math.max(0, normal.x * halfX * invHalfLen + normal.y * halfY * invHalfLen + normal.z * halfZ * invHalfLen);
        specTerm = Math.pow(ndh, shininess) * ndl;
      }
      const li = light.intensity * finiteLightWeight;
      const diffuseTerm = diffuseWeight * ndl;
      const specScale = specTerm * specWeight;
      out.x += light.diffuse.x * li * (baseColor.x * diffuseTerm + specColorX * specScale);
      out.y += light.diffuse.y * li * (baseColor.y * diffuseTerm + specColorY * specScale);
      out.z += light.diffuse.z * li * (baseColor.z * diffuseTerm + specColorZ * specScale);
      continue;
    }

    if (light.kind === 'point') {
      if (!sampleFiniteDirectThisBounce) continue;
      const currentPointIndex = pointIndex;
      pointIndex += 1;
      const currentFiniteLightIndex = finiteLightIndex;
      finiteLightIndex += 1;
      if (useSingleFiniteLightSample && finiteLightCount > 1 && currentFiniteLightIndex !== selectedFiniteLightIndex) {
        continue;
      }
      const samplePos = computeJitteredPointLightPosition(light, sampleIndex + bounce * 47 + pixelIndex, currentPointIndex) ?? light.position;
      const toLightX = samplePos.x - hitPoint.x;
      const toLightY = samplePos.y - hitPoint.y;
      const toLightZ = samplePos.z - hitPoint.z;
      const dist2 = toLightX * toLightX + toLightY * toLightY + toLightZ * toLightZ;
      if (dist2 <= 1e-8) continue;
      const dist = Math.sqrt(dist2);
      const invDist = 1 / dist;
      const lightDirX = toLightX * invDist;
      const lightDirY = toLightY * invDist;
      const lightDirZ = toLightZ * invDist;
      const ndl = Math.max(0, normal.x * lightDirX + normal.y * lightDirY + normal.z * lightDirZ);
      if (ndl <= 0) continue;
      if (isShadowedPoint(scene, hitPoint, normal, lightDirX, lightDirY, lightDirZ, dist, hitMeshIndex)) {
        continue;
      }
      const range = Number.isFinite(light.range) && light.range > 0 ? light.range : dist * 2;
      const rangeFalloff = clamp(1 - (dist / Math.max(range, 1e-3)) ** 2, 0, 1);
      const attenuation = rangeFalloff * rangeFalloff / (1 + dist2 * 0.03);
      if (attenuation <= 0) continue;
      const halfX = lightDirX + viewDir.x;
      const halfY = lightDirY + viewDir.y;
      const halfZ = lightDirZ + viewDir.z;
      const halfLenSq = halfX * halfX + halfY * halfY + halfZ * halfZ;
      let specTerm = 0;
      if (specWeight > 0 && halfLenSq > 1e-12) {
        const invHalfLen = 1 / Math.sqrt(halfLenSq);
        const ndh = Math.max(0, normal.x * halfX * invHalfLen + normal.y * halfY * invHalfLen + normal.z * halfZ * invHalfLen);
        specTerm = Math.pow(ndh, shininess) * ndl;
      }
      const li = light.intensity * attenuation * finiteLightWeight;
      const diffuseTerm = diffuseWeight * ndl;
      const specScale = specTerm * specWeight;
      out.x += light.diffuse.x * li * (baseColor.x * diffuseTerm + specColorX * specScale);
      out.y += light.diffuse.y * li * (baseColor.y * diffuseTerm + specColorY * specScale);
      out.z += light.diffuse.z * li * (baseColor.z * diffuseTerm + specColorZ * specScale);
    }
  }

  return out;
}

function sampleHybridContinuation(
  incomingDir: Vector3,
  outwardNormal: Vector3,
  shadingNormal: Vector3,
  frontFace: boolean,
  currentMediumIor: number,
  material: WorkerMaterial,
  sampleIndex: number,
  pixelIndex: number,
  bounce: number,
): WorkerBounceSample | null {
  if (!normalizeVec3ToRef(incomingDir, continuationIncidentScratch)) {
    return null;
  }
  const incident = continuationIncidentScratch;
  const mediumIor = sanitizeIor(currentMediumIor);
  const materialIor = sanitizeIor(material.ior);
  const nextMediumIorForTransmission = frontFace ? materialIor : 1;
  const cosTheta = clamp(-Vector3.Dot(incident, shadingNormal), 0, 1);
  const dielectricF0 = fresnelF0FromIorPair(mediumIor, nextMediumIorForTransmission);
  const fresnel = schlickFresnel(cosTheta, Math.max(dielectricF0, material.reflectance));

  let reflectWeight = clamp01Safe(Math.max(material.reflectance, material.metallic));
  let transmitWeight = clamp01Safe(material.transmission);
  if (transmitWeight > 0) {
    reflectWeight = clamp01Safe(reflectWeight + transmitWeight * fresnel);
    transmitWeight = clamp01Safe(transmitWeight * (1 - fresnel));
  }
  const diffuseWeight = clamp01Safe((1 - material.metallic) * (1 - material.transmission) * material.opacity);
  const total = reflectWeight + transmitWeight + diffuseWeight;
  if (total <= 1e-5) {
    return null;
  }

  const xi = sampleHash01(pixelIndex, sampleIndex + bounce * 19, 7) * total;
  const roughness = clamp(material.roughness, 0, 1);
  const out = continuationBounceSampleScratch;

  if (xi < transmitWeight) {
    continuationInterfaceNormalScratch.x = frontFace ? outwardNormal.x : -outwardNormal.x;
    continuationInterfaceNormalScratch.y = frontFace ? outwardNormal.y : -outwardNormal.y;
    continuationInterfaceNormalScratch.z = frontFace ? outwardNormal.z : -outwardNormal.z;
    const refracted = refractDirectionAcrossInterfaceToRef(
      incident,
      continuationInterfaceNormalScratch,
      mediumIor,
      nextMediumIorForTransmission,
      out.direction,
    );
    if (!refracted) {
      if (!reflectDirectionToRef(incident, shadingNormal, out.direction)) {
        return null;
      }
    }
    if (!jitterDirectionToRef(
      out.direction,
      clamp(roughness * 0.35, 0, 0.4),
      pixelIndex,
      sampleIndex,
      bounce,
      17,
      out.direction,
      continuationTangentScratch,
      continuationBitangentScratch,
    )) {
      return null;
    }
    const tintScale = Math.max(0.15, transmitWeight / total);
    out.throughput.x = (1 + (material.baseColor.x - 1) * 0.2) * tintScale;
    out.throughput.y = (1 + (material.baseColor.y - 1) * 0.2) * tintScale;
    out.throughput.z = (1 + (material.baseColor.z - 1) * 0.2) * tintScale;
    out.nextMediumIor = refracted ? nextMediumIorForTransmission : mediumIor;
    out.wasTransmission = Boolean(refracted);
    return out;
  }

  if (xi < transmitWeight + reflectWeight) {
    if (!reflectDirectionToRef(incident, shadingNormal, out.direction)) {
      return null;
    }
    if (!jitterDirectionToRef(
      out.direction,
      clamp(roughness * 0.6, 0, 0.75),
      pixelIndex,
      sampleIndex,
      bounce,
      23,
      out.direction,
      continuationTangentScratch,
      continuationBitangentScratch,
    )) {
      return null;
    }
    const specScale = Math.max(0.1, reflectWeight / total);
    out.throughput.x = (1 + (material.baseColor.x - 1) * material.metallic) * specScale;
    out.throughput.y = (1 + (material.baseColor.y - 1) * material.metallic) * specScale;
    out.throughput.z = (1 + (material.baseColor.z - 1) * material.metallic) * specScale;
    out.nextMediumIor = mediumIor;
    out.wasTransmission = false;
    return out;
  }

  if (!cosineSampleHemisphereToRef(
    shadingNormal,
    pixelIndex,
    sampleIndex,
    bounce,
    29,
    out.direction,
    continuationTangentScratch,
    continuationBitangentScratch,
  )) {
    return null;
  }
  const diffuseScale = Math.max(0.1, diffuseWeight / total);
  out.throughput.x = material.baseColor.x * diffuseScale;
  out.throughput.y = material.baseColor.y * diffuseScale;
  out.throughput.z = material.baseColor.z * diffuseScale;
  out.nextMediumIor = mediumIor;
  out.wasTransmission = false;
  return out;
}

function isShadowedDirectional(
  scene: WorkerSceneState,
  hitPoint: Vector3,
  normal: Vector3,
  lightDirX: number,
  lightDirY: number,
  lightDirZ: number,
  hitMeshIndex: number,
): boolean {
  shadowRayScratchOrigin.x = hitPoint.x + normal.x * 0.0035;
  shadowRayScratchOrigin.y = hitPoint.y + normal.y * 0.0035;
  shadowRayScratchOrigin.z = hitPoint.z + normal.z * 0.0035;
  shadowRayScratchDirection.x = lightDirX;
  shadowRayScratchDirection.y = lightDirY;
  shadowRayScratchDirection.z = lightDirZ;
  shadowRayScratch.length = 1e6;
  return hasAnyTraceHit(scene, shadowRayScratch, hitMeshIndex);
}

function isShadowedPoint(
  scene: WorkerSceneState,
  hitPoint: Vector3,
  normal: Vector3,
  lightDirX: number,
  lightDirY: number,
  lightDirZ: number,
  lightDistance: number,
  hitMeshIndex: number,
): boolean {
  shadowRayScratchOrigin.x = hitPoint.x + normal.x * 0.0035;
  shadowRayScratchOrigin.y = hitPoint.y + normal.y * 0.0035;
  shadowRayScratchOrigin.z = hitPoint.z + normal.z * 0.0035;
  shadowRayScratchDirection.x = lightDirX;
  shadowRayScratchDirection.y = lightDirY;
  shadowRayScratchDirection.z = lightDirZ;
  const shadowMaxDistance = lightDistance - 0.005;
  shadowRayScratch.length = Math.max(0, shadowMaxDistance);
  return hasAnyTraceHit(scene, shadowRayScratch, hitMeshIndex, shadowMaxDistance);
}

function pickTraceRayClosest(scene: WorkerSceneState, ray: Ray, ignoreMeshIndex: number): WorkerHit | null {
  let bestHit: WorkerHit | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const root = scene.meshBvhRoot;
  if (!root) {
    return null;
  }

  const stack: WorkerMeshBvhNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const nodeHitDist = rayIntersectsTraceAabb(ray, node.minX, node.minY, node.minZ, node.maxX, node.maxY, node.maxZ, bestDistance);
    if (nodeHitDist === null) {
      continue;
    }
    if (node.items) {
      for (const entry of node.items) {
        if (entry.meshIndex === ignoreMeshIndex) {
          continue;
        }
        const entryHitDist = rayIntersectsTraceAabb(
          ray,
          entry.minX,
          entry.minY,
          entry.minZ,
          entry.maxX,
          entry.maxY,
          entry.maxZ,
          bestDistance,
        );
        if (entryHitDist === null) {
          continue;
        }
        const hit = entry.triangleAccel
          ? intersectTraceTriangleAccelClosest(ray, entry.triangleAccel, bestDistance)
          : intersectTraceLineAccelClosest(ray, entry.lineAccel, bestDistance);
        if (!hit) {
          continue;
        }
        bestDistance = hit.distance;
        bestHit = {
          distance: hit.distance,
          point: hit.point,
          normal: hit.normal,
          meshIndex: entry.meshIndex,
          material: entry.material,
        };
      }
      continue;
    }

    const left = node.left;
    const right = node.right;
    if (!left && !right) {
      continue;
    }
    if (left && right) {
      const leftHit = rayIntersectsTraceAabb(ray, left.minX, left.minY, left.minZ, left.maxX, left.maxY, left.maxZ, bestDistance);
      const rightHit = rayIntersectsTraceAabb(ray, right.minX, right.minY, right.minZ, right.maxX, right.maxY, right.maxZ, bestDistance);
      if (leftHit !== null && rightHit !== null) {
        if (leftHit < rightHit) {
          stack.push(right, left);
        } else {
          stack.push(left, right);
        }
        continue;
      }
      if (leftHit !== null) stack.push(left);
      if (rightHit !== null) stack.push(right);
      continue;
    }
    if (left) stack.push(left);
    if (right) stack.push(right);
  }

  return bestHit;
}

function hasAnyTraceHit(
  scene: WorkerSceneState,
  ray: Ray,
  ignoreMeshIndex: number,
  maxDistance?: number,
): boolean {
  const limit = Number.isFinite(maxDistance) ? Math.max(0, maxDistance ?? 0) : null;
  const root = scene.meshBvhRoot;
  if (!root) {
    return false;
  }
  const maxT = limit ?? Number.POSITIVE_INFINITY;
  const stack: WorkerMeshBvhNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const nodeHitDist = rayIntersectsTraceAabb(ray, node.minX, node.minY, node.minZ, node.maxX, node.maxY, node.maxZ, maxT);
    if (nodeHitDist === null) {
      continue;
    }
    if (node.items) {
      for (const entry of node.items) {
        if (entry.meshIndex === ignoreMeshIndex) {
          continue;
        }
        const entryHitDist = rayIntersectsTraceAabb(
          ray,
          entry.minX,
          entry.minY,
          entry.minZ,
          entry.maxX,
          entry.maxY,
          entry.maxZ,
          maxT,
        );
        if (entryHitDist === null) {
          continue;
        }
        const hasHit = entry.triangleAccel
          ? intersectTraceTriangleAccelAny(ray, entry.triangleAccel, limit)
          : intersectTraceLineAccelAny(ray, entry.lineAccel, limit);
        if (hasHit) {
          return true;
        }
      }
      continue;
    }

    const left = node.left;
    const right = node.right;
    if (!left && !right) {
      continue;
    }
    if (left && right) {
      const leftHit = rayIntersectsTraceAabb(ray, left.minX, left.minY, left.minZ, left.maxX, left.maxY, left.maxZ, maxT);
      const rightHit = rayIntersectsTraceAabb(ray, right.minX, right.minY, right.minZ, right.maxX, right.maxY, right.maxZ, maxT);
      if (leftHit !== null && rightHit !== null) {
        if (leftHit < rightHit) {
          stack.push(right, left);
        } else {
          stack.push(left, right);
        }
        continue;
      }
      if (leftHit !== null) stack.push(left);
      if (rightHit !== null) stack.push(right);
      continue;
    }
    if (left) stack.push(left);
    if (right) stack.push(right);
  }

  return false;
}

function buildWorkerMeshBvh(entries: WorkerMeshEntry[]): WorkerMeshBvhNode | null {
  if (entries.length === 0) {
    return null;
  }
  return buildWorkerMeshBvhRecursive(entries.slice());
}

function buildWorkerMeshBvhRecursive(entries: WorkerMeshEntry[]): WorkerMeshBvhNode {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let centerMinX = Number.POSITIVE_INFINITY;
  let centerMinY = Number.POSITIVE_INFINITY;
  let centerMinZ = Number.POSITIVE_INFINITY;
  let centerMaxX = Number.NEGATIVE_INFINITY;
  let centerMaxY = Number.NEGATIVE_INFINITY;
  let centerMaxZ = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    if (entry.minX < minX) minX = entry.minX;
    if (entry.minY < minY) minY = entry.minY;
    if (entry.minZ < minZ) minZ = entry.minZ;
    if (entry.maxX > maxX) maxX = entry.maxX;
    if (entry.maxY > maxY) maxY = entry.maxY;
    if (entry.maxZ > maxZ) maxZ = entry.maxZ;
    if (entry.centerX < centerMinX) centerMinX = entry.centerX;
    if (entry.centerY < centerMinY) centerMinY = entry.centerY;
    if (entry.centerZ < centerMinZ) centerMinZ = entry.centerZ;
    if (entry.centerX > centerMaxX) centerMaxX = entry.centerX;
    if (entry.centerY > centerMaxY) centerMaxY = entry.centerY;
    if (entry.centerZ > centerMaxZ) centerMaxZ = entry.centerZ;
  }

  if (entries.length <= TRACE_MESH_BVH_LEAF_SIZE) {
    return {
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
      left: null,
      right: null,
      items: entries,
    };
  }

  const extentX = centerMaxX - centerMinX;
  const extentY = centerMaxY - centerMinY;
  const extentZ = centerMaxZ - centerMinZ;
  let axis: 'x' | 'y' | 'z' = 'x';
  if (extentY > extentX && extentY >= extentZ) {
    axis = 'y';
  } else if (extentZ > extentX && extentZ >= extentY) {
    axis = 'z';
  }

  entries.sort((a, b) => (
    axis === 'x' ? a.centerX - b.centerX
      : axis === 'y' ? a.centerY - b.centerY
        : a.centerZ - b.centerZ
  ));
  const split = Math.floor(entries.length / 2);
  if (split <= 0 || split >= entries.length) {
    return {
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
      left: null,
      right: null,
      items: entries,
    };
  }

  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    left: buildWorkerMeshBvhRecursive(entries.slice(0, split)),
    right: buildWorkerMeshBvhRecursive(entries.slice(split)),
    items: null,
  };
}

function intersectTraceTriangleAccelClosest(
  ray: Ray,
  accel: PathTraceWorkerTriangleAccel,
  maxDistance: number,
): TriangleHitResult | null {
  if (accel.triangleBvhRoot) {
    return intersectTraceTriangleLocalBvhClosest(ray, accel, maxDistance);
  }
  return intersectTraceTriangleSoupClosest(ray, accel, maxDistance);
}

function intersectTraceLineAccelClosest(
  ray: Ray,
  accel: PathTraceWorkerLineAccel | null,
  maxDistance: number,
): LineHitResult | null {
  if (!accel || accel.segmentCount <= 0) {
    return null;
  }
  const positions = accel.positionsWorld;
  const limit = Number.isFinite(maxDistance) ? Math.max(0, maxDistance) : Number.POSITIVE_INFINITY;
  let bestDistance = limit;
  let hit = false;
  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dz = ray.direction.z;
  for (let base = 0; base + 5 < positions.length; base += 6) {
    const distance = rayIntersectsTraceLineSegmentDistance(
      ray,
      positions[base],
      positions[base + 1],
      positions[base + 2],
      positions[base + 3],
      positions[base + 4],
      positions[base + 5],
      accel.intersectionThreshold,
      bestDistance,
    );
    if (!(distance >= 0) || distance >= bestDistance) {
      continue;
    }
    bestDistance = distance;
    hit = true;
  }
  if (!hit || !Number.isFinite(bestDistance)) {
    return null;
  }
  return {
    distance: bestDistance,
    point: new Vector3(ox + dx * bestDistance, oy + dy * bestDistance, oz + dz * bestDistance),
    // Babylon line picks generally don't provide a geometric normal; match the main-thread
    // CPU path fallback behavior by using the inverse ray direction as a shading fallback.
    normal: new Vector3(-dx, -dy, -dz),
  };
}

function intersectTraceLineAccelAny(
  ray: Ray,
  accel: PathTraceWorkerLineAccel | null,
  maxDistance: number | null,
): boolean {
  if (!accel || accel.segmentCount <= 0) {
    return false;
  }
  const positions = accel.positionsWorld;
  const limit = maxDistance === null ? Number.POSITIVE_INFINITY : Math.max(0, maxDistance);
  for (let base = 0; base + 5 < positions.length; base += 6) {
    const distance = rayIntersectsTraceLineSegmentDistance(
      ray,
      positions[base],
      positions[base + 1],
      positions[base + 2],
      positions[base + 3],
      positions[base + 4],
      positions[base + 5],
      accel.intersectionThreshold,
      limit,
    );
    if (distance >= 0) {
      return true;
    }
  }
  return false;
}

function intersectTraceTriangleAccelAny(
  ray: Ray,
  accel: PathTraceWorkerTriangleAccel,
  maxDistance: number | null,
): boolean {
  if (accel.triangleBvhRoot) {
    return intersectTraceTriangleLocalBvhAny(ray, accel, maxDistance);
  }
  return intersectTraceTriangleSoupAny(ray, accel, maxDistance);
}

function rayIntersectsTraceLineSegmentDistance(
  ray: Ray,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  threshold: number,
  maxDistance: number,
): number {
  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dz = ray.direction.z;
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = dx * RAY_SEGMENT_INTERSECTION_RAY_LENGTH;
  const vy = dy * RAY_SEGMENT_INTERSECTION_RAY_LENGTH;
  const vz = dz * RAY_SEGMENT_INTERSECTION_RAY_LENGTH;
  const wx = ax - ox;
  const wy = ay - oy;
  const wz = az - oz;
  const a = ux * ux + uy * uy + uz * uz;
  const b = ux * vx + uy * vy + uz * vz;
  const c = vx * vx + vy * vy + vz * vz;
  const d = ux * wx + uy * wy + uz * wz;
  const e = vx * wx + vy * wy + vz * wz;
  const discriminant = a * c - b * b;
  let sN: number;
  let sD = discriminant;
  let tN: number;
  let tD = discriminant;

  if (discriminant < RAY_SEGMENT_INTERSECTION_SMALL_NUM) {
    sN = 0;
    sD = 1;
    tN = e;
    tD = c;
  } else {
    sN = b * e - c * d;
    tN = a * e - b * d;
    if (sN < 0) {
      sN = 0;
      tN = e;
      tD = c;
    } else if (sN > sD) {
      sN = sD;
      tN = e + b;
      tD = c;
    }
  }

  if (tN < 0) {
    tN = 0;
    if (-d < 0) {
      sN = 0;
    } else if (-d > a) {
      sN = sD;
    } else {
      sN = -d;
      sD = a;
    }
  } else if (tN > tD) {
    tN = tD;
    if (-d + b < 0) {
      sN = 0;
    } else if (-d + b > a) {
      sN = sD;
    } else {
      sN = -d + b;
      sD = a;
    }
  }

  const sc = Math.abs(sN) < RAY_SEGMENT_INTERSECTION_SMALL_NUM ? 0 : sN / sD;
  const tc = Math.abs(tN) < RAY_SEGMENT_INTERSECTION_SMALL_NUM ? 0 : tN / tD;

  const qscx = wx + ux * sc;
  const qscy = wy + uy * sc;
  const qscz = wz + uz * sc;
  const qtcx = vx * tc;
  const qtcy = vy * tc;
  const qtcz = vz * tc;
  const dPx = qscx - qtcx;
  const dPy = qscy - qtcy;
  const dPz = qscz - qtcz;
  const thresholdSq = Math.max(0, threshold) * Math.max(0, threshold);
  const dP2 = dPx * dPx + dPy * dPy + dPz * dPz;
  if (!(tc > 0) || dP2 >= thresholdSq) {
    return -1;
  }

  const distance = Math.sqrt(qscx * qscx + qscy * qscy + qscz * qscz);
  const rayLength = Number.isFinite(ray.length) ? Math.max(0, ray.length) : Number.POSITIVE_INFINITY;
  const limit = Number.isFinite(maxDistance) ? Math.max(0, maxDistance) : Number.POSITIVE_INFINITY;
  const maxAllowed = Math.min(rayLength, limit);
  if (!(distance > 0) || distance > maxAllowed) {
    return -1;
  }
  return distance;
}

function intersectTraceTriangleSoupClosest(
  ray: Ray,
  accel: PathTraceWorkerTriangleAccel,
  maxDistance: number,
): TriangleHitResult | null {
  const positions = accel.positionsWorld;
  const normals = accel.normalsWorld;
  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dz = ray.direction.z;
  const epsilon = 1e-8;
  const minT = 1e-5;
  let bestT = Number.isFinite(maxDistance) ? Math.max(minT, maxDistance) : Number.POSITIVE_INFINITY;
  let hitBase = -1;
  let hitU = 0;
  let hitV = 0;

  for (let base = 0; base < positions.length; base += 9) {
    const ax = positions[base];
    const ay = positions[base + 1];
    const az = positions[base + 2];
    const bx = positions[base + 3];
    const by = positions[base + 4];
    const bz = positions[base + 5];
    const cx = positions[base + 6];
    const cy = positions[base + 7];
    const cz = positions[base + 8];

    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;

    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) <= epsilon) {
      continue;
    }
    const invDet = 1 / det;

    const tx = ox - ax;
    const ty = oy - ay;
    const tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < -1e-6 || u > 1 + 1e-6) {
      continue;
    }

    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * invDet;
    if (v < -1e-6 || u + v > 1 + 1e-6) {
      continue;
    }

    const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    if (!(t > minT) || t >= bestT) {
      continue;
    }
    bestT = t;
    hitBase = base;
    hitU = u;
    hitV = v;
  }

  if (hitBase < 0 || !Number.isFinite(bestT)) {
    return null;
  }

  return {
    distance: bestT,
    point: new Vector3(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT),
    normal: sampleTraceTriangleNormal(positions, normals, hitBase, hitU, hitV),
  };
}

function intersectTraceTriangleSoupAny(
  ray: Ray,
  accel: PathTraceWorkerTriangleAccel,
  maxDistance: number | null,
): boolean {
  const positions = accel.positionsWorld;
  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dz = ray.direction.z;
  const epsilon = 1e-8;
  const minT = 1e-5;
  const limit = maxDistance !== null && Number.isFinite(maxDistance)
    ? Math.max(minT, maxDistance)
    : Number.POSITIVE_INFINITY;

  for (let base = 0; base < positions.length; base += 9) {
    const ax = positions[base];
    const ay = positions[base + 1];
    const az = positions[base + 2];
    const bx = positions[base + 3];
    const by = positions[base + 4];
    const bz = positions[base + 5];
    const cx = positions[base + 6];
    const cy = positions[base + 7];
    const cz = positions[base + 8];

    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;

    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) <= epsilon) {
      continue;
    }
    const invDet = 1 / det;

    const tx = ox - ax;
    const ty = oy - ay;
    const tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < -1e-6 || u > 1 + 1e-6) {
      continue;
    }

    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * invDet;
    if (v < -1e-6 || u + v > 1 + 1e-6) {
      continue;
    }

    const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    if (t > minT && t < limit) {
      return true;
    }
  }

  return false;
}

function intersectTraceTriangleLocalBvhClosest(
  ray: Ray,
  accel: PathTraceWorkerTriangleAccel,
  maxDistance: number,
): TriangleHitResult | null {
  const root = accel.triangleBvhRoot;
  if (!root) return null;

  const positions = accel.positionsWorld;
  const normals = accel.normalsWorld;
  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dz = ray.direction.z;
  const epsilon = 1e-8;
  const minT = 1e-5;
  let bestT = Number.isFinite(maxDistance) ? Math.max(minT, maxDistance) : Number.POSITIVE_INFINITY;
  let hitBase = -1;
  let hitU = 0;
  let hitV = 0;
  const stack: PathTraceWorkerTriangleBvhNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;
    const nodeHitDist = rayIntersectsTraceAabb(ray, node.minX, node.minY, node.minZ, node.maxX, node.maxY, node.maxZ, bestT);
    if (nodeHitDist === null) continue;

    if (node.triangleIndices) {
      for (let i = 0; i < node.triangleIndices.length; i += 1) {
        const triIndex = node.triangleIndices[i];
        const base = triIndex * 9;
        const ax = positions[base];
        const ay = positions[base + 1];
        const az = positions[base + 2];
        const bx = positions[base + 3];
        const by = positions[base + 4];
        const bz = positions[base + 5];
        const cx = positions[base + 6];
        const cy = positions[base + 7];
        const cz = positions[base + 8];

        const e1x = bx - ax;
        const e1y = by - ay;
        const e1z = bz - az;
        const e2x = cx - ax;
        const e2y = cy - ay;
        const e2z = cz - az;

        const px = dy * e2z - dz * e2y;
        const py = dz * e2x - dx * e2z;
        const pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) <= epsilon) continue;
        const invDet = 1 / det;

        const tx = ox - ax;
        const ty = oy - ay;
        const tz = oz - az;
        const u = (tx * px + ty * py + tz * pz) * invDet;
        if (u < -1e-6 || u > 1 + 1e-6) continue;

        const qx = ty * e1z - tz * e1y;
        const qy = tz * e1x - tx * e1z;
        const qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * invDet;
        if (v < -1e-6 || u + v > 1 + 1e-6) continue;

        const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
        if (!(t > minT) || t >= bestT) continue;
        bestT = t;
        hitBase = base;
        hitU = u;
        hitV = v;
      }
      continue;
    }

    const left = node.left;
    const right = node.right;
    if (!left && !right) continue;
    if (left && right) {
      const leftHit = rayIntersectsTraceAabb(ray, left.minX, left.minY, left.minZ, left.maxX, left.maxY, left.maxZ, bestT);
      const rightHit = rayIntersectsTraceAabb(ray, right.minX, right.minY, right.minZ, right.maxX, right.maxY, right.maxZ, bestT);
      if (leftHit !== null && rightHit !== null) {
        if (leftHit < rightHit) stack.push(right, left);
        else stack.push(left, right);
        continue;
      }
      if (leftHit !== null) stack.push(left);
      if (rightHit !== null) stack.push(right);
      continue;
    }
    if (left) stack.push(left);
    if (right) stack.push(right);
  }

  if (hitBase < 0 || !Number.isFinite(bestT)) {
    return null;
  }
  return {
    distance: bestT,
    point: new Vector3(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT),
    normal: sampleTraceTriangleNormal(positions, normals, hitBase, hitU, hitV),
  };
}

function intersectTraceTriangleLocalBvhAny(
  ray: Ray,
  accel: PathTraceWorkerTriangleAccel,
  maxDistance: number | null,
): boolean {
  const root = accel.triangleBvhRoot;
  if (!root) return false;

  const positions = accel.positionsWorld;
  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dz = ray.direction.z;
  const epsilon = 1e-8;
  const minT = 1e-5;
  const maxT = maxDistance !== null && Number.isFinite(maxDistance)
    ? Math.max(minT, maxDistance)
    : Number.POSITIVE_INFINITY;
  const stack: PathTraceWorkerTriangleBvhNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;
    const nodeHitDist = rayIntersectsTraceAabb(ray, node.minX, node.minY, node.minZ, node.maxX, node.maxY, node.maxZ, maxT);
    if (nodeHitDist === null) continue;

    if (node.triangleIndices) {
      for (let i = 0; i < node.triangleIndices.length; i += 1) {
        const triIndex = node.triangleIndices[i];
        const base = triIndex * 9;
        const ax = positions[base];
        const ay = positions[base + 1];
        const az = positions[base + 2];
        const bx = positions[base + 3];
        const by = positions[base + 4];
        const bz = positions[base + 5];
        const cx = positions[base + 6];
        const cy = positions[base + 7];
        const cz = positions[base + 8];

        const e1x = bx - ax;
        const e1y = by - ay;
        const e1z = bz - az;
        const e2x = cx - ax;
        const e2y = cy - ay;
        const e2z = cz - az;

        const px = dy * e2z - dz * e2y;
        const py = dz * e2x - dx * e2z;
        const pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) <= epsilon) continue;
        const invDet = 1 / det;

        const tx = ox - ax;
        const ty = oy - ay;
        const tz = oz - az;
        const u = (tx * px + ty * py + tz * pz) * invDet;
        if (u < -1e-6 || u > 1 + 1e-6) continue;

        const qx = ty * e1z - tz * e1y;
        const qy = tz * e1x - tx * e1z;
        const qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * invDet;
        if (v < -1e-6 || u + v > 1 + 1e-6) continue;

        const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
        if (t > minT && t < maxT) {
          return true;
        }
      }
      continue;
    }

    const left = node.left;
    const right = node.right;
    if (!left && !right) continue;
    if (left && right) {
      const leftHit = rayIntersectsTraceAabb(ray, left.minX, left.minY, left.minZ, left.maxX, left.maxY, left.maxZ, maxT);
      const rightHit = rayIntersectsTraceAabb(ray, right.minX, right.minY, right.minZ, right.maxX, right.maxY, right.maxZ, maxT);
      if (leftHit !== null && rightHit !== null) {
        if (leftHit < rightHit) stack.push(right, left);
        else stack.push(left, right);
        continue;
      }
      if (leftHit !== null) stack.push(left);
      if (rightHit !== null) stack.push(right);
      continue;
    }
    if (left) stack.push(left);
    if (right) stack.push(right);
  }

  return false;
}

function sampleTraceTriangleNormal(
  positionsWorld: Float32Array,
  normalsWorld: Float32Array | null,
  base: number,
  u: number,
  v: number,
): Vector3 {
  if (normalsWorld) {
    const w = 1 - u - v;
    const nx = normalsWorld[base] * w + normalsWorld[base + 3] * u + normalsWorld[base + 6] * v;
    const ny = normalsWorld[base + 1] * w + normalsWorld[base + 4] * u + normalsWorld[base + 7] * v;
    const nz = normalsWorld[base + 2] * w + normalsWorld[base + 5] * u + normalsWorld[base + 8] * v;
    const len2 = nx * nx + ny * ny + nz * nz;
    if (len2 > 1e-20) {
      const invLen = 1 / Math.sqrt(len2);
      return new Vector3(nx * invLen, ny * invLen, nz * invLen);
    }
  }

  const ax = positionsWorld[base];
  const ay = positionsWorld[base + 1];
  const az = positionsWorld[base + 2];
  const bx = positionsWorld[base + 3];
  const by = positionsWorld[base + 4];
  const bz = positionsWorld[base + 5];
  const cx = positionsWorld[base + 6];
  const cy = positionsWorld[base + 7];
  const cz = positionsWorld[base + 8];
  const e1x = bx - ax;
  const e1y = by - ay;
  const e1z = bz - az;
  const e2x = cx - ax;
  const e2y = cy - ay;
  const e2z = cz - az;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const len2 = nx * nx + ny * ny + nz * nz;
  if (len2 <= 1e-20) {
    return new Vector3(0, 0, 1);
  }
  const invLen = 1 / Math.sqrt(len2);
  return new Vector3(nx * invLen, ny * invLen, nz * invLen);
}

function computeJitteredPointLightPosition(
  light: WorkerPointLight,
  sampleIndex: number,
  lightIndex: number,
): Vector3 | null {
  const range = Number.isFinite(light.range) && light.range > 0 ? light.range : 1;
  if (range <= 0) {
    return null;
  }
  const emitterRadius = clamp(range * 0.06, 0.08, 2.5);
  const baseIndex = sampleIndex + 1 + lightIndex * 131;
  const u = halton(baseIndex, 11);
  const v = halton(baseIndex, 13);
  const w = halton(baseIndex, 17);
  const theta = 2 * Math.PI * u;
  const phi = Math.acos(2 * v - 1);
  const r = emitterRadius * Math.cbrt(w);
  const sinPhi = Math.sin(phi);
  return new Vector3(
    light.position.x + r * sinPhi * Math.cos(theta),
    light.position.y + r * sinPhi * Math.sin(theta),
    light.position.z + r * Math.cos(phi),
  );
}

function computeJitteredDirectionalLightDirection(
  direction: Vector3,
  sampleIndex: number,
  lightIndex: number,
): Vector3 | null {
  const dir = direction.clone();
  if (dir.lengthSquared() < 1e-10) {
    return null;
  }
  dir.normalize();

  const worldUpA = new Vector3(0, 0, 1);
  const worldUpB = new Vector3(0, 1, 0);
  let tangent = Vector3.Cross(dir, Math.abs(Vector3.Dot(dir, worldUpA)) > 0.95 ? worldUpB : worldUpA);
  if (tangent.lengthSquared() < 1e-10) {
    tangent = Vector3.Cross(dir, new Vector3(1, 0, 0));
    if (tangent.lengthSquared() < 1e-10) {
      return null;
    }
  }
  tangent.normalize();
  const bitangent = Vector3.Cross(tangent, dir);
  if (bitangent.lengthSquared() < 1e-10) {
    return null;
  }
  bitangent.normalize();

  const baseIndex = sampleIndex + 1 + lightIndex * 97;
  const jx = halton(baseIndex, 5) * 2 - 1;
  const jy = halton(baseIndex, 7) * 2 - 1;
  const sunHalfAngleRad = 0.02;
  const coneScale = Math.tan(sunHalfAngleRad);
  const jittered = dir.add(tangent.scale(jx * coneScale)).add(bitangent.scale(jy * coneScale));
  if (jittered.lengthSquared() < 1e-10) {
    return null;
  }
  return jittered.normalize();
}

function vecFromPlain(v: PathTraceWorkerVec3): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}

function rayIntersectsTraceAabb(
  ray: Ray,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  maxDistance: number,
): number | null {
  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dz = ray.direction.z;
  let tMin = 0;
  let tMax = Number.isFinite(maxDistance) ? Math.max(0, maxDistance) : Number.POSITIVE_INFINITY;

  if (Math.abs(dx) < 1e-12) {
    if (ox < minX || ox > maxX) return null;
  } else {
    const invDx = 1 / dx;
    let t1 = (minX - ox) * invDx;
    let t2 = (maxX - ox) * invDx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMax < tMin) return null;
  }

  if (Math.abs(dy) < 1e-12) {
    if (oy < minY || oy > maxY) return null;
  } else {
    const invDy = 1 / dy;
    let t1 = (minY - oy) * invDy;
    let t2 = (maxY - oy) * invDy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMax < tMin) return null;
  }

  if (Math.abs(dz) < 1e-12) {
    if (oz < minZ || oz > maxZ) return null;
  } else {
    const invDz = 1 / dz;
    let t1 = (minZ - oz) * invDz;
    let t2 = (maxZ - oz) * invDz;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMax < tMin) return null;
  }

  if (tMax < 0) {
    return null;
  }
  return tMin >= 0 ? tMin : 0;
}

function sampleHash01(pixelIndex: number, sampleIndex: number, dimension: number): number {
  let x = (pixelIndex | 0) ^ Math.imul((sampleIndex + 1) | 0, 0x9e3779b1) ^ Math.imul((dimension + 1) | 0, 0x85ebca6b);
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = Math.max(1, Math.floor(index));
  const b = Math.max(2, Math.floor(base));
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
}

function normalizeVec3ToRef(input: Vector3, out: Vector3): boolean {
  const x = input.x;
  const y = input.y;
  const z = input.z;
  const lenSq = x * x + y * y + z * z;
  if (lenSq < 1e-12) {
    return false;
  }
  const invLen = 1 / Math.sqrt(lenSq);
  out.x = x * invLen;
  out.y = y * invLen;
  out.z = z * invLen;
  return true;
}

function orthonormalTangentToRef(normal: Vector3, out: Vector3): boolean {
  let nx = normal.x;
  let ny = normal.y;
  let nz = normal.z;
  const nLenSq = nx * nx + ny * ny + nz * nz;
  if (nLenSq < 1e-12) {
    return false;
  }
  const invNLen = 1 / Math.sqrt(nLenSq);
  nx *= invNLen;
  ny *= invNLen;
  nz *= invNLen;

  const upX = 0;
  const upY = Math.abs(nz) > 0.95 ? 1 : 0;
  const upZ = Math.abs(nz) > 0.95 ? 0 : 1;
  const tx = upY * nz - upZ * ny;
  const ty = upZ * nx - upX * nz;
  const tz = upX * ny - upY * nx;
  const tLenSq = tx * tx + ty * ty + tz * tz;
  if (tLenSq < 1e-12) {
    return false;
  }
  const invTLen = 1 / Math.sqrt(tLenSq);
  out.x = tx * invTLen;
  out.y = ty * invTLen;
  out.z = tz * invTLen;
  return true;
}

function cosineSampleHemisphereToRef(
  normal: Vector3,
  pixelIndex: number,
  sampleIndex: number,
  bounce: number,
  dimensionOffset: number,
  out: Vector3,
  tangentScratch: Vector3,
  bitangentScratch: Vector3,
): boolean {
  if (!normalizeVec3ToRef(normal, out)) {
    return false;
  }
  const nx = out.x;
  const ny = out.y;
  const nz = out.z;
  if (!orthonormalTangentToRef(out, tangentScratch)) {
    return false;
  }
  const tx = tangentScratch.x;
  const ty = tangentScratch.y;
  const tz = tangentScratch.z;
  let bx = ny * tz - nz * ty;
  let by = nz * tx - nx * tz;
  let bz = nx * ty - ny * tx;
  const bLenSq = bx * bx + by * by + bz * bz;
  if (bLenSq < 1e-12) {
    return false;
  }
  const invBLen = 1 / Math.sqrt(bLenSq);
  bx *= invBLen;
  by *= invBLen;
  bz *= invBLen;
  bitangentScratch.x = bx;
  bitangentScratch.y = by;
  bitangentScratch.z = bz;

  const u1 = sampleHash01(pixelIndex, sampleIndex + bounce * 53, dimensionOffset);
  const u2 = sampleHash01(pixelIndex, sampleIndex + bounce * 53, dimensionOffset + 1);
  const r = Math.sqrt(u1);
  const theta = 2 * Math.PI * u2;
  const sx = r * Math.cos(theta);
  const sy = r * Math.sin(theta);
  const sz = Math.sqrt(Math.max(0, 1 - u1));
  const dx = tx * sx + bx * sy + nx * sz;
  const dy = ty * sx + by * sy + ny * sz;
  const dz = tz * sx + bz * sy + nz * sz;
  const dLenSq = dx * dx + dy * dy + dz * dz;
  if (dLenSq < 1e-12) {
    return false;
  }
  const invDLen = 1 / Math.sqrt(dLenSq);
  out.x = dx * invDLen;
  out.y = dy * invDLen;
  out.z = dz * invDLen;
  return true;
}

function jitterDirectionToRef(
  direction: Vector3,
  amount: number,
  pixelIndex: number,
  sampleIndex: number,
  bounce: number,
  dimensionOffset: number,
  out: Vector3,
  tangentScratch: Vector3,
  bitangentScratch: Vector3,
): boolean {
  if (!normalizeVec3ToRef(direction, out)) {
    return false;
  }
  const baseX = out.x;
  const baseY = out.y;
  const baseZ = out.z;
  const jitterAmount = clamp(amount, 0, 1);
  if (jitterAmount <= 1e-5) {
    return true;
  }
  if (!orthonormalTangentToRef(out, tangentScratch)) {
    return true;
  }
  const tx = tangentScratch.x;
  const ty = tangentScratch.y;
  const tz = tangentScratch.z;
  let bx = baseY * tz - baseZ * ty;
  let by = baseZ * tx - baseX * tz;
  let bz = baseX * ty - baseY * tx;
  const bLenSq = bx * bx + by * by + bz * bz;
  if (bLenSq < 1e-12) {
    return true;
  }
  const invBLen = 1 / Math.sqrt(bLenSq);
  bx *= invBLen;
  by *= invBLen;
  bz *= invBLen;
  bitangentScratch.x = bx;
  bitangentScratch.y = by;
  bitangentScratch.z = bz;
  const u1 = sampleHash01(pixelIndex, sampleIndex + bounce * 61, dimensionOffset) * 2 - 1;
  const u2 = sampleHash01(pixelIndex, sampleIndex + bounce * 61, dimensionOffset + 1) * 2 - 1;
  const jx = baseX + tx * (u1 * jitterAmount) + bx * (u2 * jitterAmount);
  const jy = baseY + ty * (u1 * jitterAmount) + by * (u2 * jitterAmount);
  const jz = baseZ + tz * (u1 * jitterAmount) + bz * (u2 * jitterAmount);
  const jLenSq = jx * jx + jy * jy + jz * jz;
  if (jLenSq < 1e-12) {
    out.x = baseX;
    out.y = baseY;
    out.z = baseZ;
    return true;
  }
  const invJLen = 1 / Math.sqrt(jLenSq);
  out.x = jx * invJLen;
  out.y = jy * invJLen;
  out.z = jz * invJLen;
  return true;
}

function reflectDirectionToRef(incident: Vector3, normal: Vector3, out: Vector3): boolean {
  let nx = normal.x;
  let ny = normal.y;
  let nz = normal.z;
  const nLenSq = nx * nx + ny * ny + nz * nz;
  if (nLenSq < 1e-12) {
    return false;
  }
  const invNLen = 1 / Math.sqrt(nLenSq);
  nx *= invNLen;
  ny *= invNLen;
  nz *= invNLen;
  const dot = incident.x * nx + incident.y * ny + incident.z * nz;
  const rx = incident.x - nx * (2 * dot);
  const ry = incident.y - ny * (2 * dot);
  const rz = incident.z - nz * (2 * dot);
  const rLenSq = rx * rx + ry * ry + rz * rz;
  if (rLenSq < 1e-12) {
    return false;
  }
  const invRLen = 1 / Math.sqrt(rLenSq);
  out.x = rx * invRLen;
  out.y = ry * invRLen;
  out.z = rz * invRLen;
  return true;
}

function refractDirectionAcrossInterfaceToRef(
  incident: Vector3,
  interfaceNormal: Vector3,
  etaI: number,
  etaT: number,
  out: Vector3,
): boolean {
  let ix = incident.x;
  let iy = incident.y;
  let iz = incident.z;
  const iLenSq = ix * ix + iy * iy + iz * iz;
  if (iLenSq < 1e-12) {
    return false;
  }
  const invILen = 1 / Math.sqrt(iLenSq);
  ix *= invILen;
  iy *= invILen;
  iz *= invILen;

  let nx = interfaceNormal.x;
  let ny = interfaceNormal.y;
  let nz = interfaceNormal.z;
  const nLenSq = nx * nx + ny * ny + nz * nz;
  if (nLenSq < 1e-12) {
    return false;
  }
  const invNLen = 1 / Math.sqrt(nLenSq);
  nx *= invNLen;
  ny *= invNLen;
  nz *= invNLen;

  const ei = sanitizeIor(etaI);
  const et = sanitizeIor(etaT);
  const eta = ei / et;
  const cosI = clamp(-(ix * nx + iy * ny + iz * nz), -1, 1);
  const sinT2 = eta * eta * Math.max(0, 1 - cosI * cosI);
  if (sinT2 > 1) {
    return false;
  }
  const cosT = Math.sqrt(Math.max(0, 1 - sinT2));
  const tx = ix * eta + nx * (eta * cosI - cosT);
  const ty = iy * eta + ny * (eta * cosI - cosT);
  const tz = iz * eta + nz * (eta * cosI - cosT);
  const tLenSq = tx * tx + ty * ty + tz * tz;
  if (tLenSq < 1e-12) {
    return false;
  }
  const invTLen = 1 / Math.sqrt(tLenSq);
  out.x = tx * invTLen;
  out.y = ty * invTLen;
  out.z = tz * invTLen;
  return true;
}

function sanitizeIor(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return clamp(value, 1, 4);
}

function fresnelF0FromIorPair(etaI: number, etaT: number): number {
  const ei = sanitizeIor(etaI);
  const et = sanitizeIor(etaT);
  const sum = ei + et;
  if (sum <= 1e-6) return 0;
  const x = (ei - et) / sum;
  return clamp01Safe(x * x);
}

function schlickFresnel(cosTheta: number, f0: number): number {
  const c = clamp(1 - clamp(cosTheta, 0, 1), 0, 1);
  const c2 = c * c;
  const c5 = c2 * c2 * c;
  return clamp01Safe(f0 + (1 - f0) * c5);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01Safe(value: number): number {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
}

function clampFinite(value: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 64) : 0;
}

function multiplyVec3InPlace(a: Vector3, b: Vector3): Vector3 {
  a.x *= b.x;
  a.y *= b.y;
  a.z *= b.z;
  return a;
}

export {};
