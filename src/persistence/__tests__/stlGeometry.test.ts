import { afterEach, describe, expect, it } from 'vitest';
import { analyzeEquationText, analyzeGraphExpression } from '../../math/classifier';
import { buildSerializedPlotMesh } from '../../math/mesh/plotMesh';
import { createDefaultGraph, createDefaultIntersection, createDefaultSurface } from '../../state/defaults';
import type { ExplicitSurfaceSpec, ParametricSurfaceSpec, PlotObject } from '../../types/contracts';
import { clearAllRuntimePlotMeshes, getRuntimePlotMesh, setRuntimePlotMesh } from '../../workers/runtimeMeshCache';
import { buildStlExportGeometry } from '../stlGeometry';
import { serializePlotGeometryAsAsciiStl } from '../stlSerialization';

function graph(expression: string): PlotObject & { equation: ExplicitSurfaceSpec } {
  const plot = createDefaultGraph('Export graph');
  if (plot.equation.kind !== 'explicit_surface') throw new Error('Expected graph');
  return {
    ...plot,
    equation: {
      ...plot.equation,
      source: analyzeGraphExpression(expression).source,
      domain: { uMin: -1, uMax: 1, vMin: -1, vMax: 1, uSamples: 12, vSamples: 8 },
    },
  };
}

function surface(expression: string): PlotObject & { equation: ParametricSurfaceSpec } {
  const plot = createDefaultSurface('Source surface');
  if (plot.equation.kind !== 'parametric_surface') throw new Error('Expected surface');
  return {
    ...plot,
    equation: {
      ...plot.equation,
      source: analyzeEquationText(expression).source,
      domain: { uMin: -2, uMax: 2, vMin: -2, vMax: 2, uSamples: 5, vSamples: 5 },
    },
  };
}

afterEach(() => clearAllRuntimePlotMeshes());

describe('current, full-resolution STL geometry', () => {
  it('exports the current equation even when the viewport still caches an earlier mesh', () => {
    const plot = graph('0');
    const cached = buildSerializedPlotMesh(plot);
    setRuntimePlotMesh(plot.id, cached);
    plot.equation.source = analyzeGraphExpression('2*x-y+3').source;

    const exported = buildStlExportGeometry(plot, [plot]);

    expect(exported.indices.length).toBeGreaterThan(0);
    for (let offset = 0; offset < exported.positions.length; offset += 3) {
      const [x, y, z] = exported.positions.slice(offset, offset + 3);
      expect(z).toBeCloseTo(2 * x - y + 3, 5);
    }
    expect(getRuntimePlotMesh(plot.id)).toBe(cached);
    expect(cached.positions[2]).toBe(0);
  });

  it('uses the requested sampling instead of a cached interactive preview', () => {
    const plot = graph('x^2-y^2');
    const preview = {
      ...plot,
      equation: { ...plot.equation, domain: { ...plot.equation.domain, uSamples: 4, vSamples: 3 } },
    };
    const cached = buildSerializedPlotMesh(preview);
    setRuntimePlotMesh(plot.id, cached);

    const exported = buildStlExportGeometry(plot, [plot]);

    expect(exported.positions.length / 3).toBe(12 * 8);
    expect(exported.indices.length / 3).toBe(2 * (12 - 1) * (8 - 1));
    expect(exported.indices.length).toBeGreaterThan(cached.indices.length);
    const stl = serializePlotGeometryAsAsciiStl(plot.name, exported, plot.transform.position);
    expect(stl.match(/facet normal/g)).toHaveLength(154);
  });

  it.each(['sin(', '1 + * x'])('rejects the invalid current equation %s despite a valid old cache', (expression) => {
    const plot = graph('x+y');
    setRuntimePlotMesh(plot.id, buildSerializedPlotMesh(plot));
    plot.equation.source = analyzeGraphExpression(expression).source;

    expect(plot.equation.source.parseStatus).not.toBe('ok');
    expect(() => buildStlExportGeometry(plot, [plot])).toThrow(/Fix the equation/);
  });

  it('does not export the old cache when parsing has not yet updated the source status', () => {
    const plot = graph('x+y');
    setRuntimePlotMesh(plot.id, buildSerializedPlotMesh(plot));
    plot.equation.source.rawText = 'sin(';

    expect(() => buildStlExportGeometry(plot, [plot])).toThrow();
  });

  it('leaves both sides of 1/x disconnected in the actual translated STL triangles', () => {
    const plot = graph('0');
    setRuntimePlotMesh(plot.id, buildSerializedPlotMesh(plot));
    plot.equation.source = analyzeGraphExpression('1/x').source;
    plot.transform.position = { x: 3, y: -2, z: 4 };

    const exported = buildStlExportGeometry(plot, [plot]);
    const stl = serializePlotGeometryAsAsciiStl(plot.name, exported, plot.transform.position);
    const vertices = [...stl.matchAll(/^\s*vertex\s+(\S+)\s+(\S+)\s+(\S+)$/gm)]
      .map((match) => match.slice(1).map(Number));

    expect(vertices.length).toBe(exported.indices.length);
    expect(vertices.some(([x]) => x < 3)).toBe(true);
    expect(vertices.some(([x]) => x > 3)).toBe(true);
    for (let index = 0; index < vertices.length; index += 3) {
      const triangle = vertices.slice(index, index + 3);
      expect(triangle.every(([x]) => x < 3) || triangle.every(([x]) => x > 3)).toBe(true);
      for (const [x, , z] of triangle) expect(z - 4).toBeCloseTo(1 / (x - 3), 3);
    }
  });
});

