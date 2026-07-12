import { beforeEach, describe, expect, it } from 'vitest';
import type { PlotObject } from '../../types/contracts';
import { materialPresets } from '../defaults';
import { useAppStore } from '../store';

describe('material preset application', () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
    useAppStore.getState().addPlot('surface');
  });

  it('preserves wireframe and contour decorations when changing presets', () => {
    const plot = useAppStore.getState().objects[0] as PlotObject;
    const decorations = {
      wireframeVisible: true,
      wireframeCellSize: 9,
      wireframeColor: '#22d3ee',
      xContoursVisible: true,
      xContourSpacing: 0.7,
      xContourColor: '#ef4444',
      yContoursVisible: false,
      yContourSpacing: 1.3,
      yContourColor: '#22c55e',
      zContoursVisible: true,
      zContourSpacing: 2.1,
      zContourColor: '#3b82f6',
    };
    useAppStore.getState().updatePlotMaterial(plot.id, decorations);

    useAppStore.getState().applyMaterialPreset(plot.id, 'Clear Glass');

    const material = (useAppStore.getState().objects[0] as PlotObject).material;
    expect(material).toMatchObject(decorations);
    expect(material).toMatchObject({
      baseColor: materialPresets['Clear Glass'].baseColor,
      opacity: materialPresets['Clear Glass'].opacity,
      reflectiveness: materialPresets['Clear Glass'].reflectiveness,
      roughness: materialPresets['Clear Glass'].roughness,
      refractionEnabled: materialPresets['Clear Glass'].refractionEnabled,
      ior: materialPresets['Clear Glass'].ior,
      presetName: 'Clear Glass',
    });
  });
});
