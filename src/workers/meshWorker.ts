/// <reference lib="webworker" />

import { compilePlotObject } from '../math/compile';
import { buildImplicitMeshFromScalarField } from '../math/mesh/implicitMarchingTetra';
import { buildSurfaceMesh, sampleCurve } from '../math/mesh/parametric';
import type {
  ExplicitSurfaceSpec,
  ImplicitSurfaceSpec,
  ParametricCurveSpec,
  ParametricSurfaceSpec,
  PlotObject,
  SerializedMesh,
  WorkerRequest,
  WorkerResponse,
} from '../types/contracts';

const canceledByObject = new Map<string, number>();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  if (req.type === 'cancel_jobs') {
    canceledByObject.set(req.objectId, Date.now());
    const res: WorkerResponse = { type: 'cancel_ack', jobId: req.jobId, objectId: req.objectId };
    self.postMessage(res);
    return;
  }

  canceledByObject.delete(req.objectId);

  try {
    switch (req.type) {
      case 'build_curve_mesh': {
        emitMeshProgress(req.jobId, req.objectId, 'compile_curve', 0.1);
        const spec = previewCurveSpec(req.spec, req.priority);
        const compiled = compileSpecAsPlot(spec);
        if (compiled.kind !== 'curve') {
          throw new Error('Expected curve compilation');
        }
        if (isCanceled(req.objectId)) return;
        emitMeshProgress(req.jobId, req.objectId, 'sample_curve', 0.6);
        const sample = sampleCurve(spec.tDomain.min, spec.tDomain.max, spec.tDomain.samples, (t) => compiled.fn(t));
        const path = new Float32Array(sample.points.length * 3);
        for (let i = 0; i < sample.points.length; i += 1) {
          const p = sample.points[i];
          path[i * 3] = p.x;
          path[i * 3 + 1] = p.y;
          path[i * 3 + 2] = p.z;
        }
        const mesh: SerializedMesh = {
          positions: new Float32Array(0),
          indices: new Uint32Array(0),
          curvePath: path,
        };
        if (isCanceled(req.objectId)) return;
        postMesh(req.priority === 'preview' ? 'mesh_preview' : 'mesh_final', req.jobId, req.objectId, mesh);
        return;
      }
      case 'build_parametric_mesh': {
        emitMeshProgress(req.jobId, req.objectId, 'compile_surface', 0.12);
        const spec = previewSurfaceSpec(req.spec, req.priority);
        const compiled = compileSpecAsPlot(spec);
        if (compiled.kind !== 'surface') {
          throw new Error('Expected surface compilation');
        }
        if (isCanceled(req.objectId)) return;
        emitMeshProgress(req.jobId, req.objectId, 'mesh_surface', 0.65);
        const mesh = buildSurfaceMesh(
          compiled.spec.domain,
          (u, v) => compiled.fn(u, v),
          req.wireframeCellSize ?? 4,
        );
        if (isCanceled(req.objectId)) return;
        postMesh(req.priority === 'preview' ? 'mesh_preview' : 'mesh_final', req.jobId, req.objectId, mesh);
        return;
      }
      case 'build_implicit_mesh': {
        emitMeshProgress(req.jobId, req.objectId, 'compile_implicit', 0.08);
        const spec = previewImplicitSpec(req.spec, req.priority);
        const compiled = compileSpecAsPlot(spec);
        if (compiled.kind !== 'implicit') {
          throw new Error('Expected implicit compilation');
        }
        if (isCanceled(req.objectId)) return;
        emitMeshProgress(req.jobId, req.objectId, 'mesh_implicit', 0.6);
        const mesh = buildImplicitMeshFromScalarField(
          spec.bounds,
          (x, y, z) => compiled.fn(x, y, z),
          spec.quality,
          spec.isoValue,
        );
        if (isCanceled(req.objectId)) return;
        postMesh(req.priority === 'preview' ? 'mesh_preview' : 'mesh_final', req.jobId, req.objectId, mesh);
        return;
      }
      case 'parse_and_classify':
        return;
    }
  } catch (error) {
    const res: WorkerResponse = {
      type: 'job_error',
      jobId: req.jobId,
      objectId: req.objectId,
      message: error instanceof Error ? error.message : 'meshWorker error',
      recoverable: true,
    };
    self.postMessage(res);
  }
};

