import { describe, expect, it } from 'vitest';
import type { ParametricSurfaceSpec } from '../../../types/contracts';
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
        max: 4,
        step: 0.1,
        samplingMode: 'continuous',
        discreteMin: 1,
        discreteMax: 2,
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

describe('plot mesh families', () => {
  it('merges discrete parameter variants into a single surface mesh', () => {
    const singleVariantMesh = buildSerializedEquationMesh(parametricSurfaceSpec(), {
      wireframeCellSize: 2,
    });
    const familyMesh = buildSerializedEquationMesh(
      {
        ...parametricSurfaceSpec(),
        parameters: [
          {
            ...parametricSurfaceSpec().parameters[0],
            samplingMode: 'discrete',
          },
        ],
      },
      {
        wireframeCellSize: 2,
      },
    );

    expect(singleVariantMesh.positions.length).toBeGreaterThan(0);
    expect(familyMesh.positions.length).toBe(singleVariantMesh.positions.length * 2);
    expect(familyMesh.indices.length).toBe(singleVariantMesh.indices.length * 2);
    expect(familyMesh.bounds?.max.z).toBeCloseTo(2, 4);
    expect(familyMesh.bounds?.min.z).toBeCloseTo(-2, 4);
  });
});
