import { useAppStore } from '../../state/store';
import type { PlotJobStatus, SceneObject } from '../../types/contracts';

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

function objectKindLabel(obj: SceneObject): string {
  if (obj.type === 'point_light') return 'Point light';
  switch (obj.equation.kind) {
    case 'parametric_curve':
      return 'Parametric curve';
    case 'parametric_surface':
      return 'Parametric surface';
    case 'explicit_surface':
      return 'Explicit surface';
    case 'implicit_surface':
      return 'Implicit surface';
  }
}

function objectSwatchColor(obj: SceneObject): string {
  return obj.type === 'point_light' ? obj.color : obj.material.baseColor;
}

const BUSY_MESH_PHASES = new Set(['queued', 'parsing', 'mesh_preview', 'mesh_final']);

function jobActivity(job: PlotJobStatus | undefined): 'idle' | 'busy' | 'error' {
  if (!job) return 'idle';
  if (job.meshPhase === 'error' || job.parsePhase === 'error') return 'error';
  if (BUSY_MESH_PHASES.has(job.meshPhase) || job.parsePhase === 'queued' || job.parsePhase === 'parsing') {
    return 'busy';
  }
  return 'idle';
}

export function ObjectListPanel() {
  const addPlot = useAppStore((s) => s.addPlot);
  const addPointLight = useAppStore((s) => s.addPointLight);
  const objects = useAppStore((s) => s.objects);
  const selectedId = useAppStore((s) => s.selectedId);
  const selectObject = useAppStore((s) => s.selectObject);
  const setObjectVisibility = useAppStore((s) => s.setObjectVisibility);
  const duplicateObject = useAppStore((s) => s.duplicateObject);
  const deleteObject = useAppStore((s) => s.deleteObject);
  const plotJobs = useAppStore((s) => s.plotJobs);

  return (
    <aside className="panel panel--left panel--creator">
      <div className="panel__header">
        <h2>Create</h2>
        <div className="panel__actions panel__actions--stack">
          <button onClick={() => addPlot('curve')}>+ Curve</button>
          <button onClick={() => addPlot('surface')}>+ Surface</button>
          <button onClick={() => addPlot('implicit')}>+ Implicit</button>
          <button onClick={() => addPointLight()}>+ Light</button>
        </div>
      </div>
      <div className="object-list object-list--compact">
        {objects.map((obj) => {
          const activity = obj.type === 'plot' ? jobActivity(plotJobs[obj.id]) : 'idle';
          const errorDetail = obj.type === 'plot' ? plotJobs[obj.id]?.lastError : undefined;
          return (
            <div
              key={obj.id}
              className={`object-card ${selectedId === obj.id ? 'object-card--selected' : ''} ${obj.visible ? '' : 'object-card--hidden'}`.trim()}
            >
              <button className="object-card__select" onClick={() => selectObject(obj.id)} title={`${obj.name} — ${objectKindLabel(obj)}`}>
                <span className="object-card__icon" aria-hidden="true">{objectIcon(obj)}</span>
                <span className="object-card__swatch" style={{ background: objectSwatchColor(obj) }} aria-hidden="true" />
                <span className="object-card__name">{obj.name}</span>
                {activity === 'busy' ? (
                  <span className="object-card__spinner" role="status" aria-label={`Building ${obj.name}`} />
                ) : null}
                {activity === 'error' ? (
                  <span className="object-card__error" role="img" aria-label="Build error" title={errorDetail ?? 'Build error'}>
                    !
                  </span>
                ) : null}
              </button>
              <div className="object-card__actions">
                <button
                  className="object-card__action"
                  onClick={() => duplicateObject(obj.id)}
                  title={`Duplicate ${obj.name}`}
                  aria-label={`Duplicate ${obj.name}`}
                >
                  ⧉
                </button>
                <button
                  className="object-card__action object-card__action--danger"
                  onClick={() => deleteObject(obj.id)}
                  title={`Delete ${obj.name}`}
                  aria-label={`Delete ${obj.name}`}
                >
                  ×
                </button>
              </div>
              <label className="object-card__toggle" title={obj.type === 'point_light' ? 'Show light gizmo' : 'Show object'}>
                <input
                  aria-label={obj.type === 'point_light' ? `Show gizmo for ${obj.name}` : `Show ${obj.name}`}
                  type="checkbox"
                  checked={obj.visible}
                  onChange={(e) => setObjectVisibility(obj.id, e.target.checked)}
                />
              </label>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