function compileSpecAsPlot(
  spec: ParametricCurveSpec | ParametricSurfaceSpec | ExplicitSurfaceSpec | ImplicitSurfaceSpec,
) {
  const plot = {
    id: 'worker',
    name: 'worker',
    type: 'plot',
    visible: true,
    transform: { position: { x: 0, y: 0, z: 0 } },
    equation: spec,
    material: {
      baseColor: '#ffffff',
      opacity: 1,
      transmission: 0,
      reflectiveness: 0,
      roughness: 0.5,
    },
  } as unknown as PlotObject;
  return compilePlotObject(plot);
}

function previewCurveSpec(
  spec: ParametricCurveSpec,
  priority: 'preview' | 'refine' | 'interactive' | 'background',
) {
  if (priority !== 'preview') return spec;
  return {
    ...spec,
    tDomain: {
      ...spec.tDomain,
      samples: Math.max(24, Math.round(spec.tDomain.samples * 0.35)),
    },
  };
}

function previewSurfaceSpec(
  spec: ParametricSurfaceSpec | ExplicitSurfaceSpec,
  priority: 'preview' | 'refine' | 'interactive' | 'background',
): ParametricSurfaceSpec | ExplicitSurfaceSpec {
  if (priority !== 'preview') return spec;
  return {
    ...spec,
    domain: {
      ...spec.domain,
      uSamples: Math.max(12, Math.round(spec.domain.uSamples * 0.4)),
      vSamples: Math.max(12, Math.round(spec.domain.vSamples * 0.4)),
    },
  };
}

function previewImplicitSpec(
  spec: ImplicitSurfaceSpec,
  priority: 'preview' | 'refine' | 'interactive' | 'background',
): ImplicitSurfaceSpec {
  if (priority !== 'preview') return spec;
  const quality =
    spec.quality === 'high'
      ? 'medium'
      : spec.quality === 'medium'
        ? 'draft'
        : 'draft';
  return { ...spec, quality };
}

function emitMeshProgress(jobId: string, objectId: string, phase: string, progress: number): void {
  const res: WorkerResponse = {
    type: 'mesh_progress',
    jobId,
    objectId,
    phase,
    progress,
  };
  self.postMessage(res);
}

function postMesh(
  type: 'mesh_preview' | 'mesh_final',
  jobId: string,
  objectId: string,
  mesh: SerializedMesh,
): void {
  const transferables = collectTransferables(mesh);
  const res: WorkerResponse = { type, jobId, objectId, mesh };
  self.postMessage(res, { transfer: transferables });
}

function collectTransferables(mesh: SerializedMesh): Transferable[] {
  const buffers: Transferable[] = [];
  pushTransferableBuffer(buffers, mesh.positions.buffer);
  pushTransferableBuffer(buffers, mesh.indices.buffer);
  if (mesh.normals) pushTransferableBuffer(buffers, mesh.normals.buffer);
  if (mesh.uvs) pushTransferableBuffer(buffers, mesh.uvs.buffer);
  if (mesh.curvePath) pushTransferableBuffer(buffers, mesh.curvePath.buffer);
  for (const line of mesh.lines ?? []) {
    pushTransferableBuffer(buffers, line.buffer);
  }
  return buffers;
}

function pushTransferableBuffer(target: Transferable[], buffer: ArrayBufferLike): void {
  if (buffer instanceof ArrayBuffer) {
    target.push(buffer);
  }
}

function isCanceled(objectId: string): boolean {
  return canceledByObject.has(objectId);
}

export {};