describe('STL intersection geometry', () => {
  it('recomputes from current source equations and translations despite stale caches for every object', () => {
    const horizontal = surface('(u,v,0)');
    const vertical = surface('(0,u,v)');
    const intersection = createDefaultIntersection();
    intersection.sourceSurfaceIds = [horizontal.id, vertical.id];
    setRuntimePlotMesh(horizontal.id, buildSerializedPlotMesh(horizontal));
    setRuntimePlotMesh(vertical.id, buildSerializedPlotMesh(vertical));
    setRuntimePlotMesh(intersection.id, {
      positions: new Float32Array(),
      indices: new Uint32Array(),
      curvePath: new Float32Array([-99, -1, 0, -99, 1, 0]),
    });
    horizontal.equation.source = analyzeEquationText('(u,v,1)').source;
    horizontal.transform.position = { x: 3, y: 4, z: 5 };
    vertical.transform.position = { x: 4, y: 4, z: 5 };

    const exported = buildStlExportGeometry(intersection, [horizontal, vertical, intersection]);

    expect(exported.indices.length).toBeGreaterThan(0);
    const path = exported.curvePath;
    expect(path).not.toBeNull();
    const yValues: number[] = [];
    for (let offset = 0; offset < path!.length; offset += 3) {
      expect(path![offset]).toBeCloseTo(4, 5);
      expect(path![offset + 2]).toBeCloseTo(6, 5);
      yValues.push(path![offset + 1]);
    }
    expect(Math.min(...yValues)).toBeCloseTo(2, 5);
    expect(Math.max(...yValues)).toBeCloseTo(6, 5);
  });

  it('rejects an invalid or missing current intersection source despite an old intersection mesh', () => {
    const horizontal = surface('(u,v,0)');
    const vertical = surface('(0,u,v)');
    const intersection = createDefaultIntersection();
    intersection.sourceSurfaceIds = [horizontal.id, vertical.id];
    setRuntimePlotMesh(intersection.id, {
      positions: new Float32Array(),
      indices: new Uint32Array(),
      curvePath: new Float32Array([0, -1, 0, 0, 1, 0]),
    });
    horizontal.equation.source = analyzeEquationText('(u,v,').source;

    expect(() => buildStlExportGeometry(intersection, [horizontal, vertical, intersection])).toThrow(/Fix the equation/);
    expect(() => buildStlExportGeometry(intersection, [vertical, intersection])).toThrow(/valid source surfaces/);
  });
});
