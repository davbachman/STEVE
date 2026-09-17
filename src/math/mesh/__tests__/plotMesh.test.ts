import { describe, expect, it } from 'vitest';
import type { ExplicitSurfaceSpec, ParametricSurfaceSpec } from '../../../types/contracts';
import { createDefaultGraph, createDefaultImplicit } from '../../../state/defaults';
import { analyzeEquationText } from '../../classifier';
import { buildSerializedEquationMesh } from '../plotMesh';

function parametricSurfaceSpec(): ParametricSurfaceSpec {
  return {
    kind: 'parametric_surface',
    source: analyzeEquationText('(u, v, a*u)').source,
    parameters: [
      {
        name: 'a',
        value: 1,
        min: -4,
        max: 2,
        step: 0.1,
        samplingMode: 'continuous',
        discreteCount: 2,
      },
    ],
    domain: {
      uMin: -1,
      uMax: 1,
      vMin: -1,
      vMax: 1,
      uSamples: 8,
      vSamples: 6,
    },
  };
}

function explicitSurfaceSpec(): ExplicitSurfaceSpec {
  return {
    kind: 'explicit_surface',
    source: analyzeEquationText('z = a*x').source,
    parameters: [{
      name: 'a',
      value: 1,
      min: 1,
      max: 2,
      step: 0.1,
      samplingMode: 'discrete',
      discreteCount: 2,
      animating: true,
    }],
    solvedAxis: 'z',
    domainAxes: ['x', 'y'],
    domain: {
      uMin: -1,
      uMax: 1,
      vMin: -1,
      vMax: 1,
      uSamples: 8,
      vSamples: 6,
    },
    compileAsParametric: true,
  };
}

describe('implicit equation meshes', () => {
  it.each(['medium', 'high'] as const)('builds the unit sphere from equation text at %s quality', (quality) => {
    const analyzed = analyzeEquationText('x^2+y^2+z^2=1');
    expect(analyzed.source.parseStatus).toBe('ok');
    expect(analyzed.inferredKind).toBe('implicit_surface');
    expect(analyzed.parameterNames).toEqual([]);

    const defaultSpec = createDefaultImplicit().equation;
    expect(defaultSpec.kind).toBe('implicit_surface');
    if (defaultSpec.kind !== 'implicit_surface') return;

    // A default high-quality plot first builds a medium preview, then its final mesh.
    const mesh = buildSerializedEquationMesh({ ...defaultSpec, source: analyzed.source, quality });
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(mesh.topology?.isClosedManifold).toBe(true);
    expect(mesh.topology?.boundaryEdgeCount).toBe(0);
    expect(mesh.normals?.length).toBe(mesh.positions.length);

    const normals = mesh.normals!;
    for (let offset = 0; offset < mesh.positions.length; offset += 3) {
      const x = mesh.positions[offset];
      const y = mesh.positions[offset + 1];
      const z = mesh.positions[offset + 2];
      const radius = Math.hypot(x, y, z);
      const nx = normals[offset];
      const ny = normals[offset + 1];
      const nz = normals[offset + 2];
      expect([x, y, z, nx, ny, nz].every(Number.isFinite)).toBe(true);
      expect(Math.abs(radius - 1)).toBeLessThan(0.03);
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
      expect((x * nx + y * ny + z * nz) / radius).toBeGreaterThan(0.99);
    }

    const edgeCounts = new Map<string, number>();
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      const triangle = mesh.indices.subarray(offset, offset + 3);
      for (let edge = 0; edge < 3; edge += 1) {
        const a = triangle[edge];
        const b = triangle[(edge + 1) % 3];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }
    expect([...edgeCounts.values()].every((count) => count === 2)).toBe(true);
  });
});

