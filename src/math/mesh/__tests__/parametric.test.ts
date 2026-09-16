import { describe, expect, it } from 'vitest';
import type { ParametricCurveSpec, SerializedMesh } from '../../../types/contracts';
import { analyzeEquationText, analyzeGraphExpression } from '../../classifier';
import { createDefaultGraph } from '../../../state/defaults';
import { buildSurfaceMesh, sampleCurve } from '../parametric';
import { buildSerializedEquationMesh } from '../plotMesh';

const domain = { uMin: -1, uMax: 1, vMin: -1, vMax: 1, uSamples: 12, vSamples: 8 };

function expectNoSurfaceBridge(mesh: SerializedMesh, pole: number, axis = 0) {
  expect(mesh.indices.length).toBeGreaterThan(0);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const coordinates = [0, 1, 2].map((corner) => mesh.positions[mesh.indices[i + corner] * 3 + axis]);
    expect(Math.min(...coordinates) < pole && Math.max(...coordinates) > pole).toBe(false);
  }
  expect(mesh.lines?.length).toBeGreaterThan(0);
  for (const line of mesh.lines ?? []) {
    for (let i = 0; i + 3 < line.length; i += 3) {
      const a = line[i + axis];
      const b = line[i + 3 + axis];
      expect(Math.min(a, b) < pole && Math.max(a, b) > pole).toBe(false);
    }
  }
}

describe('discontinuity-aware surface sampling', () => {
  it.each([0, 0.137, -0.777, 0.001])('leaves a gap in faces and wires across the reciprocal pole at %s', (pole) => {
    const mesh = buildSurfaceMesh(domain, (u, v) => [u, v, 1 / (u - pole)]);
    expectNoSurfaceBridge(mesh, pole);
  });

  it('skips invalid on-grid vertices without inserting wire lines through the origin', () => {
    const mesh = buildSurfaceMesh({ ...domain, uSamples: 13 }, (u, v) => [u, v, 1 / u]);
    expectNoSurfaceBridge(mesh, 0);
    for (const line of mesh.lines ?? []) {
      for (let i = 0; i < line.length; i += 3) expect(line[i]).not.toBe(0);
    }
  });

  it.each([0.125, -0.37])('detects even-order poles with same-sign finite endpoints at %s', (pole) => {
    const mesh = buildSurfaceMesh(domain, (u, v) => [u, v, 1 / (u - pole) ** 2]);
    expectNoSurfaceBridge(mesh, pole);
  });

  it('detects simple and even-order poles throughout a sampling cell', () => {
    for (let phase = 1; phase < 24; phase += 1) {
      const pole = -0.09 + (phase / 24) * 0.18;
      for (const power of [1, 2]) {
        const mesh = buildSurfaceMesh({ ...domain, vSamples: 2 }, (u, v) => [u, v, 1 / (u - pole) ** power]);
        expectNoSurfaceBridge(mesh, pole);
      }
    }
  });

  it('does not depend on the height scale of a reciprocal graph', () => {
    const mesh = buildSurfaceMesh(domain, (u, v) => [u, v, 1e-8 / (u - 0.137)]);
    expectNoSurfaceBridge(mesh, 0.137);
  });

  it('handles poles along either parameter axis and along diagonal edges', () => {
    const mesh = buildSurfaceMesh(domain, (u, v) => [u, v, 1 / (v - 0.19)]);
    expectNoSurfaceBridge(mesh, 0.19, 1);
    const diagonal = buildSurfaceMesh(domain, (u, v) => [u, v, 1 / (u + v - 0.13)]);
    for (let i = 0; i < diagonal.indices.length; i += 3) {
      const sums = [0, 1, 2].map((corner) => {
        const offset = diagonal.indices[i + corner] * 3;
        return diagonal.positions[offset] + diagonal.positions[offset + 1];
      });
      expect(Math.min(...sums) < 0.13 && Math.max(...sums) > 0.13).toBe(false);
    }
  });

  it('cuts both tangent poles although their sampled values are finite', () => {
    const mesh = buildSurfaceMesh({ ...domain, uMin: -2, uMax: 2 }, (u, v) => [u, v, Math.tan(u)]);
    expectNoSurfaceBridge(mesh, -Math.PI / 2);
    expectNoSurfaceBridge(mesh, Math.PI / 2);
  });

  it('does not keep an isolated wire at a floating-point approximation of a pole', () => {
    const mesh = buildSurfaceMesh({ ...domain, uMin: 0, uMax: Math.PI, uSamples: 9 }, (u, v) => [u, v, Math.tan(u)]);
    expectNoSurfaceBridge(mesh, Math.PI / 2);
    expect(mesh.bounds?.min.z).toBeGreaterThan(-3);
    expect(mesh.bounds?.max.z).toBeLessThan(3);
  });

  it('omits invalid sqrt regions from faces, wires and bounds', () => {
    const mesh = buildSurfaceMesh(domain, (u, v) => [u + 10, v + 20, Math.sqrt(u) + 30]);
    expect(mesh.indices.length).toBeGreaterThan(0);
    for (const index of mesh.indices) expect(mesh.positions[index * 3]).toBeGreaterThanOrEqual(10);
    for (const line of mesh.lines ?? []) {
      for (let i = 0; i < line.length; i += 3) {
        expect(line[i]).toBeGreaterThanOrEqual(10);
        expect(line[i + 2]).toBeGreaterThanOrEqual(30);
      }
    }
    expect(mesh.bounds?.min.x).toBeGreaterThanOrEqual(10);
    expect(mesh.bounds?.min.y).toBeGreaterThanOrEqual(19);
    expect(mesh.bounds?.min.z).toBeGreaterThanOrEqual(30);
  });

  it('keeps a very steep continuous plane complete', () => {
    const mesh = buildSurfaceMesh(domain, (u, v) => [u, v, 1e12 * u - 1e10 * v]);
    expect(mesh.indices.length).toBe((domain.uSamples - 1) * (domain.vSamples - 1) * 6);
    expect(mesh.lines).toHaveLength(domain.uSamples + domain.vSamples);
  });

  it('keeps smooth high-curvature and periodic parametric surfaces complete', () => {
    const paraboloid = buildSurfaceMesh(domain, (u, v) => [u, v, 1e6 * (u * u + v * v)]);
    expect(paraboloid.indices.length).toBe((domain.uSamples - 1) * (domain.vSamples - 1) * 6);
    const torus = buildSurfaceMesh({ ...domain, uMin: 0, uMax: 2 * Math.PI, vMin: 0, vMax: 2 * Math.PI }, (u, v) => [
      (2 + Math.cos(v)) * Math.cos(u), (2 + Math.cos(v)) * Math.sin(u), Math.sin(v),
    ]);
    expect(torus.indices.length).toBe((domain.uSamples - 1) * (domain.vSamples - 1) * 6);
  });

  it('applies the same discontinuity checks to the Graph expression users enter', () => {
    const graph = createDefaultGraph();
    if (graph.equation.kind !== 'explicit_surface') throw new Error('Expected graph');
    const mesh = buildSerializedEquationMesh({
      ...graph.equation,
      source: analyzeGraphExpression('1/x').source,
      domain,
    });
    expectNoSurfaceBridge(mesh, 0);
  });
});

