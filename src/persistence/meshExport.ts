import { buildPlotGeometry } from '../renderer/plotGeometry';
import type { PlotGeometry } from '../renderer/plotGeometry';
import type { PlotObject, Vec3 } from '../types/contracts';
import { saveBlobFileWithDialog } from './projectFile';

export async function exportPlotAsStl(plot: PlotObject): Promise<void> {
  await saveBlobFileWithDialog(
    `${sanitizeFileStem(plot.name)}.stl`,
    () => {
      const geometry = buildPlotGeometry(plot);
      if (geometry.indices.length < 3) {
        throw new Error('Selected plot has no exportable triangle mesh');
      }

      const stl = serializePlotGeometryAsAsciiStl(plot.name, geometry, plot.transform.position);
      return new Blob([stl], { type: 'model/stl' });
    },
  );
}

export function serializePlotGeometryAsAsciiStl(
  name: string,
  geometry: Pick<PlotGeometry, 'positions' | 'indices'>,
  translation: Vec3,
): string {
  const solidName = sanitizeSolidName(name);
  const lines = [`solid ${solidName}`];

  for (let i = 0; i + 2 < geometry.indices.length; i += 3) {
    const a = readTranslatedVertex(geometry.positions, geometry.indices[i], translation);
    const b = readTranslatedVertex(geometry.positions, geometry.indices[i + 1], translation);
    const c = readTranslatedVertex(geometry.positions, geometry.indices[i + 2], translation);
    const normal = computeFaceNormal(a, b, c);

    lines.push(`  facet normal ${formatStlNumber(normal.x)} ${formatStlNumber(normal.y)} ${formatStlNumber(normal.z)}`);
    lines.push('    outer loop');
    lines.push(`      vertex ${formatStlNumber(a.x)} ${formatStlNumber(a.y)} ${formatStlNumber(a.z)}`);
    lines.push(`      vertex ${formatStlNumber(b.x)} ${formatStlNumber(b.y)} ${formatStlNumber(b.z)}`);
    lines.push(`      vertex ${formatStlNumber(c.x)} ${formatStlNumber(c.y)} ${formatStlNumber(c.z)}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }

  lines.push(`endsolid ${solidName}`);
  return `${lines.join('\n')}\n`;
}

function readTranslatedVertex(positions: Float32Array, index: number, translation: Vec3): Vec3 {
  const base = index * 3;
  return {
    x: positions[base] + translation.x,
    y: positions[base + 1] + translation.y,
    z: positions[base + 2] + translation.z,
  };
}

function computeFaceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const acz = c.z - a.z;

  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const length = Math.hypot(nx, ny, nz);

  if (length <= 1e-12) {
    return { x: 0, y: 0, z: 0 };
  }

  return {
    x: nx / length,
    y: ny / length,
    z: nz / length,
  };
}

function formatStlNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return value.toFixed(6);
}

function sanitizeSolidName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9 _-]+/g, '_').trim();
  return sanitized || 'plot';
}

function sanitizeFileStem(name: string): string {
  const sanitized = name.replace(/[<>:"/\\|?*]+/g, '-').trim().replace(/[. ]+$/g, '');
  return sanitized || 'plot';
}
