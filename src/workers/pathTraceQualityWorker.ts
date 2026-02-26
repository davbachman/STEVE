/// <reference lib="webworker" />

import { Ray, Vector3 } from '@babylonjs/core';
import type {
  PathTraceWorkerLight,
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
  triangleAccel: PathTraceWorkerTriangleAccel;
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
}

interface WorkerPixelSample {
  r: number;
  g: number;
  b: number;
  a: number;
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

const TRACE_MESH_BVH_LEAF_SIZE = 4;

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
      for (let i = 0; i < pixelCount; i += 1) {
        const rayBase = i * 6;
        const ray = new Ray(
          new Vector3(req.rays[rayBase], req.rays[rayBase + 1], req.rays[rayBase + 2]),
          new Vector3(req.rays[rayBase + 3], req.rays[rayBase + 4], req.rays[rayBase + 5]),
          1e6,
        );
        const pixelIndex = req.pixelIndices[i];
        const sample = traceHybridRay(currentScene, ray, maxBounces, req.sampleIndex, pixelIndex);
        const outBase = i * 4;
        samples[outBase] = sample.r;
        samples[outBase + 1] = sample.g;
        samples[outBase + 2] = sample.b;
        samples[outBase + 3] = sample.a;
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
): WorkerPixelSample {
  let ray = initialRay;
  let throughput = new Vector3(1, 1, 1);
  const radiance = new Vector3(0, 0, 0);
  let alpha = 0;
  let currentMediumIor = 1;

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
    let outwardNormal = hit.normal.clone();
    if (outwardNormal.lengthSquared() < 1e-10) {
      outwardNormal = ray.direction.scale(-1);
    }
    outwardNormal.normalize();
    const frontFace = Vector3.Dot(outwardNormal, ray.direction) < 0;
    const shadingNormal = outwardNormal.clone();
    if (!frontFace) {
      shadingNormal.scaleInPlace(-1);
    }

    const viewDir = ray.direction.scale(-1).normalize();
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

    throughput = multiplyVec3(throughput, bounceSample.throughput);
    currentMediumIor = bounceSample.nextMediumIor;
    const rrStartBounce = 1;
    if (bounce >= rrStartBounce) {
      const continueProb = clamp(Math.max(throughput.x, throughput.y, throughput.z), 0.05, 0.95);
      if (sampleHash01(pixelIndex, sampleIndex + bounce * 13, 91) > continueProb) {
        break;
      }
      throughput.scaleInPlace(1 / continueProb);
    }

    const nextOrigin = hitPoint.add(bounceSample.direction.scale(0.0025));
    ray = new Ray(nextOrigin, bounceSample.direction, 1e6);
  }

  return {
    r: clampFinite(radiance.x),
    g: clampFinite(radiance.y),
    b: clampFinite(radiance.z),
    a: alpha,
  };
}

