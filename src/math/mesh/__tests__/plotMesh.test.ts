import { describe, expect, it } from 'vitest';
import type { ExplicitSurfaceSpec, ParametricSurfaceSpec } from '../../../types/contracts';
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
});
