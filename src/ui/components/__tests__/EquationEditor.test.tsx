import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeGraphExpression } from '../../../math/classifier';
import { createDefaultGraph } from '../../../state/defaults';
import type { EquationSpec, PlotJobStatus } from '../../../types/contracts';
import { EquationEditor } from '../EquationEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function graphEquation(rawText: string): EquationSpec {
  return { ...createDefaultGraph().equation, source: analyzeGraphExpression(rawText).source };
}

function meshJob(meshVersion = 0): PlotJobStatus {
  return { meshVersion, parsePhase: 'ready', meshPhase: 'ready', hasPreview: false, progress: 1 };
}

describe('EquationEditor diagnostics and accessibility', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  function renderEditor(equation: EquationSpec, job = meshJob(), onChange = vi.fn()) {
    if (!container) {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
    act(() => root?.render(<EquationEditor equation={equation} job={job} onChange={onChange} />));
    return container;
  }

  it('labels the actual editable CodeMirror textbox for keyboard and assistive technology users', () => {
    const host = renderEditor(graphEquation('x + y'));
    const textbox = host.querySelector('[role="textbox"][aria-label="Equation"]');
    expect(textbox).toBeInstanceOf(HTMLElement);
    expect(textbox?.getAttribute('contenteditable')).toBe('true');
    expect(textbox?.classList.contains('cm-content')).toBe(true);
    expect(textbox?.textContent).toBe('x + y');
    expect(host.querySelectorAll('[aria-label="Equation"]')).toHaveLength(1);
    expect(host.querySelector('.equation-editor__diagnostic')).toBeNull();
  });

  it('explains incomplete input and underlines it while identifying the retained last valid plot', () => {
    const equation = graphEquation('sin(');
    const host = renderEditor(equation, meshJob(2));
    const diagnostic = host.querySelector('.equation-editor__diagnostic');
    expect(diagnostic?.getAttribute('role')).toBe('status');
    expect(diagnostic?.getAttribute('aria-live')).toBe('polite');
    expect(diagnostic?.textContent).toContain('Incomplete equation.');
    expect(diagnostic?.textContent).toContain(equation.source.parseErrors[0].message);
    expect(diagnostic?.textContent).toContain('Showing the last valid plot.');
    expect(diagnostic?.classList.contains('equation-editor__diagnostic--error')).toBe(true);
    const underline = host.querySelector('.cm-content .equation-error-underline');
    expect(underline).not.toBeNull();
    expect(underline?.getAttribute('title')).toBe(equation.source.parseErrors[0].message);

    renderEditor(graphEquation('sin(x)'), meshJob(3));
    expect(host.querySelector('.equation-editor__diagnostic')).toBeNull();
    expect(host.querySelector('.equation-error-underline')).toBeNull();
  });

  it('does not claim a previous valid plot exists for a new invalid equation', () => {
    const host = renderEditor(graphEquation('sin('));
    const diagnostic = host.querySelector('.equation-editor__diagnostic');
    expect(diagnostic?.textContent).toContain('Incomplete equation.');
    expect(diagnostic?.textContent).not.toContain('last valid plot');
  });

  it('reports mesh failures beside valid input and keeps the prior plot label', () => {
    const host = renderEditor(graphEquation('x + y'), {
      ...meshJob(1), meshPhase: 'error', lastError: 'Mesh could not be built at this resolution',
    });
    const diagnostic = host.querySelector('.equation-editor__diagnostic');
    expect(diagnostic?.textContent).toContain('Mesh could not be built at this resolution');
    expect(diagnostic?.textContent).toContain('Showing the last valid plot.');
    expect(diagnostic?.textContent).not.toContain('Incomplete equation.');
  });
});
