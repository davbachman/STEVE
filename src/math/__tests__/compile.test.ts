import { describe, expect, it } from 'vitest';
import type { PlotObject } from '../../types/contracts';
import { analyzeEquationText } from '../classifier';
import { compilePlotObject } from '../compile';

function explicitPlot(rawText: string, parameters: Array<{ name: string; value: number }>): PlotObject {
  const analyzed = analyzeEquationText(rawText);
  return {
    id: 'plot',
    name: 'plot',
    type: 'plot',
    visible: true,
    transform: { position: { x: 0, y: 0, z: 0 } },
    equation: {
      kind: 'explicit_surface',
      source: analyzed.source,
      parameters: parameters.map((parameter) => ({
        ...parameter,
        min: -10,
        max: 10,
        step: 0.1,
      })),
      solvedAxis: analyzed.explicitAxis ?? 'z',
      domainAxes: analyzed.explicitDomainAxes ?? ['x', 'y'],
      domain: { uMin: -2, uMax: 2, vMin: -2, vMax: 2, uSamples: 32, vSamples: 32 },
      compileAsParametric: true,
    },
    material: {
      baseColor: '#ffffff',
      opacity: 1,
      reflectiveness: 0,
      roughness: 0.5,
    },
  };
}

describe('plot compilation with parameters', () => {
  it('injects parameter values into explicit surfaces', () => {
    const compiled = compilePlotObject(explicitPlot('z = a*x + b*y + c', [
      { name: 'a', value: 2 },
      { name: 'b', value: -1 },
      { name: 'c', value: 3.5 },
    ]));

    expect(compiled.kind).toBe('surface');
    if (compiled.kind !== 'surface') {
      throw new Error('Expected surface');
    }

    expect(compiled.fn(4, 1.5)).toEqual([4, 1.5, 10]);
  });
});
