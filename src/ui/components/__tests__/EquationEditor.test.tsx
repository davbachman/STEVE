import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeGraphExpression } from '../../../math/classifier';
import { createDefaultGraph } from '../../../state/defaults';
import type { EquationSpec, PlotJobStatus } from '../../../types/contracts';
import { EquationEditor } from '../EquationEditor';
import { mathCompletionSource } from '../equationCompletions';

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

  it('shows multiline definitions, line numbers, an aligned preview, and syntax help', () => {
    const host = renderEditor(graphEquation('A = x^2 + y^2\nsin(A)'));
    expect(host.querySelectorAll('.cm-line')).toHaveLength(2);
    expect(host.querySelector('.cm-lineNumbers')).not.toBeNull();
    expect(host.querySelector('.katex .mtable')).not.toBeNull();
    expect(host.querySelector('.katex-error')).toBeNull();
    expect(host.querySelector('.equation-editor__diagnostic')).toBeNull();
    act(() => (host.querySelector('.equation-editor__help-toggle') as HTMLButtonElement).click());
    expect(host.querySelector('.equation-help')?.textContent).toContain('earlier definitions');
    expect(host.querySelector('.equation-help')?.textContent).toContain('no slider');
  });

  it('underlines invalid references on their actual line', () => {
    const host = renderEditor(graphEquation('A = x^2\nB = C\nC = y^2\nA+B'));
    const underline = host.querySelector('.equation-error-underline');
    expect(underline?.textContent).toBe('C');
    expect(underline?.closest('.cm-line')?.textContent).toBe('B = C');
  });

  it('completes earlier local names with underscores and digits, including on an empty line', () => {
    for (const suffix of ['R_', '']) {
      const doc = `R_1 = x^2\n${suffix}`;
      const state = EditorState.create({ doc });
      const result = mathCompletionSource(new CompletionContext(state, doc.length, true));
      expect(result?.options).toContainEqual({ label: 'R_1', type: 'variable', detail: 'local definition' });
    }
    const doc = 'A = x\nB = y\nA+B';
    const state = EditorState.create({ doc });
    const result = mathCompletionSource(new CompletionContext(state, 0, true));
    expect(result?.options.some((option) => option.label === 'A' || option.label === 'B')).toBe(false);
  });
});