function sampleHybridEnvironment(scene: WorkerSceneState, direction: Vector3): WorkerEnvironmentSample {
  const dir = direction.clone();
  if (dir.lengthSquared() < 1e-10) {
    return { radiance: new Vector3(0, 0, 0), alpha: 1 };
  }
  dir.normalize();

  const base = scene.clearColor.clone();
  const alpha = 1;
  base.x += scene.ambientColor.x * 0.35;
  base.y += scene.ambientColor.y * 0.35;
  base.z += scene.ambientColor.z * 0.35;

  for (const light of scene.lights) {
    if (light.kind !== 'hemispheric' || light.intensity <= 0) {
      continue;
    }
    const hemiDir = light.direction.clone();
    if (hemiDir.lengthSquared() < 1e-10) {
      continue;
    }
    hemiDir.normalize();
    const t = clamp(0.5 + 0.5 * Vector3.Dot(dir, hemiDir), 0, 1);
    const sky = light.diffuse.scale(light.intensity);
    const ground = light.ground.scale(light.intensity);
    const dome = lerpVec3(ground, sky, t);
    base.x += dome.x;
    base.y += dome.y;
    base.z += dome.z;
  }

  return {
    radiance: new Vector3(clampFinite(base.x), clampFinite(base.y), clampFinite(base.z)),
    alpha,
  };
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
): Vector3 {
  const out = new Vector3(0, 0, 0);
  const diffuseWeight = clamp01Safe((1 - material.metallic) * (1 - material.transmission) * material.opacity);
  const specWeight = clamp01Safe(Math.max(material.reflectance, material.metallic));
  const specColor = lerpVec3(new Vector3(1, 1, 1), material.baseColor, material.metallic);
  const roughness = clamp(material.roughness, 0.03, 1);
  const shininess = clamp(Math.round((1 - roughness) * 180 + 8), 8, 256);

  const sampleFiniteDirectThisBounce = bounce === 0;
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
      const hemiDir = light.direction.clone();
      if (hemiDir.lengthSquared() < 1e-10) continue;
      hemiDir.normalize();
      const t = clamp(0.5 + 0.5 * Vector3.Dot(normal, hemiDir), 0, 1);
      const hemi = lerpVec3(light.ground.scale(light.intensity), light.diffuse.scale(light.intensity), t);
      out.x += hemi.x * material.baseColor.x * diffuseWeight;
      out.y += hemi.y * material.baseColor.y * diffuseWeight;
      out.z += hemi.z * material.baseColor.z * diffuseWeight;
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
        ?? light.direction.clone();
      if (jitteredDir.lengthSquared() < 1e-10) continue;
      jitteredDir.normalize();
      const lightDir = jitteredDir.scale(-1).normalize();
      const ndl = Math.max(0, Vector3.Dot(normal, lightDir));
      if (ndl <= 0) continue;
      if (isShadowedDirectional(scene, hitPoint, normal, lightDir, hitMeshIndex)) {
        continue;
      }
      const lightColor = light.diffuse.scale(light.intensity * finiteLightWeight);
      const h = lightDir.add(viewDir).normalize();
      const ndh = Math.max(0, Vector3.Dot(normal, h));
      const specTerm = specWeight > 0 ? Math.pow(ndh, shininess) * ndl : 0;
      out.x += lightColor.x * (material.baseColor.x * diffuseWeight * ndl + specColor.x * specTerm * specWeight);
      out.y += lightColor.y * (material.baseColor.y * diffuseWeight * ndl + specColor.y * specTerm * specWeight);
      out.z += lightColor.z * (material.baseColor.z * diffuseWeight * ndl + specColor.z * specTerm * specWeight);
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
      const samplePos = computeJitteredPointLightPosition(light, sampleIndex + bounce * 47 + pixelIndex, currentPointIndex) ?? light.position.clone();
      const toLight = samplePos.subtract(hitPoint);
      const dist2 = toLight.lengthSquared();
      if (dist2 <= 1e-8) continue;
      const dist = Math.sqrt(dist2);
      const lightDir = toLight.scale(1 / dist);
      const ndl = Math.max(0, Vector3.Dot(normal, lightDir));
      if (ndl <= 0) continue;
      if (isShadowedPoint(scene, hitPoint, normal, lightDir, dist, hitMeshIndex)) {
        continue;
      }
      const range = Number.isFinite(light.range) && light.range > 0 ? light.range : dist * 2;
      const rangeFalloff = clamp(1 - (dist / Math.max(range, 1e-3)) ** 2, 0, 1);
      const attenuation = rangeFalloff * rangeFalloff / (1 + dist2 * 0.03);
      if (attenuation <= 0) continue;
      const lightColor = light.diffuse.scale(light.intensity * attenuation * finiteLightWeight);
      const h = lightDir.add(viewDir).normalize();
      const ndh = Math.max(0, Vector3.Dot(normal, h));
      const specTerm = specWeight > 0 ? Math.pow(ndh, shininess) * ndl : 0;
      out.x += lightColor.x * (material.baseColor.x * diffuseWeight * ndl + specColor.x * specTerm * specWeight);
      out.y += lightColor.y * (material.baseColor.y * diffuseWeight * ndl + specColor.y * specTerm * specWeight);
      out.z += lightColor.z * (material.baseColor.z * diffuseWeight * ndl + specColor.z * specTerm * specWeight);
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
  const incident = incomingDir.clone().normalize();
  const mediumIor = sanitizeIor(currentMediumIor);
  const materialIor = sanitizeIor(material.ior);
  const nextMediumIorForTransmission = frontFace ? materialIor : 1;
  const cosTheta = clamp(-Vector3.Dot(incident, shadingNormal), 0, 1);
  const dielectricF0 = fresnelF0FromIorPair(mediumIor, nextMediumIorForTransmission);
  const fresnel = schlickFresnel(cosTheta, Math.max(dielectricF0, material.reflectance));

  let reflectWeight = clamp01Safe(Math.max(material.reflectance, material.metallic));
  let transmitWeight = clamp01Safe(material.transmission * material.opacity);
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

  if (xi < transmitWeight) {
    const refracted = refractDirectionAcrossInterface(
      incident,
      frontFace ? outwardNormal : outwardNormal.scale(-1),
      mediumIor,
      nextMediumIorForTransmission,
    );
    const continuedDirection = refracted ?? reflectDirection(incident, shadingNormal);
    const direction = jitterDirection(
      continuedDirection,
      clamp(roughness * 0.35, 0, 0.4),
      pixelIndex,
      sampleIndex,
      bounce,
      17,
    );
    if (!direction) return null;
    const tint = lerpVec3(new Vector3(1, 1, 1), material.baseColor, 0.2);
    return {
      direction,
      throughput: tint.scale(Math.max(0.15, transmitWeight / total)),
      nextMediumIor: refracted ? nextMediumIorForTransmission : mediumIor,
    };
  }

  if (xi < transmitWeight + reflectWeight) {
    const reflected = reflectDirection(incident, shadingNormal);
    const direction = jitterDirection(
      reflected,
      clamp(roughness * 0.6, 0, 0.75),
      pixelIndex,
      sampleIndex,
      bounce,
      23,
    );
    if (!direction) return null;
    const specColor = lerpVec3(new Vector3(1, 1, 1), material.baseColor, material.metallic);
    return {
      direction,
      throughput: specColor.scale(Math.max(0.1, reflectWeight / total)),
      nextMediumIor: mediumIor,
    };
  }

  const diffuseDir = cosineSampleHemisphere(shadingNormal, pixelIndex, sampleIndex, bounce, 29);
  if (!diffuseDir) {
    return null;
  }
  return {
    direction: diffuseDir,
    throughput: material.baseColor.scale(Math.max(0.1, diffuseWeight / total)),
    nextMediumIor: mediumIor,
  };
}

