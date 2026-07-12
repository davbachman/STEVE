import { compileEquationSpec, expandEquationSpecVariants } from '../compile';
import type { EquationSpec, PlotObject, SerializedMesh } from '../../types/contracts';
import { buildImplicitMeshFromScalarField } from './implicitMarchingTetra';
import { computeMeshBounds, mergeMeshBounds, mergeSerializedMeshes } from './geometry';
import { buildSurfaceMesh, sampleCurve } from './parametric';

export function buildSerializedPlotMesh(plot: PlotObject): SerializedMesh {
  return buildSerializedEquationMesh(plot.equation, {
    wireframeCellSize: plot.material.wireframeCellSize ?? 4,
  });
}

export function buildSerializedEquationMesh(
  spec: EquationSpec,
  options: {
    wireframeCellSize?: number;
    wireframeReferenceSamples?: { uSamples: number; vSamples: number };
  } = {},
): SerializedMesh {
  const variants = expandEquationSpecVariants(spec);
  if (variants.length <= 1) {
    return buildSerializedEquationMeshSingle(variants[0] ?? spec, options);
  }
  if (spec.kind === 'parametric_curve') {
    return buildSerializedCurveFamilyMesh(variants);
  }
  return mergeSerializedMeshes(variants.map((variant) => buildSerializedEquationMeshSingle(variant, options)));
}

function buildSerializedEquationMeshSingle(
  spec: EquationSpec,
  options: {
    wireframeCellSize?: number;
    wireframeReferenceSamples?: { uSamples: number; vSamples: number };
  },
): SerializedMesh {
  const compiled = compileEquationSpec(spec);
  if (compiled.kind === 'curve') {
    const sample = sampleCurve(
      compiled.spec.tDomain.min,
      compiled.spec.tDomain.max,
      compiled.spec.tDomain.samples,
      (t) => compiled.fn(t),
    );
    const curvePath = new Float32Array(sample.points.length * 3);
    for (let i = 0; i < sample.points.length; i += 1) {
      const point = sample.points[i];
      const base = i * 3;
      curvePath[base] = point.x;
      curvePath[base + 1] = point.y;
      curvePath[base + 2] = point.z;
    }
    return {
      positions: new Float32Array(0),
      indices: new Uint32Array(0),
      curvePath,
      bounds: computeMeshBounds(curvePath),
      boundaryEdges: new Float32Array(0),
      featureEdges: new Float32Array(0),
      topology: emptyCurveTopology(),
    };
  }
  if (compiled.kind === 'surface') {
    return buildSurfaceMesh(
      compiled.spec.domain,
      (u, v) => compiled.fn(u, v),
      options.wireframeCellSize ?? 4,
      options.wireframeReferenceSamples,
    );
  }
  return buildImplicitMeshFromScalarField(
    compiled.spec.bounds,
    (x, y, z) => compiled.fn(x, y, z),
    compiled.spec.quality,
  );
}

function buildSerializedCurveFamilyMesh(variants: EquationSpec[]): SerializedMesh {
  const curvePaths = variants
    .map((variant) => buildSerializedEquationMeshSingle(variant, {}))
    .flatMap((mesh) => mesh.curvePath ? [mesh.curvePath] : mesh.curvePaths ?? []);
  const bounds = mergeMeshBounds(curvePaths.map((curvePath) => computeMeshBounds(curvePath)));
  return {
    positions: new Float32Array(0),
    indices: new Uint32Array(0),
    curvePaths,
    bounds,
    boundaryEdges: new Float32Array(0),
    featureEdges: new Float32Array(0),
    topology: emptyCurveTopology(),
  };
}

function emptyCurveTopology() {
  return {
    isClosedManifold: false,
    hasBoundaryEdges: false,
    hasFeatureEdges: false,
    boundaryEdgeCount: 0,
    featureEdgeCount: 0,
  } as const;
}
