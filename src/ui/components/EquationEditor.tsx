import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import type { EquationSpec } from '../../types/contracts';
import { LatexPreview } from './LatexPreview';

interface EquationEditorProps {
  equation: EquationSpec;
  onChange: (rawText: string) => void;
  onOverrideKind: (kind: EquationSpec['kind']) => void;
}

export function EquationEditor({ equation, onChange, onOverrideKind }: EquationEditorProps) {
  const source = equation.source;
  const diag = source.parseErrors[0];

  return (
    <div className="equation-editor">
      <CodeMirror
        value={source.rawText}
        height="72px"
        theme="dark"
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightSelectionMatches: false,
        }}
        extensions={[javascript()]}
        onChange={(value) => onChange(value)}
      />
      <div className="equation-editor__meta">
        <span className={`badge badge--${source.parseStatus}`}>{source.classification?.label ?? 'Unknown'}</span>
        <label className="equation-editor__override">
          Type
          <select value={equation.kind} onChange={(e) => onOverrideKind(e.target.value as EquationSpec['kind'])}>
            <option value="parametric_curve">Curve</option>
            <option value="parametric_surface">Surface</option>
            <option value="explicit_surface">{'Explicit->Parametric'}</option>
            <option value="implicit_surface">Implicit</option>
          </select>
        </label>
        {source.classification?.warning ? <span className="equation-editor__warning">{source.classification.warning}</span> : null}
      </div>
      <LatexPreview latex={source.formattedLatex} fallbackText={source.rawText} />
      {diag ? (
        <div className={`equation-editor__diagnostic equation-editor__diagnostic--${diag.severity}`}>
          {diag.message}
        </div>
      ) : null}
    </div>
  );
}
