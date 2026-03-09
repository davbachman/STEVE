import { describe, expect, it } from 'vitest';
import { serializePlotGeometryAsAsciiStl } from '../meshExport';

describe('mesh export', () => {
  it('serializes triangle geometry to ASCII STL with translation applied', () => {
    const stl = serializePlotGeometryAsAsciiStl(
      'Test Plot',
      {
        positions: new Float32Array([
          0, 0, 0,
          1, 0, 0,
          0, 1, 0,
        ]),
        indices: new Uint32Array([0, 1, 2]),
      },
      { x: 2, y: -1, z: 3 },
    );

    expect(stl).toContain('solid Test Plot');
    expect(stl).toContain('facet normal 0.000000 0.000000 1.000000');
    expect(stl).toContain('vertex 2.000000 -1.000000 3.000000');
    expect(stl).toContain('vertex 3.000000 -1.000000 3.000000');
    expect(stl).toContain('vertex 2.000000 0.000000 3.000000');
    expect(stl).toContain('endsolid Test Plot');
  });
});
