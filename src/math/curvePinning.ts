import type {
  DirectionalLightObject,
  LightObject,
  PlotObject,
  SceneObject,
  Vec3,
} from '../types/contracts';
import { isParametricCurvePlot } from '../types/guards';
import { compileEquationSpec, type CompiledCurve } from './compile';

export type CurveTraversalMode = 'bounce' | 'wrap';

const CLOSED_ENDPOINT_EPSILON = 1e-5;
const compiledCurveCache = new WeakMap<
  PlotObject['equation'],
  { signature: string; compiled: CompiledCurve }
>();

function compiledCurve(curve: PlotObject): CompiledCurve | null {
  if (!isParametricCurvePlot(curve) || curve.equation.source.parseStatus !== 'ok') return null;
  const signature = [
    curve.equation.source.rawText,
    ...curve.equation.parameters.map((parameter) => `${parameter.name}:${parameter.value}`),
  ].join('|');
  const cached = compiledCurveCache.get(curve.equation);
  if (cached?.signature === signature) return cached.compiled;
  try {
    const compiled = compileEquationSpec(curve.equation);
    if (compiled.kind !== 'curve') return null;
    compiledCurveCache.set(curve.equation, { signature, compiled });
    return compiled;
  } catch {
    return null;
  }
}

export function curveParameterBounds(curve: PlotObject): { min: number; max: number } | null {
  if (!isParametricCurvePlot(curve)) return null;
  const { min, max } = curve.equation.tDomain;
  return Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, max } : null;
}

export function clampCurveParameter(curve: PlotObject, value: number): number | null {
  const bounds = curveParameterBounds(curve);
  if (!bounds) return null;
  const safeValue = Number.isFinite(value) ? value : bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, safeValue));
}

export function evaluateCurveWorldPosition(curve: PlotObject, parameterValue: number): Vec3 | null {
  const evaluator = compiledCurve(curve);
  const value = clampCurveParameter(curve, parameterValue);
  if (!evaluator || value === null) return null;
  try {
    const [x, y, z] = evaluator.fn(value);
    if (![x, y, z].every(Number.isFinite)) return null;
    return {
      x: x + curve.transform.position.x,
      y: y + curve.transform.position.y,
      z: z + curve.transform.position.z,
    };
  } catch {
    return null;
  }
}

export function curveTraversalMode(curve: PlotObject): CurveTraversalMode {
  const bounds = curveParameterBounds(curve);
  if (!bounds) return 'bounce';
  const start = evaluateCurveWorldPosition(curve, bounds.min);
  const end = evaluateCurveWorldPosition(curve, bounds.max);
  if (!start || !end) return 'bounce';
  const distance = Math.hypot(start.x - end.x, start.y - end.y, start.z - end.z);
  return distance <= CLOSED_ENDPOINT_EPSILON ? 'wrap' : 'bounce';
}

export function pinnedCurveForLight(light: LightObject, objects: ReadonlyArray<SceneObject>): PlotObject | null {
  if (!light.curvePin.enabled || !light.curvePin.curveId) return null;
  const curve = objects.find((object) => object.id === light.curvePin.curveId);
  return isParametricCurvePlot(curve) ? curve : null;
}

export function resolvePinnedLightPosition(light: LightObject, objects: ReadonlyArray<SceneObject>): Vec3 | null {
  const curve = pinnedCurveForLight(light, objects);
  return curve ? evaluateCurveWorldPosition(curve, light.curvePin.parameterValue) : null;
}

export function resolvePinnedLight(light: LightObject, objects: ReadonlyArray<SceneObject>): LightObject {
  const position = resolvePinnedLightPosition(light, objects);
  if (!position) return light;
  if (light.type === 'point_light') return { ...light, position };
  return {
    ...light,
    position,
    direction: directionTowardOrigin(position),
  } satisfies DirectionalLightObject;
}

function directionTowardOrigin(position: Vec3): Vec3 {
  const length = Math.hypot(position.x, position.y, position.z);
  if (!Number.isFinite(length) || length < 1e-6) return { x: 0, y: 0, z: -1 };
  return { x: -position.x / length, y: -position.y / length, z: -position.z / length };
}