function isShadowedDirectional(
  scene: WorkerSceneState,
  hitPoint: Vector3,
  normal: Vector3,
  lightDir: Vector3,
  hitMeshIndex: number,
): boolean {
  const origin = hitPoint.add(normal.scale(0.0035));
  const shadowRay = new Ray(origin, lightDir, 1e6);
  return hasAnyTraceHit(scene, shadowRay, hitMeshIndex);
}

function isShadowedPoint(
  scene: WorkerSceneState,
  hitPoint: Vector3,
  normal: Vector3,
  lightDir: Vector3,
  lightDistance: number,
  hitMeshIndex: number,
): boolean {
  const origin = hitPoint.add(normal.scale(0.0035));
  const shadowRay = new Ray(origin, lightDir, Math.max(0, lightDistance - 0.005));
  return hasAnyTraceHit(scene, shadowRay, hitMeshIndex, lightDistance - 0.005);
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
        const triangleHit = intersectTraceTriangleAccelClosest(ray, entry.triangleAccel, bestDistance);
        if (!triangleHit) {
          continue;
        }
        bestDistance = triangleHit.distance;
        bestHit = {
          distance: triangleHit.distance,
          point: triangleHit.point,
          normal: triangleHit.normal,
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
        if (intersectTraceTriangleAccelAny(ray, entry.triangleAccel, limit)) {
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

function cosineSampleHemisphere(
  normal: Vector3,
  pixelIndex: number,
  sampleIndex: number,
  bounce: number,
  dimensionOffset: number,
): Vector3 | null {
  const n = normal.clone();
  if (n.lengthSquared() < 1e-12) {
    return null;
  }
  n.normalize();
  const tangent = orthonormalTangent(n);
  if (!tangent) return null;
  const bitangent = Vector3.Cross(n, tangent).normalize();
  const u1 = sampleHash01(pixelIndex, sampleIndex + bounce * 53, dimensionOffset);
  const u2 = sampleHash01(pixelIndex, sampleIndex + bounce * 53, dimensionOffset + 1);
  const r = Math.sqrt(u1);
  const theta = 2 * Math.PI * u2;
  const x = r * Math.cos(theta);
  const y = r * Math.sin(theta);
  const z = Math.sqrt(Math.max(0, 1 - u1));
  const dir = tangent.scale(x).add(bitangent.scale(y)).add(n.scale(z));
  if (dir.lengthSquared() < 1e-12) return null;
  return dir.normalize();
}

function jitterDirection(
  direction: Vector3,
  amount: number,
  pixelIndex: number,
  sampleIndex: number,
  bounce: number,
  dimensionOffset: number,
): Vector3 | null {
  const d = direction.clone();
  if (d.lengthSquared() < 1e-12) {
    return null;
  }
  d.normalize();
  const jitterAmount = clamp(amount, 0, 1);
  if (jitterAmount <= 1e-5) {
    return d;
  }
  const tangent = orthonormalTangent(d);
  if (!tangent) return d;
  const bitangent = Vector3.Cross(d, tangent).normalize();
  const u1 = sampleHash01(pixelIndex, sampleIndex + bounce * 61, dimensionOffset) * 2 - 1;
  const u2 = sampleHash01(pixelIndex, sampleIndex + bounce * 61, dimensionOffset + 1) * 2 - 1;
  const jittered = d
    .scale(1)
    .add(tangent.scale(u1 * jitterAmount))
    .add(bitangent.scale(u2 * jitterAmount));
  if (jittered.lengthSquared() < 1e-12) {
    return d;
  }
  return jittered.normalize();
}

function orthonormalTangent(normal: Vector3): Vector3 | null {
  const n = normal.clone();
  if (n.lengthSquared() < 1e-12) return null;
  n.normalize();
  const up = Math.abs(n.z) > 0.95 ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
  const tangent = Vector3.Cross(up, n);
  if (tangent.lengthSquared() < 1e-12) return null;
  return tangent.normalize();
}

function reflectDirection(incident: Vector3, normal: Vector3): Vector3 {
  const n = normal.clone().normalize();
  return incident.subtract(n.scale(2 * Vector3.Dot(incident, n))).normalize();
}

function refractDirectionAcrossInterface(
  incident: Vector3,
  interfaceNormal: Vector3,
  etaI: number,
  etaT: number,
): Vector3 | null {
  const i = incident.clone().normalize();
  const n = interfaceNormal.clone().normalize();
  const ei = sanitizeIor(etaI);
  const et = sanitizeIor(etaT);
  const eta = ei / et;
  const cosI = clamp(-Vector3.Dot(i, n), -1, 1);
  const sinT2 = eta * eta * Math.max(0, 1 - cosI * cosI);
  if (sinT2 > 1) {
    return null;
  }
  const cosT = Math.sqrt(Math.max(0, 1 - sinT2));
  const t = i.scale(eta).add(n.scale(eta * cosI - cosT));
  if (t.lengthSquared() < 1e-12) {
    return null;
  }
  return t.normalize();
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

function multiplyVec3(a: Vector3, b: Vector3): Vector3 {
  return new Vector3(a.x * b.x, a.y * b.y, a.z * b.z);
}

function lerpVec3(a: Vector3, b: Vector3, t: number): Vector3 {
  const k = clamp01Safe(t);
  return new Vector3(
    a.x + (b.x - a.x) * k,
    a.y + (b.y - a.y) * k,
    a.z + (b.z - a.z) * k,
  );
}

export {};
