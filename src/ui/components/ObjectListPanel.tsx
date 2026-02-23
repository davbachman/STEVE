import { useAppStore } from '../../state/store';
import type { SceneObject } from '../../types/contracts';
import { EquationEditor } from './EquationEditor';

function objectIcon(obj: SceneObject): string {
  if (obj.type === 'point_light') return '●';
  switch (obj.equation.kind) {
    case 'parametric_curve':
      return '∿';
    case 'parametric_surface':
      return '▧';
    case 'explicit_surface':
      return 'ƒ';
    case 'implicit_surface':
      return '◎';
  }
}

export function ObjectListPanel() {
  const objects = useAppStore((s) => s.objects);
  const selectedId = useAppStore((s) => s.selectedId);
  const selectObject = useAppStore((s) => s.selectObject);
  const addPlot = useAppStore((s) => s.addPlot);
  const addPointLight = useAppStore((s) => s.addPointLight);
  const updatePlotEquationText = useAppStore((s) => s.updatePlotEquationText);
  const setPlotClassificationOverride = useAppStore((s) => s.setPlotClassificationOverride);

  return (
    <aside className="panel panel--left">
      <div className="panel__header">
        <h2>Objects</h2>
        <div className="panel__actions panel__actions--wrap">
          <button onClick={() => addPlot('explicit')}>+ Plot</button>
          <button onClick={() => addPlot('curve')}>+ Curve</button>
          <button onClick={() => addPlot('surface')}>+ Surface</button>
          <button onClick={() => addPlot('implicit')}>+ Implicit</button>
          <button onClick={() => addPointLight()}>+ Light</button>
        </div>
      </div>

      <div className="object-list">
        {objects.map((obj) => {
          const selected = obj.id === selectedId;
          return (
            <div key={obj.id} className={`object-row ${selected ? 'object-row--selected' : ''}`}>
              <button className="object-row__head" onClick={() => selectObject(obj.id)}>
                <span className="object-row__icon">{objectIcon(obj)}</span>
                <span className="object-row__name">{obj.name}</span>
                {obj.type === 'plot' ? (
                  <span className="object-row__swatch" style={{ background: obj.material.baseColor }} />
                ) : (
                  <span className="object-row__swatch" style={{ background: obj.color }} />
                )}
              </button>
              {selected && obj.type === 'plot' ? (
                <EquationEditor
                  equation={obj.equation}
                  onChange={(rawText) => updatePlotEquationText(obj.id, rawText)}
                  onOverrideKind={(kind) => setPlotClassificationOverride(obj.id, kind)}
                />
              ) : null}
              {selected && obj.type === 'point_light' ? <PointLightInlineEditor id={obj.id} /> : null}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function PointLightInlineEditor({ id }: { id: string }) {
  const objects = useAppStore((s) => s.objects);
  const obj = objects.find((o) => o.id === id);
  if (!obj || obj.type !== 'point_light') return <></>;

  return (
    <div className="inline-editor">
      <label>
        Color
        <input
          type="color"
          value={obj.color}
          onChange={(e) => {
            const color = e.target.value;
            useAppStore.setState((state) => ({
              ...state,
              objects: state.objects.map((item) => (item.id === id && item.type === 'point_light' ? { ...item, color } : item)),
            }));
          }}
        />
      </label>
      <label>
        Intensity
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={obj.intensity}
          onChange={(e) => {
            const intensity = Number(e.target.value);
            useAppStore.setState((state) => ({
              ...state,
              objects: state.objects.map((item) => (item.id === id && item.type === 'point_light' ? { ...item, intensity } : item)),
            }));
          }}
        />
      </label>
    </div>
  );
}
