import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntersectionObject, PlotObject, ProjectFileV1 } from '../../types/contracts';
import {
  createDefaultCurve,
  createDefaultImplicit,
  createDefaultIntersection,
  createDefaultSurface,
  defaultRenderSettings,
  defaultSceneSettings,
  materialPresets,
} from '../defaults';
import { useAppStore } from '../store';

function intersections(): IntersectionObject[] {
  return useAppStore.getState().objects.filter(
    (object): object is IntersectionObject => object.type === 'intersection',
  );
}

function plotAt(index: number): PlotObject {
  const plot = useAppStore.getState().objects.filter(
    (object): object is PlotObject => object.type === 'plot',
  )[index];
  if (!plot) throw new Error(`Expected plot at index ${index}`);
  return plot;
}

describe('intersection object state', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    useAppStore.getState().newProject();
  });

  it('creates independently named intersections with curve defaults', () => {
    useAppStore.getState().setInspectorTab('scene');
    useAppStore.getState().addIntersection();
    useAppStore.getState().addIntersection();

    const [first, second] = intersections();
    expect(first).toMatchObject({
      name: 'Intersection 1',
      type: 'intersection',
      visible: true,
      transform: { position: { x: 0, y: 0, z: 0 } },
      sourceSurfaceIds: [null, null],
      curveStyle: { tubeRadius: 0.06, renderAsTube: true },
    });
    expect(first.material).toEqual(materialPresets.Chrome);
    expect(second.name).toBe('Intersection 2');
    expect(useAppStore.getState().selectedId).toBe(second.id);
    expect(useAppStore.getState().ui.inspectorTab).toBe('object');
  });

  it('reuses the first available auto-name without creating duplicates', () => {
    const store = useAppStore.getState();
    store.addIntersection();
    store.addIntersection();
    const first = intersections()[0];

    store.deleteObject(first.id);
    store.addIntersection();

    expect(intersections().map((intersection) => intersection.name)).toEqual([
      'Intersection 2',
      'Intersection 1',
    ]);
  });

  it('updates intersection curve width with undo history', () => {
    const store = useAppStore.getState();
    store.addIntersection();
    const intersection = intersections()[0];
    const historyCount = useAppStore.getState().historyPast.length;

    store.updateIntersectionCurveStyle(intersection.id, { tubeRadius: 0.1 });

    expect(intersections()[0].curveStyle.tubeRadius).toBe(0.1);
    expect(useAppStore.getState().historyPast).toHaveLength(historyCount + 1);
    useAppStore.getState().undo();
    expect(intersections()[0].curveStyle.tubeRadius).toBe(0.06);
  });

  it('accepts only two distinct existing surface plots as sources', () => {
    const store = useAppStore.getState();
    store.addPlot('surface');
    store.addPlot('graph');
    store.addPlot('implicit');
    store.addPlot('curve');
    store.addIntersection();
    const [parametric, graph, implicit, curve] = [plotAt(0), plotAt(1), plotAt(2), plotAt(3)];
    const intersection = intersections()[0];

    store.setIntersectionSource(intersection.id, 0, parametric.id);
    store.setIntersectionSource(intersection.id, 1, graph.id);
    expect(intersections()[0].sourceSurfaceIds).toEqual([parametric.id, graph.id]);

    const historyCount = useAppStore.getState().historyPast.length;
    store.setIntersectionSource(intersection.id, 1, parametric.id);
    store.setIntersectionSource(intersection.id, 1, curve.id);
    store.setIntersectionSource(intersection.id, 1, 'missing-surface');
    expect(intersections()[0].sourceSurfaceIds).toEqual([parametric.id, graph.id]);
    expect(useAppStore.getState().historyPast).toHaveLength(historyCount);

    store.setIntersectionSource(intersection.id, 1, implicit.id);
    expect(intersections()[0].sourceSurfaceIds).toEqual([parametric.id, implicit.id]);
    store.undo();
    expect(intersections()[0].sourceSurfaceIds).toEqual([parametric.id, graph.id]);
    store.redo();
    expect(intersections()[0].sourceSurfaceIds).toEqual([parametric.id, implicit.id]);

    store.setIntersectionSource(intersection.id, 0, null);
    expect(intersections()[0].sourceSurfaceIds).toEqual([null, implicit.id]);
  });

  it('arms canvas source picking until a valid distinct surface is chosen', () => {
    const store = useAppStore.getState();
    store.addPlot('surface');
    store.addPlot('graph');
    store.addPlot('curve');
    store.addIntersection();
    const [parametric, graph, curve] = [plotAt(0), plotAt(1), plotAt(2)];
    const intersection = intersections()[0];

    store.beginIntersectionSourcePick(intersection.id, 0);
    expect(useAppStore.getState().ui.intersectionSourcePick).toEqual({ intersectionId: intersection.id, slot: 0 });
    store.setIntersectionSource(intersection.id, 0, curve.id);
    expect(useAppStore.getState().ui.intersectionSourcePick).toEqual({ intersectionId: intersection.id, slot: 0 });

    store.setIntersectionSource(intersection.id, 0, parametric.id);
    expect(intersections()[0].sourceSurfaceIds).toEqual([parametric.id, null]);
    expect(useAppStore.getState().ui.intersectionSourcePick).toBeNull();

    store.beginIntersectionSourcePick(intersection.id, 1);
    store.setIntersectionSource(intersection.id, 1, parametric.id);
    expect(useAppStore.getState().ui.intersectionSourcePick).toEqual({ intersectionId: intersection.id, slot: 1 });
    store.setIntersectionSource(intersection.id, 1, graph.id);
    expect(intersections()[0].sourceSurfaceIds).toEqual([parametric.id, graph.id]);
    expect(useAppStore.getState().ui.intersectionSourcePick).toBeNull();

    store.beginIntersectionSourcePick(intersection.id, 0);
    store.setInspectorTab('material');
    expect(useAppStore.getState().ui.intersectionSourcePick).toBeNull();
  });

  it('supports plot material actions and independent visibility without moving', () => {
    const store = useAppStore.getState();
    store.addIntersection();
    const intersection = intersections()[0];

    store.updatePlotMaterial(intersection.id, { baseColor: '#c026d3', opacity: 0.4 });
    store.applyMaterialPreset(intersection.id, 'Clear Glass');
    store.setObjectVisibility(intersection.id, false);
    expect(intersections()[0]).toMatchObject({
      visible: false,
      material: {
        baseColor: materialPresets['Clear Glass'].baseColor,
        opacity: materialPresets['Clear Glass'].opacity,
        presetName: 'Clear Glass',
      },
    });

    const historyCount = useAppStore.getState().historyPast.length;
    store.setObjectPosition(intersection.id, { x: 4, y: -3, z: 2 });
    store.beginObjectDragHistory(intersection.id);
    expect(intersections()[0].transform.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(useAppStore.getState().activeObjectDragHistory).toBeNull();
    expect(useAppStore.getState().historyPast).toHaveLength(historyCount);
  });

  it('retains source references without offset when duplicated or copy-pasted', async () => {
    const store = useAppStore.getState();
    store.addPlot('surface');
    store.addPlot('implicit');
    store.addIntersection();
    const [firstSurface, secondSurface] = [plotAt(0), plotAt(1)];
    const original = intersections()[0];
    store.setIntersectionSource(original.id, 0, firstSurface.id);
    store.setIntersectionSource(original.id, 1, secondSurface.id);

    store.duplicateObject(original.id);
    const duplicate = intersections()[1];
    expect(duplicate.sourceSurfaceIds).toEqual([firstSurface.id, secondSurface.id]);
    expect(duplicate.transform.position).toEqual({ x: 0, y: 0, z: 0 });

    store.selectObject(original.id);
    await store.copySelectedToClipboard();
    await useAppStore.getState().pasteClipboard();
    const pasted = intersections()[2];
    expect(pasted.sourceSurfaceIds).toEqual([firstSurface.id, secondSurface.id]);
    expect(pasted.transform.position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('clears stale source references when an internally copied intersection is pasted later', async () => {
    const store = useAppStore.getState();
    store.addPlot('surface');
    store.addIntersection();
    const surface = plotAt(0);
    const original = intersections()[0];
    store.setIntersectionSource(original.id, 0, surface.id);
    store.selectObject(original.id);
    await store.copySelectedToClipboard();

    store.deleteObject(surface.id);
    await useAppStore.getState().pasteClipboard();

    expect(intersections().at(-1)?.sourceSurfaceIds).toEqual([null, null]);
  });

  it('normalizes malformed external intersection clipboard JSON before insertion', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: vi.fn(async () => JSON.stringify({ id: 'external', type: 'intersection' })),
      },
    });

    await useAppStore.getState().pasteClipboard();

    const pasted = intersections()[0];
    expect(pasted).toMatchObject({
      type: 'intersection',
      visible: true,
      transform: { position: { x: 0, y: 0, z: 0 } },
      sourceSurfaceIds: [null, null],
      curveStyle: { tubeRadius: 0.06, renderAsTube: true },
    });
    expect(pasted.material).toEqual(materialPresets.Chrome);
  });

  it('clears a deleted source in the same undoable edit', () => {
    const store = useAppStore.getState();
    store.addPlot('surface');
    store.addPlot('implicit');
    store.addIntersection();
    const [firstSurface, secondSurface] = [plotAt(0), plotAt(1)];
    const intersection = intersections()[0];
    store.setIntersectionSource(intersection.id, 0, firstSurface.id);
    store.setIntersectionSource(intersection.id, 1, secondSurface.id);

    store.deleteObject(firstSurface.id);
    expect(intersections()[0].sourceSurfaceIds).toEqual([null, secondSurface.id]);
    store.undo();
    expect(useAppStore.getState().objects.some((object) => object.id === firstSurface.id)).toBe(true);
    expect(intersections()[0].sourceSurfaceIds).toEqual([firstSurface.id, secondSurface.id]);
  });

  it('clears a source converted into a curve and restores it on undo', () => {
    const store = useAppStore.getState();
    store.addPlot('surface');
    store.addIntersection();
    const surface = plotAt(0);
    const intersection = intersections()[0];
    store.setIntersectionSource(intersection.id, 0, surface.id);

    store.updatePlotEquationText(surface.id, '(cos(t), sin(t), t)');
    expect(plotAt(0).equation.kind).toBe('parametric_curve');
    expect(intersections()[0].sourceSurfaceIds).toEqual([null, null]);
    store.undo();
    expect(plotAt(0).equation.kind).toBe('parametric_surface');
    expect(intersections()[0].sourceSurfaceIds).toEqual([surface.id, null]);
  });

  it('normalizes imported intersections after all source objects are loaded', () => {
    const firstSurface = createDefaultSurface('First Surface');
    const secondSurface = createDefaultImplicit('Second Surface');
    const curve = createDefaultCurve('Not a Surface');
    const duplicateSource = createDefaultIntersection('Duplicate Source');
    duplicateSource.sourceSurfaceIds = [firstSurface.id, firstSurface.id];
    duplicateSource.transform.position = { x: 9, y: 8, z: 7 };
    const invalidSource = createDefaultIntersection('Invalid Source');
    invalidSource.sourceSurfaceIds = [secondSurface.id, curve.id];
    const missingSource = createDefaultIntersection('Missing Source');
    missingSource.sourceSurfaceIds = ['missing', firstSurface.id];

    const project: ProjectFileV1 = {
      schemaVersion: 1,
      appVersion: 'test',
      scene: defaultSceneSettings(),
      render: defaultRenderSettings(),
      objects: [duplicateSource, invalidSource, missingSource, firstSurface, secondSurface, curve],
    };
    useAppStore.getState().replaceProject(project);

    const [first, second, third] = intersections();
    expect(first.sourceSurfaceIds).toEqual([firstSurface.id, null]);
    expect(first.transform.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(second.sourceSurfaceIds).toEqual([secondSurface.id, null]);
    expect(third.sourceSurfaceIds).toEqual([null, firstSurface.id]);
    expect(useAppStore.getState().exportProjectFile().objects).toContainEqual(first);
  });

  it('regenerates duplicate imported IDs and clears references to ambiguous sources', () => {
    const firstSurface = createDefaultSurface('First Surface');
    const secondSurface = createDefaultImplicit('Second Surface');
    secondSurface.id = firstSurface.id;
    const intersection = createDefaultIntersection('Ambiguous Intersection');
    intersection.sourceSurfaceIds = [firstSurface.id, null];

    useAppStore.getState().replaceProject({
      schemaVersion: 1,
      appVersion: 'test',
      scene: defaultSceneSettings(),
      render: defaultRenderSettings(),
      objects: [firstSurface, secondSurface, intersection],
    });

    const objects = useAppStore.getState().objects;
    expect(new Set(objects.map((object) => object.id)).size).toBe(objects.length);
    expect(intersections()[0].sourceSurfaceIds).toEqual([null, null]);
  });
});