describe('plot mesh families', () => {
  it('shows one snapped discrete copy until playback merges the full family', () => {
    const singleVariantMesh = buildSerializedEquationMesh(parametricSurfaceSpec(), {
      wireframeCellSize: 2,
    });
    const discreteSpec: ParametricSurfaceSpec = {
      ...parametricSurfaceSpec(),
      parameters: [{ ...parametricSurfaceSpec().parameters[0], samplingMode: 'discrete' }],
    };
    const selectedCopyMesh = buildSerializedEquationMesh(discreteSpec, { wireframeCellSize: 2 });
    const familyMesh = buildSerializedEquationMesh({
      ...discreteSpec,
      parameters: discreteSpec.parameters.map((parameter) => ({ ...parameter, animating: true })),
    }, { wireframeCellSize: 2 });

    expect(singleVariantMesh.positions.length).toBeGreaterThan(0);
    expect(selectedCopyMesh.positions.length).toBe(singleVariantMesh.positions.length);
    expect(selectedCopyMesh.indices.length).toBe(singleVariantMesh.indices.length);
    expect(selectedCopyMesh.bounds?.max.z).toBeCloseTo(2, 4);
    expect(selectedCopyMesh.bounds?.min.z).toBeCloseTo(-2, 4);
    expect(familyMesh.positions.length).toBe(singleVariantMesh.positions.length * 2);
    expect(familyMesh.indices.length).toBe(singleVariantMesh.indices.length * 2);
    expect(familyMesh.bounds?.max.z).toBeCloseTo(4, 4);
    expect(familyMesh.bounds?.min.z).toBeCloseTo(-4, 4);
  });

  it('builds discrete families for explicit surfaces', () => {
    const familyMesh = buildSerializedEquationMesh(explicitSurfaceSpec());
    const selectedMesh = buildSerializedEquationMesh({
      ...explicitSurfaceSpec(),
      parameters: explicitSurfaceSpec().parameters.map((parameter) => ({ ...parameter, animating: false })),
    });

    expect(familyMesh.positions.length).toBe(selectedMesh.positions.length * 2);
    expect(familyMesh.indices.length).toBe(selectedMesh.indices.length * 2);
    expect(familyMesh.bounds?.max.z).toBeCloseTo(2, 4);
    expect(familyMesh.bounds?.min.z).toBeCloseTo(-2, 4);
  });

  it('keeps Graph wireframe cells fixed when interactive sampling is reduced', () => {
    const graph = createDefaultGraph('Animated Grid Graph');
    expect(graph.equation.kind).toBe('explicit_surface');
    if (graph.equation.kind !== 'explicit_surface') return;

    const fullSpec: ExplicitSurfaceSpec = {
      ...graph.equation,
      domain: {
        ...graph.equation.domain,
        uSamples: 8,
        vSamples: 6,
      },
    };
    const interactiveSpec: ExplicitSurfaceSpec = {
      ...fullSpec,
      domain: {
        ...fullSpec.domain,
        uSamples: 4,
        vSamples: 3,
      },
    };
    const fullMesh = buildSerializedEquationMesh(fullSpec, { wireframeCellSize: 2 });
    const interactiveMesh = buildSerializedEquationMesh(interactiveSpec, {
      wireframeCellSize: 2,
      wireframeReferenceSamples: fullSpec.domain,
    });

    expect(interactiveMesh.lines).toHaveLength(fullMesh.lines?.length ?? 0);
    expect(interactiveMesh.lines?.slice(0, 3).map((line) => line[1])).toEqual(
      fullMesh.lines?.slice(0, 3).map((line) => line[1]),
    );
    expect(interactiveMesh.lines?.slice(3).map((line) => line[0])).toEqual(
      fullMesh.lines?.slice(3).map((line) => line[0]),
    );

    const surfaceVertices = new Set<string>();
    for (let offset = 0; offset < interactiveMesh.positions.length; offset += 3) {
      surfaceVertices.add([
        interactiveMesh.positions[offset],
        interactiveMesh.positions[offset + 1],
        interactiveMesh.positions[offset + 2],
      ].join('|'));
    }
    for (const line of interactiveMesh.lines ?? []) {
      for (let offset = 0; offset < line.length; offset += 3) {
        expect(surfaceVertices.has([line[offset], line[offset + 1], line[offset + 2]].join('|'))).toBe(true);
      }
    }
  });
});