describe('discontinuity-aware curve sampling', () => {
  it.each([11, 12])('splits reciprocals with %s samples instead of joining across the pole', (samples) => {
    const sample = sampleCurve(-1, 1, samples, (t) => [t, 1 / t, 0]);
    expect(sample.paths).toHaveLength(2);
    for (const path of sample.paths) {
      expect(path.every((point) => point.x < 0) || path.every((point) => point.x > 0)).toBe(true);
    }
  });

  it('splits a finite off-grid pole and an undefined interval', () => {
    const reciprocal = sampleCurve(-1, 1, 12, (t) => [t, 1 / (t - 0.137), 0]);
    expect(reciprocal.paths).toHaveLength(2);
    for (const path of reciprocal.paths) {
      expect(path.every((point) => point.x < 0.137) || path.every((point) => point.x > 0.137)).toBe(true);
    }
    const invalid = sampleCurve(-1, 1, 13, (t) => [t, Math.sqrt(t * t - 0.1), 0]);
    expect(invalid.paths).toHaveLength(2);
    expect(sampleCurve(-1, 1, 2, (t) => [t, Math.sqrt(t * t - 0.1), 0]).paths).toEqual([]);
  });

  it('splits tangent curves at both finite-valued pole crossings', () => {
    const sample = sampleCurve(-2, 2, 20, (t) => [t, Math.tan(t), 0]);
    expect(sample.paths).toHaveLength(3);
    for (const path of sample.paths) {
      for (const pole of [-Math.PI / 2, Math.PI / 2]) {
        expect(path.every((point) => point.x < pole) || path.every((point) => point.x > pole)).toBe(true);
      }
    }
  });

  it('splits finite jumps while preserving continuous steep and curved paths', () => {
    const step = sampleCurve(-1, 1, 12, (t) => [t, t < 0.137 ? -1 : 1, 0]);
    expect(step.paths).toHaveLength(2);
    expect(sampleCurve(-1, 1, 12, (t) => [t, 1e12 * t, 0]).paths[0]).toHaveLength(12);
    expect(sampleCurve(0, 2 * Math.PI, 12, (t) => [Math.cos(t), Math.sin(t), t]).paths[0]).toHaveLength(12);
    expect(sampleCurve(-1, 1, 12, (t) => [t, Math.exp(40 * t), 0]).paths[0]).toHaveLength(12);
  });

  it('serializes split paths individually for rendering and STL conversion', () => {
    const spec: ParametricCurveSpec = {
      kind: 'parametric_curve',
      source: analyzeEquationText('(t, 1/t, 0)').source,
      parameters: [],
      tDomain: { min: -1, max: 1, samples: 12 },
      tubeRadius: 0.05,
      renderAsTube: true,
    };
    const mesh = buildSerializedEquationMesh(spec);
    expect(mesh.curvePath).toBeUndefined();
    expect(mesh.curvePaths).toHaveLength(2);
    expect(mesh.curvePaths?.every((path) => path.length >= 6)).toBe(true);
  });
});
