import { useState, type ReactNode } from 'react';
import {
  DEFAULT_PARAMETER_ANIMATION_SPEED,
  MAX_PARAMETER_ANIMATION_SPEED,
  MIN_PARAMETER_ANIMATION_SPEED,
  clampDiscreteParameterCount,
  discreteParameterStep,
  setEquationParameterBound,
  updateEquationParameterDiscreteCount,
  updateEquationParameterSamplingMode,
  updateEquationParameterValue,
  type ParameterBoundEdge,
} from '../../math/parameters';
import { evaluateNumericInputExpression } from '../../math/numericInput';
import {
  MAX_TURNTABLE_SPEED,
  MIN_TURNTABLE_SPEED,
  materialPresets,
} from '../../state/defaults';
import { useAppStore } from '../../state/store';
import type { MaterialParams, PlotObject, SceneObject } from '../../types/contracts';
import { isSurfacePlot } from '../../types/guards';
import { ObjectCardSummary } from './ObjectListPanel';

const tabs = [
  { id: 'object', label: 'Object' },
  { id: 'material', label: 'Appearance' },
  { id: 'lighting', label: 'Lighting' },
  { id: 'scene', label: 'Scene' },
  { id: 'render', label: 'Render' },
] as const;

export function InspectorPanel() {
  const tab = useAppStore((s) => s.ui.inspectorTab);
  const setTab = useAppStore((s) => s.setInspectorTab);
  const objects = useAppStore((s) => s.objects);
  const selectedId = useAppStore((s) => s.selectedId);
  const selected = objects.find((o) => o.id === selectedId) ?? null;

  return (
    <aside className="panel panel--right">
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.id} className={tab === t.id ? 'tabs__tab tabs__tab--active' : 'tabs__tab'} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="inspector-content">
        {tab === 'object' ? <ObjectTab selected={selected} /> : null}
        {tab === 'material' ? <MaterialTab selected={selected} /> : null}
        {tab === 'lighting' ? <LightingTab selected={selected} /> : null}
        {tab === 'scene' ? <SceneTab /> : null}
        {tab === 'render' ? <RenderTab /> : null}
      </div>
    </aside>
  );
}

