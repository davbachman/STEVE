import { useState, type MouseEvent } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { deleteCharBackward, redo, redoDepth, selectAll, undo, undoDepth } from '@codemirror/commands';
import type { Command, EditorView, ViewUpdate } from '@codemirror/view';
import type { EquationSpec } from '../../types/contracts';
import { LatexPreview } from './LatexPreview';

interface EquationEditorProps {
  equation: EquationSpec;
  onChange: (rawText: string) => void;
}

interface EditorControlsState {
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
}

const defaultControlsState: EditorControlsState = {
  canUndo: false,
  canRedo: false,
  hasSelection: false,
};

function readControlsState(view: EditorView): EditorControlsState {
  return {
    canUndo: undoDepth(view.state) > 0,
    canRedo: redoDepth(view.state) > 0,
    hasSelection: view.state.selection.ranges.some((range) => !range.empty),
  };
}

function runEditorCommand(view: EditorView | null, command: Command) {
  if (!view) return;
  command(view);
  view.focus();
}

export function EquationEditor({ equation, onChange }: EquationEditorProps) {
  const source = equation.source;
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [controlsState, setControlsState] = useState<EditorControlsState>(defaultControlsState);

  const syncControlsState = (view: EditorView) => {
    const next = readControlsState(view);
    setControlsState((current) => (
      current.canUndo === next.canUndo
      && current.canRedo === next.canRedo
      && current.hasSelection === next.hasSelection
        ? current
        : next
    ));
  };

  const onCreateEditor = (view: EditorView) => {
    setEditorView(view);
    syncControlsState(view);
  };

  const onUpdate = (update: ViewUpdate) => {
    if (update.docChanged || update.selectionSet) {
      syncControlsState(update.view);
    }
  };

  const keepSelection = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
  };

  return (
    <div className="equation-editor">
      <div className="equation-editor__toolbar" aria-label="Equation editor actions">
        <div className="equation-editor__actions">
          <button
            type="button"
            onMouseDown={keepSelection}
            onClick={() => runEditorCommand(editorView, undo)}
            disabled={!controlsState.canUndo}
          >
            Undo
          </button>
          <button
            type="button"
            onMouseDown={keepSelection}
            onClick={() => runEditorCommand(editorView, redo)}
            disabled={!controlsState.canRedo}
          >
            Redo
          </button>
          <button
            type="button"
            onMouseDown={keepSelection}
            onClick={() => runEditorCommand(editorView, selectAll)}
          >
            Select all
          </button>
          <button
            type="button"
            onMouseDown={keepSelection}
            onClick={() => runEditorCommand(editorView, deleteCharBackward)}
            disabled={!controlsState.hasSelection}
          >
            Delete selection
          </button>
        </div>
        <div className="equation-editor__hint">Drag to select. Cmd/Ctrl+A selects all. Delete removes the current selection.</div>
      </div>
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
        onCreateEditor={onCreateEditor}
        onUpdate={onUpdate}
        onChange={(value) => onChange(value)}
      />
      <LatexPreview latex={source.formattedLatex} fallbackText={source.rawText} />
    </div>
  );
}
