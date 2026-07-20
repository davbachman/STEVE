import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewportApi } from '../../../renderer/SceneController';
import { useAppStore } from '../../../state/store';
import { InspectorPanel, RangeField } from '../InspectorPanel';

// React 19 expects the test environment to opt into act() support.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('RangeField numeric entry', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    useAppStore.getState().newProject();
    root = null;
    container = null;
  });

  it('allows clearing the full numeric draft before typing a replacement value', () => {
    const onChange = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <RangeField
          label="Value"
          min={-10}
          max={10}
          step={0.1}
          value={4.2}
          onChange={onChange}
        />,
      );
    });

    const numberInput = container.querySelector('.numeric-expression-input');
    expect(numberInput).toBeInstanceOf(HTMLInputElement);
    if (!(numberInput instanceof HTMLInputElement)) {
      throw new Error('Expected number input');
    }

    act(() => {
      numberInput.focus();
    });

    act(() => {
      setNativeInputValue(numberInput, '');
      numberInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(numberInput.value).toBe('');

    act(() => {
      setNativeInputValue(numberInput, '5*sqrt(2)');
      numberInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(numberInput.value).toBe('5*sqrt(2)');

    act(() => {
      numberInput.blur();
    });
    expect(onChange).toHaveBeenCalledWith(expect.closeTo(5 * Math.sqrt(2), 12));
  });

  it('uses a play button and discrete slider levels instead of always showing every copy', () => {
    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addPlot('surface');
      const plot = useAppStore.getState().objects.find((object) => object.type === 'plot');
      if (!plot) throw new Error('Expected plot');
      useAppStore.getState().updatePlotEquationText(plot.id, 'z = a*x');
      useAppStore.getState().setInspectorTab('object');
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<InspectorPanel />);
    });

    const modeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Continuous',
    );
    const plotBeforeToggle = useAppStore.getState().objects.find((object) => object.type === 'plot');
    expect(plotBeforeToggle?.equation.kind).toBe('explicit_surface');
    expect(modeButton).toBeInstanceOf(HTMLButtonElement);
    act(() => {
      modeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(modeButton?.textContent).toBe('Discrete');

    const playButton = container.querySelector('button[aria-label="Show all a copies"]');
    expect(playButton).toBeInstanceOf(HTMLButtonElement);
    expect(playButton?.getAttribute('aria-pressed')).toBe('false');

    const rangeFields = Array.from(container.querySelectorAll('.range-field'));
    const valueField = rangeFields.find((field) => field.firstElementChild?.textContent === 'Value');
    const copyCountField = rangeFields.find((field) => field.firstElementChild?.textContent === 'num copies');
    expect(valueField?.querySelector('input[type="range"]')?.getAttribute('step')).toBe('5');
    expect(copyCountField).toBeInstanceOf(HTMLLabelElement);

    act(() => {
      playButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(playButton?.getAttribute('aria-pressed')).toBe('true');
    const plot = useAppStore.getState().objects.find((object) => object.type === 'plot');
    expect(plot?.equation.parameters[0]?.animating).toBe(true);
  });

  it('uses compact numeric bounds tables while retaining sampling sliders', () => {
    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addPlot('curve');
      store.setInspectorTab('object');
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<InspectorPanel />);
    });

    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Appearance')).toBe(true);
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Material')).toBe(false);

    const curveTable = container.querySelector('[aria-label="Curve parameter bounds"]');
    expect(curveTable).toBeInstanceOf(HTMLDivElement);
    expect(curveTable?.querySelectorAll('.numeric-expression-input')).toHaveLength(2);
    expect(curveTable?.querySelector('input[type="range"]')).toBeNull();
    expect(curveTable?.querySelector('input[aria-label="t min"]')).toBeInstanceOf(HTMLInputElement);
    expect(curveTable?.querySelector('input[aria-label="t max"]')).toBeInstanceOf(HTMLInputElement);
    expect(Array.from(container.querySelectorAll('.range-field')).some(
      (field) => field.firstElementChild?.textContent === 'Samples',
    )).toBe(true);

    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addPlot('graph');
    });

    const graphTable = container.querySelector('[aria-label="Graph parameter bounds"]');
    expect(graphTable).toBeInstanceOf(HTMLDivElement);
    expect(graphTable?.querySelectorAll('.numeric-expression-input')).toHaveLength(4);
    expect(graphTable?.querySelector('input[type="range"]')).toBeNull();
    for (const label of ['x min', 'x max', 'y min', 'y max']) {
      expect(graphTable?.querySelector(`input[aria-label="${label}"]`)).toBeInstanceOf(HTMLInputElement);
    }
    const samplingFields = Array.from(container.querySelectorAll('.range-field')).filter(
      (field) => field.firstElementChild?.textContent?.endsWith('samples'),
    );
    expect(samplingFields).toHaveLength(2);

    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addPlot('implicit');
    });

    const implicitTable = container.querySelector('[aria-label="Implicit surface object bounds"]');
    expect(implicitTable).toBeInstanceOf(HTMLDivElement);
    expect(implicitTable?.querySelectorAll('.numeric-expression-input')).toHaveLength(6);
    expect(implicitTable?.querySelector('input[type="range"]')).toBeNull();
    for (const label of ['x min', 'x max', 'y min', 'y max', 'z min', 'z max']) {
      expect(implicitTable?.querySelector(`input[aria-label="${label}"]`)).toBeInstanceOf(HTMLInputElement);
    }
  });

  it('shows orbit speed only while turntable animation is active', () => {
    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.setInspectorTab('scene');
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<InspectorPanel />);
    });

    const turntableButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Turntable animation',
    );
    expect(turntableButton).toBeInstanceOf(HTMLButtonElement);
    const sceneSettings = container.querySelector('fieldset.scene-settings-fieldset');
    expect(Array.from(sceneSettings?.children ?? []).slice(0, 3).map((element) => element.textContent)).toEqual([
      'Scene Settings',
      'Turntable animation',
      'Ambient Light',
    ]);
    expect(turntableButton?.getAttribute('aria-pressed')).toBe('false');
    expect(Array.from(container.querySelectorAll('.range-field')).some(
      (field) => field.firstElementChild?.textContent === 'Orbit speed (°/s)',
    )).toBe(false);

    act(() => {
      turntableButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(turntableButton?.getAttribute('aria-pressed')).toBe('true');
    expect(useAppStore.getState().scene.turntableEnabled).toBe(true);
    expect(Array.from(container.querySelectorAll('.range-field')).some(
      (field) => field.firstElementChild?.textContent === 'Orbit speed (°/s)',
    )).toBe(true);
    const recordButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Record loop',
    );
    expect(recordButton).toBeInstanceOf(HTMLButtonElement);
    expect(recordButton?.hasAttribute('disabled')).toBe(true);
  });

  it('records a turntable loop with progress and locks its controls until completion', async () => {
    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.setInspectorTab('scene');
      store.updateScene({ turntableEnabled: true });
    });
    let finishRecording: (() => void) | null = null;
    const recordTurntableGif = vi.fn((onProgress?: (progress: number) => void) => {
      onProgress?.(0.5);
      return new Promise<void>((resolve) => {
        finishRecording = resolve;
      });
    });
    const viewportApi: ViewportApi = {
      exportPng: vi.fn(async () => undefined),
      recordTurntableGif,
      recordParameterGif: vi.fn(async () => undefined),
      recordLightCurveGif: vi.fn(async () => undefined),
      setViewPreset: vi.fn(),
      frameObject: vi.fn(),
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<InspectorPanel viewportApi={viewportApi} />));

    const recordButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Record loop',
    );
    expect(recordButton).toBeInstanceOf(HTMLButtonElement);
    act(() => recordButton?.click());

    expect(recordTurntableGif).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Recording 50%');
    expect(container.querySelector('progress[aria-label="Turntable GIF recording progress"]')).toBeInstanceOf(HTMLProgressElement);
    const orbitField = Array.from(container.querySelectorAll('.range-field')).find(
      (field) => field.firstElementChild?.textContent === 'Orbit speed (°/s)',
    );
    expect(Array.from(orbitField?.querySelectorAll('input') ?? []).every((input) => input.disabled)).toBe(true);
    expect(container.querySelector('fieldset.scene-settings-fieldset')?.hasAttribute('disabled')).toBe(true);
    expect(Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Turntable animation',
    )?.hasAttribute('disabled')).toBe(true);

    await act(async () => {
      finishRecording?.();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Record loop');
    expect(container.textContent).not.toContain('Recording 50%');
  });

  it('exports a full continuous-parameter bounce with progress while animation is playing', async () => {
    let plotId = '';
    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addPlot('surface');
      const plot = useAppStore.getState().objects.find((object) => object.type === 'plot');
      if (!plot) throw new Error('Expected plot');
      plotId = plot.id;
      store.updatePlotEquationText(plot.id, 'z = a*x');
      store.setParameterAnimation(plot.id, 'a', { animating: true });
      store.setInspectorTab('object');
    });

    let finishExport: (() => void) | null = null;
    const recordParameterGif = vi.fn((
      _plotId: string,
      _parameterName: string,
      onProgress?: (progress: number) => void,
    ) => {
      onProgress?.(0.25);
      return new Promise<void>((resolve) => {
        finishExport = resolve;
      });
    });
    const viewportApi: ViewportApi = {
      exportPng: vi.fn(async () => undefined),
      recordTurntableGif: vi.fn(async () => undefined),
      recordParameterGif,
      recordLightCurveGif: vi.fn(async () => undefined),
      setViewPreset: vi.fn(),
      frameObject: vi.fn(),
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<InspectorPanel viewportApi={viewportApi} />));

    const exportButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Record loop',
    );
    expect(exportButton).toBeInstanceOf(HTMLButtonElement);
    act(() => exportButton?.click());

    expect(recordParameterGif).toHaveBeenCalledWith(plotId, 'a', expect.any(Function));
    expect(container.textContent).toContain('Exporting loop 25%');
    expect(container.querySelector('progress[aria-label="a GIF export progress"]')).toBeInstanceOf(HTMLProgressElement);

    await act(async () => {
      finishExport?.();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Record loop');
    expect(container.textContent).not.toContain('Exporting loop 25%');
  });

  it('shows only the color controls relevant to the selected background mode', () => {
    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.setInspectorTab('scene');
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<InspectorPanel />));

    const labelTexts = () => Array.from(container?.querySelectorAll('label') ?? [])
      .map((label) => label.textContent?.trim() ?? '');
    expect(labelTexts().some((text) => text.startsWith('Solid Color'))).toBe(false);
    expect(labelTexts().some((text) => text.startsWith('Gradient Top'))).toBe(true);
    expect(labelTexts().some((text) => text.startsWith('Gradient Bottom'))).toBe(true);

    const backgroundMode = Array.from(container.querySelectorAll('label')).find(
      (label) => label.textContent?.includes('Background Mode'),
    )?.querySelector('select');
    expect(backgroundMode).toBeInstanceOf(HTMLSelectElement);
    act(() => {
      if (!backgroundMode) return;
      backgroundMode.value = 'solid';
      backgroundMode.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(labelTexts().some((text) => text.startsWith('Solid Color'))).toBe(true);
    expect(labelTexts().some((text) => text.startsWith('Gradient Top'))).toBe(false);
    expect(labelTexts().some((text) => text.startsWith('Gradient Bottom'))).toBe(false);
  });

  it('reveals emission controls only when Emission is checked for surfaces and curves', () => {
    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addPlot('surface');
      store.setInspectorTab('material');
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<InspectorPanel />);
    });

    const emissionCheckbox = () => Array.from(container?.querySelectorAll('label') ?? []).find(
      (label) => label.textContent?.trim() === 'Emission',
    )?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const hasEmissionColor = () => Array.from(container?.querySelectorAll('label') ?? []).some(
      (label) => label.textContent?.includes('Emission color'),
    );
    const hasEmissionStrength = () => Array.from(container?.querySelectorAll('.range-field') ?? []).some(
      (field) => field.firstElementChild?.textContent === 'Emission strength',
    );

    expect(emissionCheckbox()).toBeInstanceOf(HTMLInputElement);
    expect(emissionCheckbox()?.checked).toBe(false);
    expect(hasEmissionColor()).toBe(false);
    expect(hasEmissionStrength()).toBe(false);

    act(() => emissionCheckbox()?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(emissionCheckbox()?.checked).toBe(true);
    expect(hasEmissionColor()).toBe(true);
    expect(hasEmissionStrength()).toBe(true);
    const selectedSurface = useAppStore.getState().objects.find(
      (object) => object.id === useAppStore.getState().selectedId,
    );
    if (selectedSurface?.type !== 'plot') throw new Error('Expected selected surface plot');
    expect(selectedSurface?.material.emissionEnabled).toBe(true);
    expect(selectedSurface?.material.emissionStrength).toBe(1);

    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addPlot('curve');
      store.setInspectorTab('material');
    });
    expect(emissionCheckbox()).toBeInstanceOf(HTMLInputElement);
    expect(emissionCheckbox()?.checked).toBe(false);
    expect(hasEmissionColor()).toBe(false);
    expect(hasEmissionStrength()).toBe(false);
  });

  it('groups grid and contour controls in one Surface Decorations dropdown', () => {
    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addPlot('surface');
      store.setInspectorTab('material');
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<InspectorPanel />));

    const collapsibleButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.collapsible__header'));
    expect(collapsibleButtons).toHaveLength(1);
    const decorationsButton = collapsibleButtons[0];
    expect(decorationsButton?.textContent).toContain('Surface Decorations');
    expect(decorationsButton?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[aria-label="Contour lines"]')).toBeNull();

    act(() => decorationsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(decorationsButton?.getAttribute('aria-expanded')).toBe('true');
    const gridLabel = Array.from(container.querySelectorAll('label')).find(
      (label) => label.textContent?.trim() === 'Grid',
    );
    const gridCheckbox = gridLabel?.querySelector('input[type="checkbox"]');
    expect(gridCheckbox).toBeInstanceOf(HTMLInputElement);
    expect(container.querySelector('[aria-label="Contour lines"]')).toBeInstanceOf(HTMLDivElement);
    expect(container.textContent).not.toContain('Wireframe grid');
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>('.collapsible__header')).some(
      (button) => button.textContent?.includes('Wireframe') || button.textContent?.includes('Contours'),
    )).toBe(false);

    act(() => gridCheckbox?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('Grid color');
    expect(container.textContent).toContain('Grid cell size');
    expect(container.textContent).not.toContain('Wireframe color');
    expect(container.textContent).not.toContain('Wire cell step');
  });

  it('arms two canvas surface-pick buttons and replaces an assigned source', () => {
    let graphId = '';
    let parametricId = '';
    let implicitId = '';
    let intersectionId = '';
    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addPlot('graph');
      graphId = useAppStore.getState().selectedId ?? '';
      store.addPlot('surface');
      parametricId = useAppStore.getState().selectedId ?? '';
      store.addPlot('implicit');
      implicitId = useAppStore.getState().selectedId ?? '';
      store.addIntersection();
      intersectionId = useAppStore.getState().selectedId ?? '';
      store.setInspectorTab('object');
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<InspectorPanel />);
    });

    const inspectorContent = container.querySelector('.inspector-content');
    expect(inspectorContent?.querySelector('.intersection-source-picker__instructions')?.textContent).toBe(
      'Click the button below and then click the surface',
    );
    let buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.intersection-source-button'));
    expect(buttons).toHaveLength(2);
    expect(buttons.map((button) => button.querySelector('.intersection-source-button__label')?.textContent)).toEqual([
      'Surface 1',
      'Surface 2',
    ]);
    expect(container.querySelectorAll('.intersection-source-button__placeholder')).toHaveLength(2);
    const widthField = Array.from(container.querySelectorAll('.range-field')).find(
      (field) => field.firstElementChild?.textContent === 'Width',
    );
    expect(widthField).toBeInstanceOf(HTMLLabelElement);
    const widthInput = widthField?.querySelector('.numeric-expression-input');
    expect(widthInput).toBeInstanceOf(HTMLInputElement);
    if (!(widthInput instanceof HTMLInputElement)) throw new Error('Expected intersection width input');
    act(() => widthInput.focus());
    act(() => {
      setNativeInputValue(widthInput, '0.1');
      widthInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => widthInput.blur());
    const styledIntersection = useAppStore.getState().objects.find((object) => object.id === intersectionId);
    expect(styledIntersection?.type === 'intersection' ? styledIntersection.curveStyle.tubeRadius : null).toBe(0.1);

    act(() => buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(useAppStore.getState().ui.intersectionSourcePick).toEqual({ intersectionId, slot: 0 });
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');
    act(() => useAppStore.getState().setIntersectionSource(intersectionId, 0, graphId));
    expect(useAppStore.getState().ui.intersectionSourcePick).toBeNull();

    buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.intersection-source-button'));
    act(() => buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => useAppStore.getState().setIntersectionSource(intersectionId, 1, parametricId));

    buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.intersection-source-button'));
    expect(buttons[0]?.querySelector('.object-card__name')?.textContent).toBe('Graph 1');
    expect(buttons[1]?.querySelector('.object-card__name')?.textContent).toBe('Parametric 1');
    let intersection = useAppStore.getState().objects.find((object) => object.id === intersectionId);
    expect(intersection?.type).toBe('intersection');
    if (intersection?.type !== 'intersection') throw new Error('Expected intersection');
    expect(intersection.sourceSurfaceIds).toEqual([graphId, parametricId]);

    act(() => buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => useAppStore.getState().setIntersectionSource(intersectionId, 0, implicitId));
    buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.intersection-source-button'));
    expect(buttons[0]?.querySelector('.object-card__name')?.textContent).toBe('Implicit 1');
    intersection = useAppStore.getState().objects.find((object) => object.id === intersectionId);
    if (intersection?.type !== 'intersection') throw new Error('Expected intersection');
    expect(intersection.sourceSurfaceIds).toEqual([implicitId, parametricId]);
  });

  it('gives intersections curve-equivalent Appearance controls without surface decorations', () => {
    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addIntersection();
      store.setInspectorTab('material');
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<InspectorPanel />);
    });

    const labelTexts = Array.from(container.querySelectorAll('label')).map((label) => label.textContent?.trim());
    for (const label of ['Preset', 'Color', 'Opacity', 'Reflectiveness', 'Roughness', 'Refraction', 'Emission']) {
      expect(labelTexts.some((text) => text?.startsWith(label)), label).toBe(true);
    }
    expect(container.textContent).not.toContain('Emission color');
    expect(container.textContent).not.toContain('Emission strength');
    expect(container.textContent).not.toContain('Surface Decorations');
    expect(container.textContent).not.toContain('Wireframe');
    expect(container.textContent).not.toContain('Contours');
  });

  it('shows Scene controls by themselves when no object is selected', () => {
    act(() => {
      useAppStore.getState().newProject();
      useAppStore.getState().setInspectorTab('scene');
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<InspectorPanel />));

    const tabLabels = Array.from(container.querySelectorAll('.tabs__tab')).map((button) => button.textContent);
    expect(tabLabels).toEqual([]);
    expect(container.querySelector('.tabs')).toBeNull();
    expect(container.querySelector('.scene-settings-heading')?.textContent).toBe('Scene Settings');
    expect(Array.from(container.querySelectorAll('label')).some(
      (label) => label.textContent?.includes('Ambient light'),
    )).toBe(true);
    expect(container.textContent).toContain('Shadow map resolution');
    expect(container.textContent).toContain('Shadow softness');
  });

  it('shows only Object and Appearance when an object is selected', () => {
    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addPlot('surface');
      store.setInspectorTab('scene');
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<InspectorPanel />));

    const tabLabels = () => Array.from(container?.querySelectorAll('.tabs__tab') ?? []).map(
      (button) => button.textContent,
    );
    expect(tabLabels()).toEqual(['Object', 'Appearance']);
    expect(container.querySelector('.tabs__tab--active')?.textContent).toBe('Object');
    expect(container.textContent).not.toContain('Ambient light');

    act(() => useAppStore.getState().selectObject(null));
    expect(tabLabels()).toEqual([]);
    expect(container.querySelector('.tabs')).toBeNull();
    expect(container.textContent).toContain('Ambient light');
  });

  it('keeps point-light position in Object and puts its other controls in Appearance', () => {
    act(() => {
      useAppStore.getState().newProject();
      useAppStore.getState().addPointLight();
      useAppStore.getState().setInspectorTab('object');
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<InspectorPanel />));

    let content = container.querySelector('.inspector-content');
    expect(content?.textContent).toContain('Position');
    expect(content?.textContent).not.toContain('Intensity');
    expect(content?.textContent).not.toContain('Range');
    expect(content?.textContent).not.toContain('Cast shadows');

    act(() => useAppStore.getState().setInspectorTab('material'));
    content = container.querySelector('.inspector-content');
    expect(content?.textContent).toContain('Color');
    expect(content?.textContent).toContain('Intensity');
    expect(content?.textContent).toContain('Range');
    expect(content?.textContent).toContain('Cast shadows');
    expect(content?.textContent).not.toContain('Position');
  });

  it('splits directional placement from directional appearance', () => {
    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addDirectionalLight();
      const light = useAppStore.getState().objects.find((object) => object.type === 'directional_light');
      if (!light) throw new Error('Expected directional light');
      store.selectObject(light.id);
      store.setInspectorTab('object');
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<InspectorPanel />));

    let content = container.querySelector('.inspector-content');
    expect(content?.textContent).toContain('Position');
    expect(content?.textContent).toContain('always aim from this position toward world origin');
    expect(content?.textContent).not.toContain('Sun azimuth');
    expect(content?.textContent).not.toContain('Sun elevation');
    expect(content?.textContent).not.toContain('Direction (points toward scene)');
    expect(content?.textContent).not.toContain('Intensity');
    expect(content?.textContent).not.toContain('Cast shadows');

    act(() => useAppStore.getState().setInspectorTab('material'));
    content = container.querySelector('.inspector-content');
    expect(content?.textContent).toContain('Color');
    expect(content?.textContent).toContain('Intensity');
    expect(content?.textContent).toContain('Cast shadows');
    expect(content?.textContent).not.toContain('Position');
    expect(content?.textContent).not.toContain('Direction (points toward scene)');
  });

  it('offers Pin to curve in both point and directional light object menus', () => {
    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addPointLight();
      store.setInspectorTab('object');
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<InspectorPanel />));

    const pinCheckbox = () => Array.from(container?.querySelectorAll('label.checkbox-row') ?? []).find(
      (label) => label.textContent?.includes('Pin to curve'),
    )?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(pinCheckbox()).toBeInstanceOf(HTMLInputElement);

    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addDirectionalLight();
      store.setInspectorTab('object');
    });
    expect(pinCheckbox()).toBeInstanceOf(HTMLInputElement);
  });

  it('selects a curve, animates the pinned value, and records its loop', async () => {
    let curveId = '';
    let lightId = '';
    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addPlot('curve');
      curveId = useAppStore.getState().selectedId ?? '';
      store.addPointLight();
      lightId = useAppStore.getState().selectedId ?? '';
      store.setInspectorTab('object');
    });
    let finishRecording: (() => void) | null = null;
    const recordLightCurveGif = vi.fn((
      _lightId: string,
      onProgress?: (progress: number) => void,
    ) => {
      onProgress?.(0.5);
      return new Promise<void>((resolve) => {
        finishRecording = resolve;
      });
    });
    const viewportApi: ViewportApi = {
      exportPng: vi.fn(async () => undefined),
      recordTurntableGif: vi.fn(async () => undefined),
      recordParameterGif: vi.fn(async () => undefined),
      recordLightCurveGif,
      setViewPreset: vi.fn(),
      frameObject: vi.fn(),
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<InspectorPanel viewportApi={viewportApi} />));

    const pinCheckbox = Array.from(container.querySelectorAll('label.checkbox-row')).find(
      (label) => label.textContent?.includes('Pin to curve'),
    )?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    act(() => pinCheckbox?.click());
    const chooseButton = container.querySelector<HTMLButtonElement>('[aria-label="Choose parameterized curve"]');
    expect(chooseButton?.textContent).toContain('Click here, and then click parameterized curve to pin light to');
    act(() => chooseButton?.click());
    expect(useAppStore.getState().ui.lightCurveSourcePick).toEqual({ lightId });

    act(() => useAppStore.getState().setLightCurveSource(lightId, curveId));
    expect(container.querySelector('.light-curve-pin .object-card__name')?.textContent).toBe('Curve 1');
    expect(container.textContent).not.toContain('Position');
    const valueSlider = container.querySelector<HTMLInputElement>('.light-curve-pin__parameter input[type="range"]');
    expect(valueSlider?.min).toBe('-12');
    expect(valueSlider?.max).toBe('12');
    const playButton = container.querySelector<HTMLButtonElement>('[aria-label="Animate pinned light"]');
    act(() => playButton?.click());
    const animatedLight = useAppStore.getState().objects.find((object) => object.id === lightId);
    expect(animatedLight?.type === 'point_light' ? animatedLight.curvePin.animating : false).toBe(true);
    expect(Array.from(container.querySelectorAll('.range-field')).some(
      (field) => field.firstElementChild?.textContent === 't speed',
    )).toBe(true);

    const recordButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Record loop',
    );
    act(() => recordButton?.click());
    expect(recordLightCurveGif).toHaveBeenCalledWith(lightId, expect.any(Function));
    expect(container.textContent).toContain('Exporting loop 50%');
    expect(container.querySelector(`progress[aria-label="Point Light 1 GIF export progress"]`)).toBeInstanceOf(HTMLProgressElement);

    await act(async () => {
      finishRecording?.();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Record loop');
  });
});

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(input, value);
}
