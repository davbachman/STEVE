import { useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { supportedConstantNames, supportedFunctionNames } from '../../math/evaluator';
import type { EquationSpec } from '../../types/contracts';
import { LatexPreview } from './LatexPreview';

interface EquationEditorProps {
  equation: EquationSpec;
  onChange: (rawText: string) => void;
}

const FUNCTION_DETAILS: Record<string, string> = {
  log: 'log base 10',
  ln: 'natural log',
  asin: 'inverse sine',
  acos: 'inverse cosine',
  atan: 'inverse tangent',
};

const MATH_COMPLETIONS = [
  ...supportedFunctionNames.map((name) => ({
    label: name,
    type: 'function',
    apply: `${name}(`,
    detail: FUNCTION_DETAILS[name],
  })),
  ...supportedConstantNames.map((name) => ({ label: name, type: 'constant' })),
];

function mathCompletionSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[a-zA-Z]+$/);
  if (!word || (word.from === word.to && !context.explicit)) {
    return null;
  }
  return {
    from: word.from,
    options: MATH_COMPLETIONS,
    validFor: /^[a-zA-Z]*$/,
  };
}

const EDITOR_EXTENSIONS = [
  javascript(),
  autocompletion({ override: [mathCompletionSource] }),
];

export function EquationEditor({ equation, onChange }: EquationEditorProps) {
  const source = equation.source;
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <div className="equation-editor">
      <div className="equation-editor__input">
        <CodeMirror
          value={source.rawText}
          minHeight="46px"
          theme="dark"
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: false,
            highlightSelectionMatches: true,
            highlightActiveLineGutter: false,
            autocompletion: false,
          }}
          extensions={EDITOR_EXTENSIONS}
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
        {helpOpen ? <SyntaxHelp /> : null}
      </div>
      <LatexPreview latex={source.formattedLatex} fallbackText={source.rawText} />
    </div>
  );
}

function SyntaxHelp() {
  return (
    <div className="equation-help" role="note" aria-label="Equation syntax reference">
      <div className="equation-help__row">
        <span className="equation-help__label">Forms</span>
        <span>
          <code>z = f(x, y)</code> · <code>F(x, y, z) = 0</code> · curve <code>(x(t), y(t), z(t))</code> · surface{' '}
          <code>(x(u,v), y(u,v), z(u,v))</code>
        </span>
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
        <span className="equation-help__label">Operators</span>
        <span>
          <code>+ − * / ^</code>; other letters (<code>a</code>, <code>b</code>, …) become adjustable constants with sliders
        </span>
      </div>
    </div>
  );
}
