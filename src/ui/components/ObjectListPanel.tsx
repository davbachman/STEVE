import { useAppStore } from '../../state/store';
import type { PlotJobStatus, SceneObject } from '../../types/contracts';

function objectIcon(obj: SceneObject): string {
  if (obj.type === 'point_light') return '●';
  if (obj.type === 'directional_light') return '➤';
  if (obj.type === 'intersection') return '⋂';
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
  if (obj.type === 'directional_light') return 'Directional light';
  if (obj.type === 'intersection') return 'Surface intersection';
  switch (obj.equation.kind) {
    case 'parametric_curve':
      return 'Parametric curve';
    case 'parametric_surface':
      return 'Parametric surface';
    case 'explicit_surface':
      return obj.equation.graphExpression ? 'Graph' : 'Explicit surface';
    case 'implicit_surface':
      return 'Implicit surface';
  }
}

function objectSwatchColor(obj: SceneObject): string {
  return obj.type === 'point_light' || obj.type === 'directional_light' ? obj.color : obj.material.baseColor;
}

function isLightObject(obj: SceneObject): boolean {
  return obj.type === 'point_light' || obj.type === 'directional_light';
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

export function ObjectCardSummary({
  object,
  activity = 'idle',
  errorDetail,
}: {
  object: SceneObject;
  activity?: 'idle' | 'busy' | 'error';
  errorDetail?: string;
}) {
  return (
    <span className="object-card__summary" title={`${object.name} — ${objectKindLabel(object)}`}>
      <span className="object-card__icon" aria-hidden="true">{objectIcon(object)}</span>
      <span className="object-card__swatch" style={{ background: objectSwatchColor(object) }} aria-hidden="true" />
      <span className="object-card__name">{object.name}</span>
      {activity === 'busy' ? (
        <span className="object-card__spinner" role="status" aria-label={`Building ${object.name}`} />
      ) : null}
      {activity === 'error' ? (
        <span className="object-card__error" role="img" aria-label="Build error" title={errorDetail ?? 'Build error'}>
          !
        </span>
      ) : null}
    </span>
  );
}

export function ObjectListPanel() {
  const addPlot = useAppStore((s) => s.addPlot);
  const addIntersection = useAppStore((s) => s.addIntersection);
  const addPointLight = useAppStore((s) => s.addPointLight);
  const addDirectionalLight = useAppStore((s) => s.addDirectionalLight);
  const objects = useAppStore((s) => s.objects);
  const selectedId = useAppStore((s) => s.selectedId);
  const selectObject = useAppStore((s) => s.selectObject);
  const setObjectVisibility = useAppStore((s) => s.setObjectVisibility);
  const duplicateObject = useAppStore((s) => s.duplicateObject);
  const deleteObject = useAppStore((s) => s.deleteObject);
  const updatePointLight = useAppStore((s) => s.updatePointLight);
  const updateDirectionalLight = useAppStore((s) => s.updateDirectionalLight);
  const plotJobs = useAppStore((s) => s.plotJobs);

  return (
    <aside className="panel panel--left panel--creator">
      <div className="panel__header">
        <h2>Create</h2>
        <div className="creator-groups">
          <section className="creator-group" aria-labelledby="creator-group-curve">
            <h3 id="creator-group-curve">Curve</h3>
            <div className="panel__actions panel__actions--stack">
              <button onClick={() => addPlot('curve')}>+ Parametric</button>
              <button onClick={() => addIntersection()}>+ Intersection</button>
            </div>
          </section>
          <section className="creator-group" aria-labelledby="creator-group-surface">
            <h3 id="creator-group-surface">Surface</h3>
            <div className="panel__actions panel__actions--stack">
              <button onClick={() => addPlot('graph')}>+ Graph</button>
              <button onClick={() => addPlot('surface')}>+ Parametric</button>
              <button onClick={() => addPlot('implicit')}>+ Implicit</button>
            </div>
          </section>
          <section className="creator-group" aria-labelledby="creator-group-lights">
            <h3 id="creator-group-lights">Lights</h3>
            <div className="panel__actions panel__actions--stack">
              <button onClick={() => addPointLight()}>+ Point</button>
              <button onClick={() => addDirectionalLight()}>+ Directional</button>
            </div>
          </section>
        </div>
      </div>
      <div className="object-list object-list--compact">
        {objects.map((obj) => {
          const invalidEquation = obj.type === 'plot' && (obj.equation.source.parseStatus !== 'ok' || obj.equation.source.classification?.kind === 'unknown');
          const activity = invalidEquation ? 'error' : !isLightObject(obj) ? jobActivity(plotJobs[obj.id]) : 'idle';
          const errorDetail = obj.type === 'plot'
            ? obj.equation.source.parseErrors[0]?.message ?? obj.equation.source.classification?.warning ?? plotJobs[obj.id]?.lastError
            : plotJobs[obj.id]?.lastError;
          const light = obj.type === 'point_light' || obj.type === 'directional_light' ? obj : null;
          return (
            <div
              key={obj.id}
              className={`object-card ${selectedId === obj.id ? 'object-card--selected' : ''} ${(light ? light.enabled !== false : obj.visible) ? '' : 'object-card--hidden'}`.trim()}
            >
              <button className="object-card__select" onClick={() => selectObject(obj.id)} title={`${obj.name} — ${objectKindLabel(obj)}`}>
                <ObjectCardSummary object={obj} activity={activity} errorDetail={errorDetail} />
              </button>
              {!light ? <label className="object-card__toggle" title="Show object">
                <input
                  aria-label={`Show ${obj.name}`}
                  type="checkbox"
                  checked={obj.visible}
                  onChange={(e) => setObjectVisibility(obj.id, e.target.checked)}
                />
              </label> : null}
              {light ? (
                <div className="object-card__light-controls">
                  <button
                    type="button"
                    aria-label={`Enable ${light.name}`}
                    aria-pressed={light.enabled !== false}
                    title="Turn illumination on or off"
                    onClick={() => {
                      const patch = { enabled: light.enabled === false };
                      if (light.type === 'point_light') updatePointLight(light.id, patch);
                      else updateDirectionalLight(light.id, patch);
                    }}
                  >⏻ {light.enabled === false ? 'Off' : 'On'}</button>
                  <label title="Show the draggable light handle; illumination is controlled separately">
                    <input
                      aria-label={`Show gizmo for ${light.name}`}
                      type="checkbox"
                      checked={light.visible}
                      onChange={(e) => setObjectVisibility(light.id, e.target.checked)}
                    /> Handle
                  </label>
                </div>
              ) : null}
              {selectedId === obj.id ? (
                <div className="object-card__actions">
                  <button type="button" onClick={() => duplicateObject(obj.id)} aria-label={`Duplicate ${obj.name}`}>Duplicate</button>
                  <button type="button" onClick={() => deleteObject(obj.id)} aria-label={`Delete ${obj.name}`}>Delete</button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
