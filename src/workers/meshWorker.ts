/// <reference lib="webworker" />

import { buildSerializedEquationMesh } from '../math/mesh/plotMesh';
import type {
  ExplicitSurfaceSpec,
  ImplicitSurfaceSpec,
  ParametricCurveSpec,
  ParametricSurfaceSpec,
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
        if (isCanceled(req.objectId)) return;
        emitMeshProgress(req.jobId, req.objectId, 'sample_curve', 0.6);
        const mesh = buildSerializedEquationMesh(spec);
        if (isCanceled(req.objectId)) return;
        postMesh(meshResponseTypeForPriority(req.priority), req.jobId, req.objectId, mesh);
        return;
      }
      case 'build_parametric_mesh': {
        emitMeshProgress(req.jobId, req.objectId, 'compile_surface', 0.12);
        const spec = previewSurfaceSpec(req.spec, req.priority);
        if (isCanceled(req.objectId)) return;
        emitMeshProgress(req.jobId, req.objectId, 'mesh_surface', 0.65);
        const mesh = buildSerializedEquationMesh(spec, {
          wireframeCellSize: req.wireframeCellSize ?? 4,
          wireframeReferenceSamples: {
            uSamples: req.spec.domain.uSamples,
            vSamples: req.spec.domain.vSamples,
          },
        });
        if (isCanceled(req.objectId)) return;
        postMesh(meshResponseTypeForPriority(req.priority), req.jobId, req.objectId, mesh);
        return;
      }
      case 'build_implicit_mesh': {
        emitMeshProgress(req.jobId, req.objectId, 'compile_implicit', 0.08);
        const spec = previewImplicitSpec(req.spec, req.priority);
        if (isCanceled(req.objectId)) return;
        emitMeshProgress(req.jobId, req.objectId, 'mesh_implicit', 0.6);
        const mesh = buildSerializedEquationMesh(spec);
        if (isCanceled(req.objectId)) return;
        postMesh(meshResponseTypeForPriority(req.priority), req.jobId, req.objectId, mesh);
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

function previewCurveSpec(
  spec: ParametricCurveSpec,
  priority: 'preview' | 'refine' | 'interactive' | 'background',
) {
  if (priority === 'interactive') {
    return {
      ...spec,
      tDomain: {
        ...spec.tDomain,
        samples: Math.max(16, Math.round(spec.tDomain.samples * 0.2)),
      },
    };
  }
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
  if (priority === 'interactive') {
    return {
      ...spec,
      domain: {
        ...spec.domain,
        uSamples: Math.max(10, Math.round(spec.domain.uSamples * 0.25)),
        vSamples: Math.max(10, Math.round(spec.domain.vSamples * 0.25)),
      },
    };
  }
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
  if (priority === 'interactive') {
    return { ...spec, quality: 'draft' };
  }
  if (priority !== 'preview') return spec;
  const quality =
    spec.quality === 'high'
      ? 'medium'
      : spec.quality === 'medium'
        ? 'draft'
        : 'draft';
  return { ...spec, quality };
}

function meshResponseTypeForPriority(priority: 'preview' | 'refine' | 'interactive' | 'background'): 'mesh_preview' | 'mesh_final' {
  return priority === 'refine' || priority === 'background' ? 'mesh_final' : 'mesh_preview';
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
  for (const curvePath of mesh.curvePaths ?? []) {
    pushTransferableBuffer(buffers, curvePath.buffer);
  }
  for (const line of mesh.lines ?? []) {
    pushTransferableBuffer(buffers, line.buffer);
  }
  if (mesh.boundaryEdges) pushTransferableBuffer(buffers, mesh.boundaryEdges.buffer);
  if (mesh.featureEdges) pushTransferableBuffer(buffers, mesh.featureEdges.buffer);
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
