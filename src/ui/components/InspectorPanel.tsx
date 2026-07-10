import { useState } from 'react';
import { updateEquationParameterValue } from '../../math/parameters';
import { materialPresets } from '../../state/defaults';
import { useAppStore } from '../../state/store';
import type { PlotObject, PointLightObject } from '../../types/contracts';

const tabs = [
  { id: 'object', label: 'Object' },
  { id: 'material', label: 'Material' },
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

function ObjectTab({ selected }: { selected: PlotObject | PointLightObject | null }) {
  const updatePlotSpec = useAppStore((s) => s.updatePlotSpec);
  const setObjectName = useAppStore((s) => s.setObjectName);
  const setObjectPosition = useAppStore((s) => s.setObjectPosition);
  const [nameDraftState, setNameDraftState] = useState<{ objectId: string | null; value: string }>({
    objectId: null,
    value: '',
  });

  if (!selected) return <EmptyState text="Select a plot or light" />;

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
        <div className="control-grid">
          <RangeField
            label="t min"
            min={-40}
            max={40}
            step={0.1}
            value={selected.equation.tDomain.min}
            onChange={(value) =>
              updatePlotSpec(selected.id, (spec) =>
                spec.kind === 'parametric_curve' ? { ...spec, tDomain: { ...spec.tDomain, min: value } } : spec,
              )
            }
          />
          <RangeField
            label="t max"
            min={-40}
            max={40}
            step={0.1}
            value={selected.equation.tDomain.max}
            onChange={(value) =>
              updatePlotSpec(selected.id, (spec) =>
                spec.kind === 'parametric_curve' ? { ...spec, tDomain: { ...spec.tDomain, max: value } } : spec,
              )
            }
          />
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

function MaterialTab({ selected }: { selected: PlotObject | PointLightObject | null }) {
  const updatePlotMaterial = useAppStore((s) => s.updatePlotMaterial);
  const applyPreset = useAppStore((s) => s.applyMaterialPreset);
  if (!selected || selected.type !== 'plot') return <EmptyState text="Select a plot to edit material" />;
  const supportsWireframe = selected.equation.kind === 'parametric_surface' || selected.equation.kind === 'explicit_surface';
  const supportsContours = selected.equation.kind !== 'parametric_curve';
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
      {(supportsWireframe || supportsContours) ? <h3>Surface Decorations</h3> : null}
      {supportsWireframe ? (
        <>
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
        </>
      ) : null}
      {supportsContours ? (
        <>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={Boolean(selected.material.zContoursVisible)}
              onChange={(e) => updatePlotMaterial(selected.id, { zContoursVisible: e.target.checked })}
            />
            Z contours
          </label>
          {selected.material.zContoursVisible ? (
            <>
              <label>
                Z contour color
                <input
                  type="color"
                  value={selected.material.zContourColor ?? '#000000'}
                  onChange={(e) => updatePlotMaterial(selected.id, { zContourColor: e.target.value })}
                />
              </label>
              <RangeField
                label="Z contour spacing"
                min={0.1}
                max={5}
                step={0.1}
                value={selected.material.zContourSpacing ?? 1}
                onChange={(v) => updatePlotMaterial(selected.id, { zContourSpacing: clampContourSpacing(v) })}
              />
            </>
          ) : null}
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={Boolean(selected.material.yContoursVisible)}
              onChange={(e) => updatePlotMaterial(selected.id, { yContoursVisible: e.target.checked })}
            />
            Y contours
          </label>
          {selected.material.yContoursVisible ? (
            <>
              <label>
                Y contour color
                <input
                  type="color"
                  value={selected.material.yContourColor ?? '#000000'}
                  onChange={(e) => updatePlotMaterial(selected.id, { yContourColor: e.target.value })}
                />
              </label>
              <RangeField
                label="Y contour spacing"
                min={0.1}
                max={5}
                step={0.1}
                value={selected.material.yContourSpacing ?? 1}
                onChange={(v) => updatePlotMaterial(selected.id, { yContourSpacing: clampContourSpacing(v) })}
              />
            </>
          ) : null}
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={Boolean(selected.material.xContoursVisible)}
              onChange={(e) => updatePlotMaterial(selected.id, { xContoursVisible: e.target.checked })}
            />
            X contours
          </label>
          {selected.material.xContoursVisible ? (
            <>
              <label>
                X contour color
                <input
                  type="color"
                  value={selected.material.xContourColor ?? '#000000'}
                  onChange={(e) => updatePlotMaterial(selected.id, { xContourColor: e.target.value })}
                />
              </label>
              <RangeField
                label="X contour spacing"
                min={0.1}
                max={5}
                step={0.1}
                value={selected.material.xContourSpacing ?? 1}
                onChange={(v) => updatePlotMaterial(selected.id, { xContourSpacing: clampContourSpacing(v) })}
              />
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function LightingTab({ selected }: { selected: PlotObject | PointLightObject | null }) {
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
              <RangeField
                label="Shadow map resolution"
                min={256}
                max={4096}
                step={256}
                value={scene.shadow.shadowMapResolution}
                onChange={(v) => updateScene({ shadow: { ...scene.shadow, shadowMapResolution: Math.round(v) } })}
              />
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

function SceneTab() {
  const scene = useAppStore((s) => s.scene);
  const updateScene = useAppStore((s) => s.updateScene);
  return (
    <div className="inspector-section">
      <h3>Scene</h3>
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
        <RangeField label="Axes Length" min={1} max={30} step={0.5} value={scene.axesLength} onChange={(v) => updateScene({ axesLength: v })} />
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
  return (
    <div className="control-grid">
      <RangeField label={`${firstAxisLabel} min`} min={-20} max={20} step={0.1} value={domain.uMin} onChange={(v) => updatePlotSpec(plot.id, (spec) => ((spec.kind === 'parametric_surface' || spec.kind === 'explicit_surface') ? { ...spec, domain: { ...spec.domain, uMin: v } } : spec))} />
      <RangeField label={`${firstAxisLabel} max`} min={-20} max={20} step={0.1} value={domain.uMax} onChange={(v) => updatePlotSpec(plot.id, (spec) => ((spec.kind === 'parametric_surface' || spec.kind === 'explicit_surface') ? { ...spec, domain: { ...spec.domain, uMax: v } } : spec))} />
      <RangeField label={`${secondAxisLabel} min`} min={-20} max={20} step={0.1} value={domain.vMin} onChange={(v) => updatePlotSpec(plot.id, (spec) => ((spec.kind === 'parametric_surface' || spec.kind === 'explicit_surface') ? { ...spec, domain: { ...spec.domain, vMin: v } } : spec))} />
      <RangeField label={`${secondAxisLabel} max`} min={-20} max={20} step={0.1} value={domain.vMax} onChange={(v) => updatePlotSpec(plot.id, (spec) => ((spec.kind === 'parametric_surface' || spec.kind === 'explicit_surface') ? { ...spec, domain: { ...spec.domain, vMax: v } } : spec))} />
      <RangeField label={`${firstAxisLabel} samples`} min={8} max={256} step={1} value={domain.uSamples} onChange={(v) => updatePlotSpec(plot.id, (spec) => ((spec.kind === 'parametric_surface' || spec.kind === 'explicit_surface') ? { ...spec, domain: { ...spec.domain, uSamples: Math.round(v) } } : spec))} />
      <RangeField label={`${secondAxisLabel} samples`} min={8} max={256} step={1} value={domain.vSamples} onChange={(v) => updatePlotSpec(plot.id, (spec) => ((spec.kind === 'parametric_surface' || spec.kind === 'explicit_surface') ? { ...spec, domain: { ...spec.domain, vSamples: Math.round(v) } } : spec))} />
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
  if (plot.equation.parameters.length === 0) {
    return null;
  }

  return (
    <div className="inspector-section">
      <h3>Constants</h3>
      {plot.equation.parameters.map((parameter) => (
        <RangeField
          key={parameter.name}
          label={parameter.name}
          min={parameter.min}
          max={parameter.max}
          step={parameter.step}
          value={parameter.value}
          onDragStart={() => beginEquationParameterDrag(plot.id, parameter.name)}
          onDragEnd={() => commitEquationParameterDrag(plot.id, parameter.name)}
          onChange={(value) =>
            updatePlotSpec(plot.id, (spec) => ({
              ...spec,
              parameters: updateEquationParameterValue(spec.parameters, parameter.name, value),
            }))
          }
        />
      ))}
    </div>
  );
}

function PointLightTabFields({ light }: { light: PointLightObject }) {
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
      <div className="control-grid control-grid--bounds">
        {(['x', 'y', 'z'] as const).map((axis) => (
          <label key={`${axis}-min`}>
            {axis} min
            <input type="number" step={0.1} value={targetBounds.min[axis]} onChange={(e) => setBounds(axis, 'min', Number(e.target.value))} />
          </label>
        ))}
        {(['x', 'y', 'z'] as const).map((axis) => (
          <label key={`${axis}-max`}>
            {axis} max
            <input type="number" step={0.1} value={targetBounds.max[axis]} onChange={(e) => setBounds(axis, 'max', Number(e.target.value))} />
          </label>
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
          <input type="number" step={0.1} value={value[axis]} onChange={(e) => onChange({ ...value, [axis]: Number(e.target.value) })} />
        </label>
      ))}
    </div>
  );
}

function RangeField({
  label,
  min,
  max,
  step,
  value,
  onChange,
  onDragStart,
  onDragEnd,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}) {
  return (
    <label className="range-field">
      <span>{label}</span>
      <div className="range-field__controls">
        <input
          type="range"
          min={min}
          max={max}
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
        <input type="number" min={min} max={max} step={step} value={Number.isFinite(value) ? value : 0} onChange={(e) => onChange(Number(e.target.value))} />
      </div>
    </label>
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
