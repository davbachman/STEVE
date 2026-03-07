import { useAppStore } from '../../state/store';
import type { SceneObject } from '../../types/contracts';

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
  const addPlot = useAppStore((s) => s.addPlot);
  const addPointLight = useAppStore((s) => s.addPointLight);
  const objects = useAppStore((s) => s.objects);
  const selectedId = useAppStore((s) => s.selectedId);
  const selectObject = useAppStore((s) => s.selectObject);
  const setObjectVisibility = useAppStore((s) => s.setObjectVisibility);

  return (
    <aside className="panel panel--left panel--creator">
      <div className="panel__header">
        <h2>Create</h2>
        <div className="panel__actions panel__actions--stack">
          <button onClick={() => addPlot('curve')}>+ Curve</button>
          <button onClick={() => addPlot('surface')}>+ Surface</button>
          <button onClick={() => addPlot('implicit')}>+ Equation</button>
          <button onClick={() => addPointLight()}>+ Light</button>
        </div>
      </div>
      <div className="object-list object-list--compact">
        {objects.map((obj) => (
          <div
            key={obj.id}
            className={`object-card ${selectedId === obj.id ? 'object-card--selected' : ''} ${obj.visible ? '' : 'object-card--hidden'}`.trim()}
          >
            <button className="object-card__select" onClick={() => selectObject(obj.id)} title={obj.name}>
              <span className="object-card__icon">{objectIcon(obj)}</span>
              <span className="object-card__name">{obj.name}</span>
            </button>
            <label className="object-card__toggle" title={obj.type === 'point_light' ? 'Show light icon' : 'Show object'}>
              <input
                aria-label={obj.type === 'point_light' ? `Show icon for ${obj.name}` : `Show ${obj.name}`}
                type="checkbox"
                checked={obj.visible}
                onChange={(e) => setObjectVisibility(obj.id, e.target.checked)}
              />
            </label>
          </div>
        ))}
      </div>
    </aside>
  );
}
