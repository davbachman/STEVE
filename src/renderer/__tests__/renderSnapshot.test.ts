import { describe, expect, it } from 'vitest';
import { createDefaultImplicit, createDefaultSurface, defaultRenderSettings, defaultSceneSettings } from '../../state/defaults';
import type { PlotJobStatus } from '../../types/contracts';
import {
  INTERACTIVE_OPAQUE_OPACITY_EPSILON,
  INTERACTIVE_RENDERABLE_OPACITY_EPSILON,
  INTERACTIVE_SHELL_RENDER_OPACITY_EPSILON,
  classifyInteractiveShadowMode,
  classifyPlotOpacity,
  createRendererSceneSnapshot,
  resolveDirectionalShadowFrustumSize,
  selectInteractiveReflectionSource,
  shouldPlotCastInteractiveShadows,
  shouldShowPlotWireframe,
  shouldUseTransparentBackShell,
  shouldUseShellSelectionHalo,
} from '../renderSnapshot';

function idlePlotJob(meshVersion = 0): PlotJobStatus {
  return {
    parsePhase: 'ready',
    meshPhase: 'ready',
    progress: 1,
    hasPreview: false,
    meshVersion,
  };
}

describe('renderSnapshot helpers', () => {
  it('classifies opacity into hidden, transparent, and opaque bands', () => {
    expect(classifyPlotOpacity(0)).toBe('hidden');
    expect(classifyPlotOpacity(INTERACTIVE_RENDERABLE_OPACITY_EPSILON)).toBe('hidden');
    expect(classifyPlotOpacity(INTERACTIVE_RENDERABLE_OPACITY_EPSILON + 0.001)).toBe('transparent');
    expect(classifyPlotOpacity(INTERACTIVE_OPAQUE_OPACITY_EPSILON - 0.001)).toBe('transparent');
    expect(classifyPlotOpacity(INTERACTIVE_OPAQUE_OPACITY_EPSILON)).toBe('opaque');
    expect(classifyPlotOpacity(1.5)).toBe('opaque');
  });

  it('keeps wireframe visibility literal and shadow participation renderable-only', () => {
    const surface = createDefaultSurface('Wireframe Surface');
    surface.visible = true;
    surface.material.opacity = 0.72;
    surface.material.wireframeVisible = false;

    expect(shouldShowPlotWireframe(surface)).toBe(false);
    expect(classifyInteractiveShadowMode(surface)).toBe('attenuated');
    expect(shouldPlotCastInteractiveShadows(surface)).toBe(true);

    surface.material.wireframeVisible = true;
    expect(shouldShowPlotWireframe(surface)).toBe(true);

    surface.material.opacity = INTERACTIVE_RENDERABLE_OPACITY_EPSILON;
    expect(classifyInteractiveShadowMode(surface)).toBe('attenuated');
    expect(shouldPlotCastInteractiveShadows(surface)).toBe(true);

    surface.material.opacity = 1;
    expect(classifyInteractiveShadowMode(surface)).toBe('solid');
    expect(shouldPlotCastInteractiveShadows(surface)).toBe(true);
  });

  it('builds plot snapshots with shells only once surfaces are clearly translucent', () => {
    const surface = createDefaultSurface('Glass Surface');
    surface.material.opacity = INTERACTIVE_SHELL_RENDER_OPACITY_EPSILON - 0.01;
    surface.material.wireframeVisible = true;

    const nearOpaqueSurface = createDefaultSurface('Near Opaque Surface');
    nearOpaqueSurface.material.opacity = 0.97;

    const implicit = createDefaultImplicit('Opaque Implicit');
    implicit.material.opacity = 0.6;

    const snapshot = createRendererSceneSnapshot(
      {
        scene: defaultSceneSettings(),
        render: defaultRenderSettings(),
        objects: [surface, nearOpaqueSurface, implicit],
        selectedId: surface.id,
        plotJobs: {
          [surface.id]: idlePlotJob(7),
          [nearOpaqueSurface.id]: idlePlotJob(5),
          [implicit.id]: idlePlotJob(3),
        },
      },
      null,
    );

    const surfaceSnapshot = snapshot.plots.find((entry) => entry.plot.id === surface.id);
    const nearOpaqueSnapshot = snapshot.plots.find((entry) => entry.plot.id === nearOpaqueSurface.id);
    const implicitSnapshot = snapshot.plots.find((entry) => entry.plot.id === implicit.id);

    expect(surfaceSnapshot).toMatchObject({
      meshVersion: 7,
      opacityClass: 'transparent',
      isRenderable: true,
      showsWireframe: true,
      castsInteractiveShadows: true,
      interactiveShadowMode: 'attenuated',
      usesTransparentShells: true,
    });
    expect(nearOpaqueSnapshot).toMatchObject({
      meshVersion: 5,
      opacityClass: 'transparent',
      castsInteractiveShadows: true,
      interactiveShadowMode: 'solid',
      usesTransparentShells: false,
    });
    expect(implicitSnapshot).toMatchObject({
      meshVersion: 3,
      opacityClass: 'transparent',
      usesTransparentShells: false,
      castsInteractiveShadows: true,
      interactiveShadowMode: 'attenuated',
    });
  });

  it('uses shell selection halos only for implicit surfaces', () => {
    const surface = createDefaultSurface('Selected Surface');
    const implicit = createDefaultImplicit('Selected Implicit');

    expect(shouldUseShellSelectionHalo(surface, { isClosedManifold: true })).toBe(false);
    expect(shouldUseShellSelectionHalo(implicit, { isClosedManifold: false })).toBe(false);
    expect(shouldUseShellSelectionHalo(implicit, { isClosedManifold: true })).toBe(true);
  });

  it('uses transparent back shells for open implicits but not closed ones', () => {
    const surface = createDefaultSurface('Transparent Surface');
    surface.material.opacity = 0.7;
    const implicit = createDefaultImplicit('Open Implicit');
    implicit.material.opacity = 0.7;

    expect(shouldUseTransparentBackShell(surface)).toBe(true);
    expect(shouldUseTransparentBackShell(implicit, { isClosedManifold: false })).toBe(true);
    expect(shouldUseTransparentBackShell(implicit, { isClosedManifold: true })).toBe(false);
  });

  it('keeps fully transparent surfaces in the attenuated shadow path', () => {
    const surface = createDefaultSurface('Zero Opacity Surface');
    surface.visible = true;
    surface.material.opacity = 0;

    const snapshot = createRendererSceneSnapshot(
      {
        scene: defaultSceneSettings(),
        render: defaultRenderSettings(),
        objects: [surface],
        selectedId: null,
        plotJobs: {
          [surface.id]: idlePlotJob(2),
        },
      },
      null,
    );

    expect(snapshot.plots[0]).toMatchObject({
      opacityClass: 'hidden',
      isRenderable: false,
      castsInteractiveShadows: true,
      interactiveShadowMode: 'attenuated',
      usesTransparentShells: true,
    });
  });

  it('prefers external environments, then fallback, then none', () => {
    expect(selectInteractiveReflectionSource({
      externalEnvironmentUsable: true,
      fallbackEnvironmentUsable: true,
    })).toBe('external_env');

    expect(selectInteractiveReflectionSource({
      externalEnvironmentUsable: false,
      fallbackEnvironmentUsable: true,
    })).toBe('fallback_ready');

    expect(selectInteractiveReflectionSource({
      externalEnvironmentUsable: false,
      fallbackEnvironmentUsable: false,
    })).toBe('none');
  });

  it('keeps hidden helper extents out of the directional shadow frustum', () => {
    const scene = defaultSceneSettings();

    expect(resolveDirectionalShadowFrustumSize(scene)).toBe(18);

    scene.groundPlaneVisible = true;
    expect(resolveDirectionalShadowFrustumSize(scene)).toBeCloseTo(38.4);
  });
});
