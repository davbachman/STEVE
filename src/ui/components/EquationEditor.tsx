import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import type { EquationSpec } from '../../types/contracts';
import { LatexPreview } from './LatexPreview';

interface EquationEditorProps {
  equation: EquationSpec;
  onChange: (rawText: string) => void;
}

export function EquationEditor({ equation, onChange }: EquationEditorProps) {
  const source = equation.source;

  return (
    <div className="equation-editor">
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
        }}
        extensions={[javascript()]}
        onChange={(value) => onChange(value)}
      />
      <LatexPreview latex={source.formattedLatex} fallbackText={source.rawText} />
    </div>
  );
}
