export interface PathTraceWorkerVec3 {
  x: number;
  y: number;
  z: number;
}

export interface PathTraceWorkerMaterial {
  baseColor: PathTraceWorkerVec3;
  metallic: number;
  roughness: number;
  reflectance: number;
  ior: number;
  opacity: number;
}

export interface PathTraceWorkerTriangleBvhNode {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  left: PathTraceWorkerTriangleBvhNode | null;
  right: PathTraceWorkerTriangleBvhNode | null;
  triangleIndices: Uint32Array | null;
}

export interface PathTraceWorkerTriangleAccel {
  positionsWorld: Float32Array;
  normalsWorld: Float32Array | null;
  triangleCount: number;
  triangleBvhRoot: PathTraceWorkerTriangleBvhNode | null;
}

export interface PathTraceWorkerLineAccel {
  positionsWorld: Float32Array; // [ax, ay, az, bx, by, bz] per segment
  segmentCount: number;
  intersectionThreshold: number;
}

export interface PathTraceWorkerMeshSnapshot {
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
  material: PathTraceWorkerMaterial;
  triangleAccel: PathTraceWorkerTriangleAccel | null;
  lineAccel: PathTraceWorkerLineAccel | null;
}

export type PathTraceWorkerLight =
  | {
      kind: 'hemispheric';
      direction: PathTraceWorkerVec3;
      diffuse: PathTraceWorkerVec3;
      ground: PathTraceWorkerVec3;
      intensity: number;
    }
  | {
      kind: 'directional';
      direction: PathTraceWorkerVec3;
      diffuse: PathTraceWorkerVec3;
      intensity: number;
    }
  | {
      kind: 'point';
      position: PathTraceWorkerVec3;
      diffuse: PathTraceWorkerVec3;
      intensity: number;
      range: number;
    };

export interface PathTraceWorkerSceneSnapshot {
  version: number;
  clearColor: PathTraceWorkerVec3;
  ambientColor: PathTraceWorkerVec3;
  meshes: PathTraceWorkerMeshSnapshot[];
  lights: PathTraceWorkerLight[];
}

export interface PathTraceWorkerRenderParams {
  qualityMaxBounces: number;
}

export type PathTraceWorkerRequest =
  | {
      type: 'init_scene';
      scene: PathTraceWorkerSceneSnapshot;
    }
  | {
      type: 'trace_batch';
      requestId: number;
      sceneVersion: number;
      sampleIndex: number;
      render: PathTraceWorkerRenderParams;
      pixelIndices: Uint32Array;
      rays: Float32Array; // [ox, oy, oz, dx, dy, dz] per pixel
    }
  | {
      type: 'dispose';
    };

export type PathTraceWorkerResponse =
  | { type: 'scene_ready'; sceneVersion: number }
  | { type: 'scene_error'; sceneVersion: number; message: string }
  | {
      type: 'trace_batch_result';
      requestId: number;
      sceneVersion: number;
      samples: Float32Array; // [r, g, b, a] per pixel
    }
  | {
      type: 'trace_batch_error';
      requestId: number;
      sceneVersion: number;
      message: string;
    };
