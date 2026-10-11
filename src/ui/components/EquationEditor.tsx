import { useId, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { autocompletion } from '@codemirror/autocomplete';
import { Decoration, EditorView } from '@codemirror/view';
import { supportedConstantNames, supportedFunctionNames } from '../../math/evaluator';
import { mathCompletionSource } from './equationCompletions';
import type { EquationSpec, PlotJobStatus } from '../../types/contracts';
import { LatexPreview } from './LatexPreview';

interface EquationEditorProps {
  equation: EquationSpec;
  onChange: (rawText: string) => void;
  job?: PlotJobStatus;
}

const EDITOR_EXTENSIONS = [
  javascript(),
  autocompletion({ override: [mathCompletionSource] }),
  EditorView.contentAttributes.of({ 'aria-label': 'Equation' }),
];

export function EquationEditor({ equation, onChange, job }: EquationEditorProps) {
  const source = equation.source;
  const graphExpression = equation.kind === 'explicit_surface' && equation.graphExpression;
  const [helpOpen, setHelpOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const contentId = useId();
  const lineCount = source.rawText.split('\n').length;
  const diagnostics = source.parseErrors;
  const extensions = useMemo(() => {
    const length = source.rawText.length;
    const ranges = length ? diagnostics.map((diagnostic) => {
      const from = Math.max(0, Math.min(length - 1, diagnostic.start));
      const to = Math.max(from + 1, Math.min(length, diagnostic.end));
      return Decoration.mark({ class: 'equation-error-underline', attributes: { title: diagnostic.message } }).range(from, to);
    }) : [];
    return [...EDITOR_EXTENSIONS, EditorView.decorations.of(Decoration.set(ranges, true))];
  }, [diagnostics, source.rawText]);
  const message = diagnostics[0]?.message ?? source.classification?.warning ?? job?.lastError;
  const invalid = source.parseStatus !== 'ok' || source.classification?.kind === 'unknown' || job?.meshPhase === 'error';

  return (
    <div className={`equation-editor${collapsed ? ' equation-editor--collapsed' : ''}`}>
      <div className="equation-editor__toolbar">
        <span>Equation{lineCount > 1 ? ` · ${lineCount} lines` : ''}</span>
        <button
          type="button"
          className="equation-editor__collapse-toggle"
          aria-label={collapsed ? 'Expand equation editor' : 'Collapse equation editor'}
          aria-expanded={!collapsed}
          aria-controls={contentId}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span aria-hidden="true">{collapsed ? '▾' : '▴'}</span> {collapsed ? 'Expand' : 'Collapse'}
        </button>
      </div>
      <div id={contentId} className="equation-editor__content" hidden={collapsed}>
        <div className="equation-editor__input">
          <CodeMirror
            value={source.rawText}
            minHeight="46px"
            theme="dark"
            basicSetup={{
              lineNumbers: source.rawText.includes('\n'),
              foldGutter: false,
              highlightActiveLine: false,
              highlightSelectionMatches: true,
              highlightActiveLineGutter: false,
              autocompletion: false,
            }}
            extensions={extensions}
            onChange={(value) => onChange(value)}
          />
          <button
            type="button"
            className="equation-editor__help-toggle"
            onClick={() => setHelpOpen((open) => !open)}
            title="Equation syntax reference"
            aria-label="Toggle equation syntax reference"
            aria-expanded={helpOpen}
          >
            ƒx
          </button>
          {helpOpen ? <SyntaxHelp graphExpression={Boolean(graphExpression)} /> : null}
        </div>
        <LatexPreview latex={source.formattedLatex} fallbackText={source.rawText} />
      </div>
      {message ? (
        <div className={`equation-editor__diagnostic equation-editor__diagnostic--${invalid ? 'error' : 'warning'}`} role="status" aria-live="polite">
          {source.parseStatus === 'partial' ? 'Incomplete equation. ' : ''}{message}
          {invalid && (job?.meshVersion ?? 0) > 0 ? ' Showing the last valid plot.' : ''}
        </div>
      ) : null}
    </div>
  );
}

function SyntaxHelp({ graphExpression }: { graphExpression: boolean }) {
  return (
    <div className="equation-help" role="note" aria-label="Equation syntax reference">
      <div className="equation-help__row">
        <span className="equation-help__label">Forms</span>
        {graphExpression ? (
          <span>Enter <code>f(x, y)</code> directly, such as <code>x^2 - y^2</code>; <code>z =</code> is supplied automatically.</span>
        ) : (
          <span>
            <code>z = f(x, y)</code> · <code>F(x, y, z) = 0</code> · curve <code>(x(t), y(t), z(t))</code> · surface{' '}
            <code>(x(u,v), y(u,v), z(u,v))</code>
          </span>
        )}
      </div>
      <div className="equation-help__row">
        <span className="equation-help__label">Functions</span>
        <span>{supportedFunctionNames.join(', ')}</span>
      </div>
      <div className="equation-help__row">
        <span className="equation-help__label">Constants</span>
        <span>
          {supportedConstantNames.join(', ')} — <code>log</code> is base 10, <code>ln</code> is natural
        </span>
      </div>
      <div className="equation-help__row">
        <span className="equation-help__label">Definitions</span>
        <span>
          Write <code>A = x^2 + y^2</code> on its own line, then {graphExpression ? <code>sin(A)</code> : <code>z = sin(A)</code>} on the final line.
          {' '}Definitions are local to this plot and may use earlier definitions. Names are case-sensitive;
          {' '}coordinate names (<code>x, y, z, t, u, v</code>), functions, <code>pi</code>, and <code>e</code> are reserved.
          {' '}Use parentheses to wrap an expression across lines.
        </span>
      </div>
      <div className="equation-help__row">
        <span className="equation-help__label">Operators</span>
        <span>
          <code>+ − * / ^</code>; undefined names (<code>a</code>, <code>b</code>, …) become adjustable constants with sliders.
          {' '}Defined names are calculated from their expressions and have no slider.
        </span>
      </div>
    </div>
  );
}