function ObjectTab({ selected }: { selected: SceneObject | null }) {
  const updatePlotSpec = useAppStore((s) => s.updatePlotSpec);
  const setObjectName = useAppStore((s) => s.setObjectName);
  const setObjectPosition = useAppStore((s) => s.setObjectPosition);
  const [nameDraftState, setNameDraftState] = useState<{ objectId: string | null; value: string }>({
    objectId: null,
    value: '',
  });

  if (!selected) return <EmptyState text="Select a plot or light" />;
  if (selected.type === 'intersection') return <IntersectionObjectFields intersection={selected} />;

  const position = selected.type === 'plot' ? selected.transform.position : selected.position;
  const nameDraft = nameDraftState.objectId === selected.id ? nameDraftState.value : selected.name;
  const commitName = () => {
    const next = nameDraft.trim();
    if (!next) {
      setNameDraftState({ objectId: selected.id, value: selected.name });
      return;
    }
    if (next !== selected.name) {
      setObjectName(selected.id, next);
    }
  };

  return (
    <div className="inspector-section">
      <label>
        Name
        <input
          type="text"
          value={nameDraft}
          onChange={(e) => setNameDraftState({ objectId: selected.id, value: e.target.value })}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitName();
              (e.currentTarget as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setNameDraftState({ objectId: selected.id, value: selected.name });
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
        />
      </label>
      <NumberTriplet
        label="Position"
        value={position}
        onChange={(next) => setObjectPosition(selected.id, next)}
      />
      {selected.type === 'plot' && selected.equation.kind === 'parametric_curve' ? (
        <>
          <div className="domain-editor">
            <h4>Parameter Bounds</h4>
            <div className="domain-table domain-table--bounds" role="table" aria-label="Curve parameter bounds">
              <span className="domain-table__heading" aria-hidden="true" />
              <span className="domain-table__heading" role="columnheader">Min</span>
              <span className="domain-table__heading" role="columnheader">Max</span>
              <span className="domain-table__axis" role="rowheader">t</span>
              <CompactNumberInput
                ariaLabel="t min"
                step={0.1}
                value={selected.equation.tDomain.min}
                onChange={(value) =>
                  updatePlotSpec(selected.id, (spec) =>
                    spec.kind === 'parametric_curve' ? { ...spec, tDomain: { ...spec.tDomain, min: value } } : spec,
                  )
                }
              />
              <CompactNumberInput
                ariaLabel="t max"
                step={0.1}
                value={selected.equation.tDomain.max}
                onChange={(value) =>
                  updatePlotSpec(selected.id, (spec) =>
                    spec.kind === 'parametric_curve' ? { ...spec, tDomain: { ...spec.tDomain, max: value } } : spec,
                  )
                }
              />
            </div>
          </div>
          <div className="control-grid">
          {selected.equation.renderAsTube ? (
            <RangeField
              label="Width"
              min={0.005}
              max={0.2}
              step={0.001}
              value={selected.equation.tubeRadius}
              onChange={(value) =>
                updatePlotSpec(selected.id, (spec) =>
                  spec.kind === 'parametric_curve' ? { ...spec, tubeRadius: value } : spec,
                )
              }
            />
          ) : null}
          <RangeField
            label="Samples"
            min={16}
            max={800}
            step={1}
            value={selected.equation.tDomain.samples}
            onChange={(value) =>
              updatePlotSpec(selected.id, (spec) =>
                spec.kind === 'parametric_curve' ? { ...spec, tDomain: { ...spec.tDomain, samples: Math.round(value) } } : spec,
              )
            }
          />
          </div>
        </>
      ) : null}
      {selected.type === 'plot' && (selected.equation.kind === 'parametric_surface' || selected.equation.kind === 'explicit_surface') ? (
        <SurfaceDomainEditor plot={selected} />
      ) : null}
      {selected.type === 'plot' && selected.equation.kind === 'implicit_surface' ? <ImplicitEditor plot={selected} /> : null}
      {selected.type === 'plot' ? <EquationParameterEditor plot={selected} /> : null}
      {selected.type === 'point_light' ? <PointLightTabFields light={selected} /> : null}
    </div>
  );
}

function IntersectionObjectFields({ intersection }: { intersection: Extract<SceneObject, { type: 'intersection' }> }) {
  const objects = useAppStore((s) => s.objects);
  const activePick = useAppStore((s) => s.ui.intersectionSourcePick);
  const beginIntersectionSourcePick = useAppStore((s) => s.beginIntersectionSourcePick);

  const sourceObjects = intersection.sourceSurfaceIds.map((sourceId) => {
    const source = sourceId ? objects.find((object) => object.id === sourceId) : null;
    return isSurfacePlot(source) ? source : null;
  });

  return (
    <div className="inspector-section intersection-source-picker">
      <p className="intersection-source-picker__instructions">click the button below and then click the surface</p>
      {([0, 1] as const).map((slot) => {
        const source = sourceObjects[slot];
        const isActive = activePick?.intersectionId === intersection.id && activePick.slot === slot;
        return (
          <button
            type="button"
            key={slot}
            className={`intersection-source-button${source ? ' intersection-source-button--filled' : ''}${isActive ? ' intersection-source-button--active' : ''}`}
            aria-label={`Choose Surface ${slot + 1}`}
            aria-pressed={isActive}
            onClick={() => beginIntersectionSourcePick(intersection.id, slot)}
          >
            <span className="intersection-source-button__label">Surface {slot + 1}</span>
            {source ? (
              <div className="object-card object-card--source-summary">
                <ObjectCardSummary object={source} />
              </div>
            ) : (
              <span className="intersection-source-button__placeholder">
                {isActive ? 'Click a surface in the viewport' : 'Click to choose'}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function MaterialTab({ selected }: { selected: SceneObject | null }) {
  const updatePlotMaterial = useAppStore((s) => s.updatePlotMaterial);
  const applyPreset = useAppStore((s) => s.applyMaterialPreset);
  if (!selected || selected.type === 'point_light') return <EmptyState text="Select a plot or intersection to edit appearance" />;
  const supportsWireframe = selected.type === 'plot'
    && (selected.equation.kind === 'parametric_surface' || selected.equation.kind === 'explicit_surface');
  const supportsContours = selected.type === 'plot' && selected.equation.kind !== 'parametric_curve';
  const clampContourSpacing = (value: number) => Number.isFinite(value) ? Math.min(5, Math.max(0.1, value)) : 0.1;

  return (
    <div className="inspector-section">
      <h3>Material</h3>
      <label>
        Preset
        <select value={selected.material.presetName ?? ''} onChange={(e) => applyPreset(selected.id, e.target.value)}>
          {Object.keys(materialPresets).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Color
        <input type="color" value={selected.material.baseColor} onChange={(e) => updatePlotMaterial(selected.id, { baseColor: e.target.value })} />
      </label>
      <RangeField label="Opacity" min={0} max={1} step={0.01} value={selected.material.opacity} onChange={(v) => updatePlotMaterial(selected.id, { opacity: v })} />
      <RangeField label="Reflectiveness" min={0} max={1} step={0.01} value={selected.material.reflectiveness} onChange={(v) => updatePlotMaterial(selected.id, { reflectiveness: v })} />
      <RangeField label="Roughness" min={0} max={1} step={0.01} value={selected.material.roughness} onChange={(v) => updatePlotMaterial(selected.id, { roughness: v })} />
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={Boolean(selected.material.refractionEnabled)}
          onChange={(e) => updatePlotMaterial(selected.id, { refractionEnabled: e.target.checked })}
        />
        Refraction
      </label>
      {selected.material.refractionEnabled ? (
        <>
          <RangeField
            label="Index of refraction"
            min={1}
            max={2.5}
            step={0.01}
            value={selected.material.ior ?? 1.45}
            onChange={(v) => updatePlotMaterial(selected.id, { ior: v })}
          />
          {selected.material.opacity >= 0.999 ? (
            <div className="inspector-note">Refraction applies when Opacity is below 1.</div>
          ) : null}
        </>
      ) : null}
      <h3>Emission</h3>
      <label>
        Emission color
        <input
          type="color"
          value={selected.material.emissionColor ?? selected.material.baseColor}
          onChange={(e) => updatePlotMaterial(selected.id, { emissionColor: e.target.value })}
        />
      </label>
      <RangeField
        label="Emission strength"
        min={0}
        max={10}
        step={0.05}
        value={selected.material.emissionStrength ?? 0}
        onChange={(value) => updatePlotMaterial(selected.id, {
          emissionStrength: Math.min(10, Math.max(0, value)),
        })}
      />
      {(supportsWireframe || supportsContours) ? <h3>Surface Decorations</h3> : null}
      {supportsWireframe ? (
        <CollapsibleSection
          key={`wireframe-${selected.id}`}
          title="Wireframe"
          defaultOpen={Boolean(selected.material.wireframeVisible)}
        >
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={Boolean(selected.material.wireframeVisible)}
              onChange={(e) => updatePlotMaterial(selected.id, { wireframeVisible: e.target.checked })}
            />
            Wireframe grid
          </label>
          {selected.material.wireframeVisible ? (
            <>
              <label>
                Wireframe color
                <input
                  type="color"
                  value={selected.material.wireframeColor ?? '#000000'}
                  onChange={(e) => updatePlotMaterial(selected.id, { wireframeColor: e.target.value })}
                />
              </label>
              <RangeField
                label="Wire cell step"
                min={1}
                max={20}
                step={1}
                value={selected.material.wireframeCellSize ?? 4}
                onChange={(v) => updatePlotMaterial(selected.id, { wireframeCellSize: Math.round(v) })}
              />
            </>
          ) : null}
        </CollapsibleSection>
      ) : null}
      {supportsContours ? (
        <CollapsibleSection
          key={`contours-${selected.id}`}
          title="Contours"
          defaultOpen={CONTOUR_AXES.some((axis) => contourAxisState(selected.material, axis).visible)}
        >
          <div className="contour-grid" role="group" aria-label="Contour lines">
            <span className="contour-grid__heading" aria-hidden="true" />
            <span className="contour-grid__heading">Color</span>
            <span className="contour-grid__heading">Spacing</span>
            {CONTOUR_AXES.map((axis) => {
              const state = contourAxisState(selected.material, axis);
              return (
                <ContourAxisRow
                  key={axis}
                  axis={axis}
                  state={state}
                  onPatch={(patch) => updatePlotMaterial(selected.id, patch)}
                  clampSpacing={clampContourSpacing}
                />
              );
            })}
          </div>
        </CollapsibleSection>
      ) : null}
    </div>
  );
}

type ContourAxis = 'x' | 'y' | 'z';

const CONTOUR_AXES: readonly ContourAxis[] = ['z', 'y', 'x'];

function contourAxisState(material: MaterialParams, axis: ContourAxis): { visible: boolean; color: string; spacing: number } {
  switch (axis) {
    case 'x':
      return {
        visible: Boolean(material.xContoursVisible),
        color: material.xContourColor ?? '#000000',
        spacing: material.xContourSpacing ?? 1,
      };
    case 'y':
      return {
        visible: Boolean(material.yContoursVisible),
        color: material.yContourColor ?? '#000000',
        spacing: material.yContourSpacing ?? 1,
      };
    case 'z':
      return {
        visible: Boolean(material.zContoursVisible),
        color: material.zContourColor ?? '#000000',
        spacing: material.zContourSpacing ?? 1,
      };
  }
}

function contourAxisPatch(
  axis: ContourAxis,
  patch: { visible?: boolean; color?: string; spacing?: number },
): Partial<MaterialParams> {
  switch (axis) {
    case 'x':
      return {
        ...(patch.visible !== undefined ? { xContoursVisible: patch.visible } : null),
        ...(patch.color !== undefined ? { xContourColor: patch.color } : null),
        ...(patch.spacing !== undefined ? { xContourSpacing: patch.spacing } : null),
      };
    case 'y':
      return {
        ...(patch.visible !== undefined ? { yContoursVisible: patch.visible } : null),
        ...(patch.color !== undefined ? { yContourColor: patch.color } : null),
        ...(patch.spacing !== undefined ? { yContourSpacing: patch.spacing } : null),
      };
    case 'z':
      return {
        ...(patch.visible !== undefined ? { zContoursVisible: patch.visible } : null),
        ...(patch.color !== undefined ? { zContourColor: patch.color } : null),
        ...(patch.spacing !== undefined ? { zContourSpacing: patch.spacing } : null),
      };
  }
}

function ContourAxisRow({
  axis,
  state,
  onPatch,
  clampSpacing,
}: {
  axis: ContourAxis;
  state: { visible: boolean; color: string; spacing: number };
  onPatch: (patch: Partial<MaterialParams>) => void;
  clampSpacing: (value: number) => number;
}) {
  return (
    <>
      <label className="checkbox-row contour-grid__toggle">
        <input
          type="checkbox"
          checked={state.visible}
          onChange={(e) => onPatch(contourAxisPatch(axis, { visible: e.target.checked }))}
        />
        {axis.toUpperCase()}
      </label>
      <input
        type="color"
        value={state.color}
        disabled={!state.visible}
        aria-label={`${axis.toUpperCase()} contour color`}
        onChange={(e) => onPatch(contourAxisPatch(axis, { color: e.target.value }))}
      />
      <NumericExpressionInput
        value={state.spacing}
        disabled={!state.visible}
        ariaLabel={`${axis.toUpperCase()} contour spacing`}
        step={0.1}
        onChange={(value) => onPatch(contourAxisPatch(axis, { spacing: clampSpacing(value) }))}
      />
    </>
  );
}

function CollapsibleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="collapsible">
      <button
        type="button"
        className="collapsible__header"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`collapsible__chevron${open ? ' is-open' : ''}`} aria-hidden="true">▸</span>
        {title}
      </button>
      {open ? <div className="collapsible__body">{children}</div> : null}
    </div>
  );
}

function LightingTab({ selected }: { selected: SceneObject | null }) {
  const scene = useAppStore((s) => s.scene);
  const updateScene = useAppStore((s) => s.updateScene);

  return (
    <div className="inspector-section">
      <h3>General Lighting</h3>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={scene.ambient.enabled}
          onChange={(e) => updateScene({ ambient: { ...scene.ambient, enabled: e.target.checked } })}
        />
        Ambient light
      </label>
      {scene.ambient.enabled ? (
        <>
          <label>
            Color
            <input type="color" value={scene.ambient.color} onChange={(e) => updateScene({ ambient: { ...scene.ambient, color: e.target.value } })} />
          </label>
          <RangeField label="Intensity" min={0} max={2} step={0.01} value={scene.ambient.intensity} onChange={(v) => updateScene({ ambient: { ...scene.ambient, intensity: v } })} />
        </>
      ) : null}

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={scene.directional.enabled}
          onChange={(e) => updateScene({ directional: { ...scene.directional, enabled: e.target.checked } })}
        />
        Directional light
      </label>
      {scene.directional.enabled ? (
        <>
          <label>
            Color
            <input type="color" value={scene.directional.color} onChange={(e) => updateScene({ directional: { ...scene.directional, color: e.target.value } })} />
          </label>
          <RangeField label="Intensity" min={0} max={4} step={0.01} value={scene.directional.intensity} onChange={(v) => updateScene({ directional: { ...scene.directional, intensity: v } })} />
          <SunAngleFields
            direction={scene.directional.direction}
            onChange={(direction) => updateScene({ directional: { ...scene.directional, direction } })}
          />
          <NumberTriplet
            label="Direction (points toward scene)"
            value={scene.directional.direction}
            onChange={(value) => updateScene({ directional: { ...scene.directional, direction: value } })}
          />
          <div className="inspector-note">Directional vector uses “light rays travel in this direction” semantics (points toward the scene).</div>

          <h3>Shadows</h3>
          <label className="checkbox-row">
            <input type="checkbox" checked={scene.directional.castShadows} onChange={(e) => updateScene({ directional: { ...scene.directional, castShadows: e.target.checked } })} />
            Directional shadows
          </label>
          {scene.directional.castShadows ? (
            <>
              <label>
                Shadow map resolution
                <select
                  value={String(scene.shadow.shadowMapResolution)}
                  onChange={(e) => updateScene({ shadow: { ...scene.shadow, shadowMapResolution: Number(e.target.value) } })}
                >
                  {![512, 1024, 2048, 4096].includes(scene.shadow.shadowMapResolution) ? (
                    <option value={String(scene.shadow.shadowMapResolution)}>{scene.shadow.shadowMapResolution}</option>
                  ) : null}
                  <option value="512">512</option>
                  <option value="1024">1024</option>
                  <option value="2048">2048</option>
                  <option value="4096">4096</option>
                </select>
              </label>
              <RangeField
                label="Shadow softness"
                min={0}
                max={1}
                step={0.01}
                value={scene.shadow.shadowSoftness}
                onChange={(v) => updateScene({ shadow: { ...scene.shadow, shadowSoftness: v } })}
              />
            </>
          ) : null}
        </>
      ) : null}

      {selected?.type === 'point_light' ? (
        <div className="inspector-note">Selected point light can also be edited in the Object tab.</div>
      ) : null}
    </div>
  );
}

function SunAngleFields({
  direction,
  onChange,
}: {
  direction: { x: number; y: number; z: number };
  onChange: (direction: { x: number; y: number; z: number }) => void;
}) {
  // The sliders describe where the light comes FROM (like a sun position);
  // the stored vector is the travel direction, i.e. its negation.
  const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
  const sourceX = -direction.x / length;
  const sourceY = -direction.y / length;
  const sourceZ = -direction.z / length;
  const elevationDeg = (Math.asin(Math.min(1, Math.max(-1, sourceZ))) * 180) / Math.PI;
  const azimuthDeg = ((Math.atan2(sourceY, sourceX) * 180) / Math.PI + 360) % 360;

  const applyAngles = (nextAzimuthDeg: number, nextElevationDeg: number) => {
    const azimuth = (nextAzimuthDeg * Math.PI) / 180;
    const elevation = (Math.min(89, Math.max(-89, nextElevationDeg)) * Math.PI) / 180;
    const cosElevation = Math.cos(elevation);
    onChange({
      x: -(cosElevation * Math.cos(azimuth)),
      y: -(cosElevation * Math.sin(azimuth)),
      z: -Math.sin(elevation),
    });
  };

  return (
    <>
      <RangeField
        label="Sun azimuth (°)"
        min={0}
        max={360}
        step={1}
        value={Math.round(azimuthDeg)}
        onChange={(v) => applyAngles(v, elevationDeg)}
      />
      <RangeField
        label="Sun elevation (°)"
        min={-89}
        max={89}
        step={1}
        value={Math.round(elevationDeg)}
        onChange={(v) => applyAngles(azimuthDeg, v)}
      />
    </>
  );
}

function SceneTab() {
  const scene = useAppStore((s) => s.scene);
  const updateScene = useAppStore((s) => s.updateScene);
  return (
    <div className="inspector-section">
      <h3>Scene</h3>
      <label>
        Camera Projection
        <select
          value={scene.cameraProjection}
          onChange={(e) => updateScene({ cameraProjection: e.target.value as 'perspective' | 'orthographic' })}
        >
          <option value="perspective">Perspective</option>
          <option value="orthographic">Orthographic</option>
        </select>
      </label>
      <button
        type="button"
        className={scene.turntableEnabled ? 'turntable-toggle is-active' : 'turntable-toggle'}
        aria-pressed={scene.turntableEnabled}
        onClick={() => updateScene({ turntableEnabled: !scene.turntableEnabled })}
      >
        Turntable animation
      </button>
      {scene.turntableEnabled ? (
        <RangeField
          label="Orbit speed (°/s)"
          min={MIN_TURNTABLE_SPEED}
          max={MAX_TURNTABLE_SPEED}
          step={1}
          value={scene.turntableSpeed}
          onChange={(value) => updateScene({
            turntableSpeed: Math.min(MAX_TURNTABLE_SPEED, Math.max(MIN_TURNTABLE_SPEED, value)),
          })}
        />
      ) : null}
      <label>
        Background Mode
        <select value={scene.backgroundMode} onChange={(e) => updateScene({ backgroundMode: e.target.value as 'solid' | 'gradient' })}>
          <option value="solid">Solid</option>
          <option value="gradient">Gradient</option>
        </select>
      </label>
      <label>
        Solid Color
        <input type="color" value={scene.backgroundColor} onChange={(e) => updateScene({ backgroundColor: e.target.value })} />
      </label>
      <label>
        Gradient Top
        <input type="color" value={scene.gradientTopColor} onChange={(e) => updateScene({ gradientTopColor: e.target.value })} />
      </label>
      <label>
        Gradient Bottom
        <input type="color" value={scene.gradientBottomColor} onChange={(e) => updateScene({ gradientBottomColor: e.target.value })} />
      </label>
      <label className="checkbox-row">
        <input type="checkbox" checked={scene.groundPlaneVisible} onChange={(e) => updateScene({ groundPlaneVisible: e.target.checked })} />
        Ground plane
      </label>
      {scene.groundPlaneVisible ? (
        <>
          <RangeField label="Ground Size" min={1} max={80} step={1} value={scene.groundPlaneSize} onChange={(v) => updateScene({ groundPlaneSize: v })} />
          <label>
            Ground Color
            <input type="color" value={scene.groundPlaneColor} onChange={(e) => updateScene({ groundPlaneColor: e.target.value })} />
          </label>
          <RangeField label="Ground Roughness" min={0} max={1} step={0.01} value={scene.groundPlaneRoughness} onChange={(v) => updateScene({ groundPlaneRoughness: v })} />
          <label className="checkbox-row">
            <input type="checkbox" checked={scene.groundPlaneReflective} onChange={(e) => updateScene({ groundPlaneReflective: e.target.checked })} />
            Ground reflection
          </label>
        </>
      ) : null}
      <label className="checkbox-row">
        <input type="checkbox" checked={scene.gridVisible} onChange={(e) => updateScene({ gridVisible: e.target.checked })} />
        XY grid
      </label>
      {scene.gridVisible ? (
        <>
          <RangeField label="Grid Extent" min={1} max={80} step={1} value={scene.gridExtent} onChange={(v) => updateScene({ gridExtent: v })} />
          <RangeField label="Grid Spacing" min={0.1} max={10} step={0.1} value={scene.gridSpacing} onChange={(v) => updateScene({ gridSpacing: v })} />
          <RangeField label="Grid Opacity" min={0} max={1} step={0.01} value={scene.gridLineOpacity} onChange={(v) => updateScene({ gridLineOpacity: v })} />
        </>
      ) : null}
      <label className="checkbox-row">
        <input type="checkbox" checked={scene.axesVisible} onChange={(e) => updateScene({ axesVisible: e.target.checked })} />
        Axes
      </label>
      {scene.axesVisible ? (
        <>
          <RangeField label="Axes Length" min={1} max={30} step={0.5} value={scene.axesLength} onChange={(v) => updateScene({ axesLength: v })} />
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={scene.axisLabelsVisible}
              onChange={(e) => updateScene({ axisLabelsVisible: e.target.checked })}
            />
            Axis labels
          </label>
        </>
      ) : null}
      <BoundsEditor />
    </div>
  );
}

function RenderTab() {
  const render = useAppStore((s) => s.render);
  const updateRender = useAppStore((s) => s.updateRender);
  const diagnostics = useAppStore((s) => s.renderDiagnostics);
  return (
    <div className="inspector-section">
      <h3>Render</h3>
      <label>
        Tone Mapping
        <select value={render.toneMapping} onChange={(e) => updateRender({ toneMapping: e.target.value as typeof render.toneMapping })}>
          <option value="aces">ACES</option>
          <option value="filmic">Filmic</option>
          <option value="none">None</option>
        </select>
      </label>
      <RangeField label="Exposure" min={0.2} max={3} step={0.01} value={render.exposure} onChange={(v) => updateRender({ exposure: v })} />
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={render.bloomEnabled ?? true}
          onChange={(e) => updateRender({ bloomEnabled: e.target.checked })}
        />
        Bloom
      </label>
      {(render.bloomEnabled ?? true) ? (
        <>
          <RangeField
            label="Bloom strength"
            min={0}
            max={2}
            step={0.01}
            value={render.bloomStrength ?? 0.65}
            onChange={(v) => updateRender({ bloomStrength: v })}
          />
          <RangeField
            label="Bloom radius"
            min={0.25}
            max={4}
            step={0.05}
            value={render.bloomRadius ?? 1.5}
            onChange={(v) => updateRender({ bloomRadius: v })}
          />
          <RangeField
            label="Bloom threshold"
            min={0}
            max={5}
            step={0.05}
            value={render.bloomThreshold ?? 1}
            onChange={(v) => updateRender({ bloomThreshold: v })}
          />
        </>
      ) : null}
      <label className="checkbox-row">
        <input type="checkbox" checked={render.showDiagnostics} onChange={(e) => updateRender({ showDiagnostics: e.target.checked })} />
        Render diagnostics overlay
      </label>
      {render.showDiagnostics ? (
        <div className="inspector-note">
          <div>Backend: {diagnostics.backend}</div>
          <div>WebGL2: {diagnostics.webglReady ? 'ready' : 'not ready'}</div>
          <div>Plots: {diagnostics.plotCount}</div>
          <div>Point lights: {diagnostics.pointLightCount}</div>
          <div>Frame: {diagnostics.frameTimeMs.toFixed(1)} ms ({diagnostics.fps.toFixed(1)} fps)</div>
          <div>Point shadows: {diagnostics.pointShadowCount}</div>
          <div>Shadow atlas usage: {(diagnostics.shadowAtlasUsage * 100).toFixed(0)}%</div>
          <div>Transmittance casters: {diagnostics.transmittanceShadowCasters}</div>
          <div>Opaque casters: {diagnostics.opaqueShadowCasters}</div>
          <div>Reflection source: {diagnostics.reflectionSource}</div>
          <div>Reflection probes: {diagnostics.activeProbeCount} | refreshes {diagnostics.reflectionProbeRefreshCount}</div>
          <div>Outline mode: {diagnostics.outlineMode}</div>
        </div>
      ) : null}
    </div>
  );
}

function SurfaceDomainEditor({ plot }: { plot: PlotObject }) {
  const updatePlotSpec = useAppStore((s) => s.updatePlotSpec);
  if (plot.equation.kind !== 'parametric_surface' && plot.equation.kind !== 'explicit_surface') {
    return <></>;
  }
  const domain = plot.equation.domain;
  const [firstAxisLabel, secondAxisLabel] = plot.equation.kind === 'explicit_surface'
    ? plot.equation.domainAxes
    : ['u', 'v'];
  const updateDomain = (patch: Partial<typeof domain>) => {
    updatePlotSpec(plot.id, (spec) => (
      (spec.kind === 'parametric_surface' || spec.kind === 'explicit_surface')
        ? { ...spec, domain: { ...spec.domain, ...patch } }
        : spec
    ));
  };
  return (
    <div className="domain-editor">
      <h4>Parameter Bounds</h4>
      <div
        className="domain-table domain-table--bounds"
        role="table"
        aria-label={plot.equation.kind === 'explicit_surface' ? 'Graph parameter bounds' : 'Parametric surface parameter bounds'}
      >
        <span className="domain-table__heading" aria-hidden="true" />
        <span className="domain-table__heading" role="columnheader">Min</span>
        <span className="domain-table__heading" role="columnheader">Max</span>
        <span className="domain-table__axis" role="rowheader">{firstAxisLabel}</span>
        <CompactNumberInput ariaLabel={`${firstAxisLabel} min`} step={0.1} value={domain.uMin} onChange={(value) => updateDomain({ uMin: value })} />
        <CompactNumberInput ariaLabel={`${firstAxisLabel} max`} step={0.1} value={domain.uMax} onChange={(value) => updateDomain({ uMax: value })} />
        <span className="domain-table__axis" role="rowheader">{secondAxisLabel}</span>
        <CompactNumberInput ariaLabel={`${secondAxisLabel} min`} step={0.1} value={domain.vMin} onChange={(value) => updateDomain({ vMin: value })} />
        <CompactNumberInput ariaLabel={`${secondAxisLabel} max`} step={0.1} value={domain.vMax} onChange={(value) => updateDomain({ vMax: value })} />
      </div>
      <RangeField label={`${firstAxisLabel} samples`} min={8} max={256} step={1} value={domain.uSamples} onChange={(value) => updateDomain({ uSamples: Math.round(value) })} />
      <RangeField label={`${secondAxisLabel} samples`} min={8} max={256} step={1} value={domain.vSamples} onChange={(value) => updateDomain({ vSamples: Math.round(value) })} />
    </div>
  );
}

function ImplicitEditor({ plot }: { plot: PlotObject }) {
  const updatePlotSpec = useAppStore((s) => s.updatePlotSpec);
  const spec = plot.equation;
  if (spec.kind !== 'implicit_surface') return <></>;
  const boundsInfo = analyzeBounds(spec.bounds);

  return (
    <div className="inspector-section">
      <label>
        Quality
        <select value={spec.quality} onChange={(e) => updatePlotSpec(plot.id, (s) => (s.kind === 'implicit_surface' ? { ...s, quality: e.target.value as typeof s.quality } : s))}>
          <option value="draft">Draft</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </label>
      <BoundsEditor objectId={plot.id} />
      {!boundsInfo.valid ? (
        <div className="inspector-note">
          Invalid bounds: each axis must have finite values and `min &lt; max`. Meshing will be skipped until fixed.
        </div>
      ) : null}
      {boundsInfo.valid && boundsInfo.volumeWarning ? (
        <div className="inspector-note">
          Large implicit bounds volume ({boundsInfo.volume.toFixed(0)} units^3). `Medium/High` quality may take longer; use smaller bounds for faster preview/refine.
        </div>
      ) : null}
    </div>
  );
}

function EquationParameterEditor({ plot }: { plot: PlotObject }) {
  const updatePlotSpec = useAppStore((s) => s.updatePlotSpec);
  const beginEquationParameterDrag = useAppStore((s) => s.beginEquationParameterDrag);
  const commitEquationParameterDrag = useAppStore((s) => s.commitEquationParameterDrag);
  const setParameterAnimation = useAppStore((s) => s.setParameterAnimation);
  if (plot.equation.parameters.length === 0) {
    return null;
  }

  return (
    <div className="inspector-section">
      <h3>Constants</h3>
      <div className="inspector-note">
        Slide a constant to either end, then type in its box to move that end of the range.
      </div>
      {plot.equation.parameters.map((parameter) => {
        const isDiscrete = parameter.samplingMode === 'discrete';
        return (
          <div key={parameter.name} className="equation-parameter">
            <div className="equation-parameter__header">
              <span>{parameter.name}</span>
              <span className="equation-parameter__header-actions">
                <button
                  type="button"
                  className={parameter.samplingMode === 'discrete' ? 'equation-parameter__mode equation-parameter__mode--active' : 'equation-parameter__mode'}
                  onClick={() => {
                    updatePlotSpec(plot.id, (spec) => ({
                      ...spec,
                      parameters: updateEquationParameterSamplingMode(
                        spec.parameters,
                        parameter.name,
                        parameter.samplingMode === 'discrete' ? 'continuous' : 'discrete',
                      ),
                    }));
                    if (parameter.animating) {
                      // Playback has different meanings in each mode, so a mode
                      // switch always starts with the new mode paused.
                      setParameterAnimation(plot.id, parameter.name, { animating: false });
                    }
                  }}
                >
                  {parameter.samplingMode === 'discrete' ? 'Discrete' : 'Continuous'}
                </button>
                <button
                  type="button"
                  className="parameter-editor__play"
                  title={
                    isDiscrete
                      ? parameter.animating
                        ? `Show only the selected ${parameter.name} copy`
                        : `Show all ${parameter.discreteCount} ${parameter.name} copies`
                      : parameter.animating
                        ? `Pause ${parameter.name}`
                        : `Animate ${parameter.name} between its min and max`
                  }
                  aria-label={
                    isDiscrete
                      ? parameter.animating
                        ? `Show only selected ${parameter.name} copy`
                        : `Show all ${parameter.name} copies`
                      : parameter.animating
                        ? `Pause ${parameter.name}`
                        : `Animate ${parameter.name}`
                  }
                  aria-pressed={Boolean(parameter.animating)}
                  onClick={() => setParameterAnimation(plot.id, parameter.name, { animating: !parameter.animating })}
                >
                  {parameter.animating ? '⏸' : '▶'}
                </button>
              </span>
            </div>
            <RangeField
              label="Value"
              min={parameter.min}
              max={parameter.max}
              step={isDiscrete
                ? discreteParameterStep(parameter.min, parameter.max, parameter.discreteCount)
                : parameter.step}
              value={parameter.value}
              onDragStart={() => beginEquationParameterDrag(plot.id, parameter.name)}
              onDragEnd={() => commitEquationParameterDrag(plot.id, parameter.name)}
              onChange={(value) =>
                updatePlotSpec(plot.id, (spec) => ({
                  ...spec,
                  parameters: updateEquationParameterValue(spec.parameters, parameter.name, value),
                }))
              }
              onSetBound={
                parameter.animating && !isDiscrete
                  ? undefined
                  : (edge, bound) =>
                      updatePlotSpec(plot.id, (spec) => ({
                        ...spec,
                        parameters: setEquationParameterBound(spec.parameters, parameter.name, edge, bound),
                      }))
              }
            />
            {isDiscrete ? (
              <RangeField
                label="num copies"
                min={1}
                max={64}
                step={1}
                value={parameter.discreteCount}
                onDragStart={() => beginEquationParameterDrag(plot.id, `${parameter.name}:discreteCount`)}
                onDragEnd={() => commitEquationParameterDrag(plot.id, `${parameter.name}:discreteCount`)}
                onChange={(value) =>
                  updatePlotSpec(plot.id, (spec) => ({
                    ...spec,
                    parameters: updateEquationParameterDiscreteCount(
                      spec.parameters,
                      parameter.name,
                      clampDiscreteParameterCount(value),
                    ),
                  }))
                }
              />
            ) : parameter.animating ? (
              <RangeField
                label={`${parameter.name} speed`}
                min={MIN_PARAMETER_ANIMATION_SPEED}
                max={MAX_PARAMETER_ANIMATION_SPEED}
                step={0.01}
                value={parameter.animationSpeed ?? DEFAULT_PARAMETER_ANIMATION_SPEED}
                onChange={(value) => setParameterAnimation(plot.id, parameter.name, { animationSpeed: value })}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function PointLightTabFields({ light }: { light: Extract<SceneObject, { type: 'point_light' }> }) {
  const updatePointLight = useAppStore((s) => s.updatePointLight);
  return (
    <div className="inspector-section">
      <label>
        Color
        <input
          type="color"
          value={light.color}
          onChange={(e) => updatePointLight(light.id, { color: e.target.value })}
        />
      </label>
      <RangeField label="Intensity" min={0} max={100} step={1} value={light.intensity} onChange={(v) => updatePointLight(light.id, { intensity: v })} />
      <RangeField label="Range" min={1} max={100} step={1} value={light.range} onChange={(v) => updatePointLight(light.id, { range: v })} />
      <label className="checkbox-row">
        <input type="checkbox" checked={light.castShadows} onChange={(e) => updatePointLight(light.id, { castShadows: e.target.checked })} />
        Cast shadows
      </label>
    </div>
  );
}

function BoundsEditor({ objectId }: { objectId?: string } = {}) {
  const scene = useAppStore((s) => s.scene);
  const updateScene = useAppStore((s) => s.updateScene);
  const updatePlotSpec = useAppStore((s) => s.updatePlotSpec);
  const objectPlot = objectId
    ? (useAppStore.getState().objects.find((o) => o.id === objectId && o.type === 'plot') as PlotObject | undefined)
    : undefined;
  const targetBounds =
    objectPlot && objectPlot.equation.kind === 'implicit_surface'
      ? objectPlot.equation.bounds
      : scene.defaultGraphBounds;

  const setBounds = (axis: 'x' | 'y' | 'z', side: 'min' | 'max', value: number) => {
    if (objectId) {
      updatePlotSpec(objectId, (spec) =>
        spec.kind === 'implicit_surface'
          ? { ...spec, bounds: { ...spec.bounds, [side]: { ...spec.bounds[side], [axis]: value } } }
          : spec,
      );
      return;
    }
    updateScene({ defaultGraphBounds: { ...scene.defaultGraphBounds, [side]: { ...scene.defaultGraphBounds[side], [axis]: value } } });
  };

  return (
    <div className="bounds-editor">
      <h4>{objectId ? 'Object Bounds' : 'Default Graph Bounds'}</h4>
      <div
        className="domain-table domain-table--bounds"
        role="table"
        aria-label={objectId ? 'Implicit surface object bounds' : 'Default graph bounds'}
      >
        <span className="domain-table__heading" aria-hidden="true" />
        <span className="domain-table__heading" role="columnheader">Min</span>
        <span className="domain-table__heading" role="columnheader">Max</span>
        {(['x', 'y', 'z'] as const).map((axis) => (
          <div className="domain-table__row" role="row" key={axis}>
            <span className="domain-table__axis" role="rowheader">{axis}</span>
            <CompactNumberInput
              ariaLabel={`${axis} min`}
              step={0.1}
              value={targetBounds.min[axis]}
              onChange={(value) => setBounds(axis, 'min', value)}
            />
            <CompactNumberInput
              ariaLabel={`${axis} max`}
              step={0.1}
              value={targetBounds.max[axis]}
              onChange={(value) => setBounds(axis, 'max', value)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function NumberTriplet({
  label,
  value,
  onChange,
}: {
  label: string;
  value: { x: number; y: number; z: number };
  onChange: (value: { x: number; y: number; z: number }) => void;
}) {
  return (
    <div className="control-grid control-grid--triplet">
      <span className="control-grid__label">{label}</span>
      {(['x', 'y', 'z'] as const).map((axis) => (
        <label key={axis}>
          {axis}
          <NumericExpressionInput
            value={value[axis]}
            step={0.1}
            ariaLabel={`${label} ${axis}`}
            onChange={(next) => onChange({ ...value, [axis]: next })}
          />
        </label>
      ))}
    </div>
  );
}

function CompactNumberInput({
  ariaLabel,
  value,
  step,
  onChange,
}: {
  ariaLabel: string;
  value: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <NumericExpressionInput
      ariaLabel={ariaLabel}
      value={value}
      step={step}
      onChange={onChange}
    />
  );
}

export function RangeField({
  label,
  min,
  max,
  step,
  value,
  onChange,
  onDragStart,
  onDragEnd,
  onSetBound,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onSetBound?: (edge: ParameterBoundEdge, value: number) => void;
}) {
  // Typed values may exceed the nominal slider bounds; the slider range grows
  // to include the current value so it never snaps the value back.
  const sliderMin = Math.min(min, Number.isFinite(value) ? value : min);
  const sliderMax = Math.max(max, Number.isFinite(value) ? value : max);
  return (
    <label className="range-field">
      <span>{label}</span>
      <div className="range-field__controls">
        <input
          type="range"
          min={sliderMin}
          max={sliderMax}
          step={step}
          value={value}
          onChange={(e) => {
            onDragStart?.();
            onChange(Number(e.target.value));
          }}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onBlur={onDragEnd}
        />
        <BoundEditingNumberInput
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={onChange}
          onSetBound={onSetBound}
        />
      </div>
    </label>
  );
}

/**
 * Draft-based number input for all range fields: edits commit on Enter or
 * blur so half-typed numbers never apply. When onSetBound is provided and the
 * thumb is parked at either end of the range, a typed number re-pins that end
 * instead of just setting the value.
 */
function BoundEditingNumberInput({
  value,
  min,
  max,
  step,
  onChange,
  onSetBound,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onSetBound?: (edge: ParameterBoundEdge, value: number) => void;
}) {
  const tolerance = Math.max(Math.abs(max - min), 1) * 1e-12;
  const parkedEdge: ParameterBoundEdge | null = onSetBound
    ? Math.abs(value - min) <= tolerance ? 'min' : Math.abs(value - max) <= tolerance ? 'max' : null
    : null;

  const commit = (parsed: number) => {
    if (onSetBound && parkedEdge === 'min' && parsed !== min && parsed < max) {
      onSetBound('min', parsed);
      return;
    }
    if (onSetBound && parkedEdge === 'max' && parsed !== max && parsed > min) {
      onSetBound('max', parsed);
      return;
    }
    if (parsed !== value) {
      onChange(parsed);
    }
  };

  return (
    <span className="range-field__number">
      <NumericExpressionInput
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={commit}
        title={
          parkedEdge
            ? `Typing here sets the slider ${parkedEdge === 'min' ? 'minimum' : 'maximum'} (Enter to apply)`
            : onSetBound
              ? 'Type a value; with the slider at either end, typing sets that end of the range'
              : 'Type a value (Enter to apply)'
        }
      />
      {parkedEdge ? (
        <span className="range-field__bound-chip" aria-hidden="true">
          sets {parkedEdge}
        </span>
      ) : null}
    </span>
  );
}

function NumericExpressionInput({
  value,
  step,
  onChange,
  disabled,
  ariaLabel,
  title,
}: {
  value: number;
  step?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  ariaLabel?: string;
  title?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  const commit = (raw: string) => {
    const evaluated = evaluateNumericInputExpression(raw);
    if (evaluated === null) {
      setInvalid(true);
      return;
    }
    setDraft(null);
    setInvalid(false);
    if (evaluated !== value) onChange(evaluated);
  };

  return (
    <input
      type="text"
      inputMode="text"
      className="numeric-expression-input"
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      data-step={step}
      value={draft ?? (Number.isFinite(value) ? value : 0)}
      disabled={disabled}
      onChange={(event) => {
        setDraft(event.target.value);
        setInvalid(false);
      }}
      onBlur={(event) => {
        if (draft !== null) commit(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit(event.currentTarget.value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(null);
          setInvalid(false);
        }
      }}
      title={title ?? 'Enter a number or expression, such as pi/2 or sqrt(2)'}
    />
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="inspector-note">{text}</div>;
}

function analyzeBounds(bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }) {
  const spanX = bounds.max.x - bounds.min.x;
  const spanY = bounds.max.y - bounds.min.y;
  const spanZ = bounds.max.z - bounds.min.z;
  const valid = [spanX, spanY, spanZ].every((s) => Number.isFinite(s) && s > 0);
  const volume = valid ? spanX * spanY * spanZ : Number.NaN;
  return {
    valid,
    volume,
    volumeWarning: valid && volume > 50_000,
  };
}
