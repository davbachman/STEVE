import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  LinesMesh,
  Matrix,
  Mesh,
  MeshBuilder,
  MirrorTexture,
  PBRMaterial,
  Plane,
  PointLight,
  PointerEventTypes,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexData,
  WebGPUEngine,
  type Nullable,
  type Observer,
  type PointerInfo,
} from '@babylonjs/core';
import { GridMaterial } from '@babylonjs/materials/grid';
import type { AppState } from '../state/store';
import { useAppStore } from '../state/store';
import type { PlotObject, PointLightObject } from '../types/contracts';
import { compilePlotObject } from '../math/compile';
import { buildImplicitMeshFromScalarField } from '../math/mesh/implicitMarchingTetra';
import { buildSurfaceMesh, sampleCurve } from '../math/mesh/parametric';

export interface ViewportApi {
  exportPng: (filename?: string) => Promise<void>;
}

interface PlotVisual {
  root: Mesh;
  wireframeLines: LinesMesh[];
  geometryKey: string;
}

interface PointLightVisual {
  light: PointLight;
  gizmo: Mesh;
  shadow: ShadowGenerator | null;
}

type DragState =
  | {
      objectId: string;
      mode: 'xy';
      startPosition: Vector3;
      planeZ: number;
      startPoint: Vector3;
    }
  | {
      objectId: string;
      mode: 'z';
      startPosition: Vector3;
      startClientY: number;
    };

export class SceneController {
  private engine: WebGPUEngine | null = null;
  private scene: Scene | null = null;
  private camera: ArcRotateCamera | null = null;
  private directionalLight: DirectionalLight | null = null;
  private directionalShadow: ShadowGenerator | null = null;
  private plotRoot = new TransformNode('plots-root');
  private lightRoot = new TransformNode('lights-root');
  private groundMesh: Mesh | null = null;
  private gridMesh: Mesh | null = null;
  private axesMeshes: LinesMesh[] = [];
  private groundMirror: MirrorTexture | null = null;
  private plotVisuals = new Map<string, PlotVisual>();
  private pointLightVisuals = new Map<string, PointLightVisual>();
  private pointerObserver: Nullable<Observer<PointerInfo>> = null;
  private dragState: DragState | null = null;
  private cameraDrag: { mode: 'orbit' | 'pan'; pointerId: number; lastX: number; lastY: number } | null = null;
  private qualityProgressCounter = 0;
  private lastQualitySignature = '';
  private meshHashCache = new Map<string, string>();

  constructor(private readonly canvas: HTMLCanvasElement) {}

  async init(): Promise<void> {
    if (!(navigator as Navigator & { gpu?: GPU }).gpu) {
      throw new Error('WebGPU is not available in this browser');
    }

    this.engine = new WebGPUEngine(this.canvas, {
      antialias: true,
      adaptToDeviceRatio: true,
      stencil: true,
    });
    await this.engine.initAsync();

    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0, 0, 0, 0);

    this.plotRoot = new TransformNode('plots-root', this.scene);
    this.lightRoot = new TransformNode('lights-root', this.scene);

    this.camera = new ArcRotateCamera('camera', -Math.PI / 3, 1.1, 20, new Vector3(0, 0, 1.5), this.scene);
    this.camera.upVector = new Vector3(0, 0, 1);
    this.camera.lowerRadiusLimit = 1;
    this.camera.upperRadiusLimit = 200;
    this.camera.wheelPrecision = 50;
    this.camera.attachControl(this.canvas, false);
    if (this.camera.inputs.attached.pointers) {
      const pointerInput = this.camera.inputs.attached.pointers as unknown as {
        buttons?: number[];
        panningMouseButton?: number;
      };
      pointerInput.buttons = [];
      pointerInput.panningMouseButton = -1;
    }

    this.directionalLight = new DirectionalLight('sun', new Vector3(-0.6, -0.4, -1).normalize(), this.scene);
    this.directionalLight.position = new Vector3(10, 10, 18);
    this.directionalShadow = new ShadowGenerator(2048, this.directionalLight);
    this.directionalShadow.usePercentageCloserFiltering = true;
    this.directionalShadow.bias = 0.001;
    this.directionalShadow.normalBias = 0.02;

    this.createGroundAndGrid();
    this.createAxes(6);
    this.attachInputHandlers();

    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    this.engine.runRenderLoop(() => {
      this.tickQualityCounter();
      this.scene?.render();
    });

    window.addEventListener('resize', this.handleResize);
  }

  dispose(): void {
    window.removeEventListener('resize', this.handleResize);
    this.pointerObserver && this.scene?.onPointerObservable.remove(this.pointerObserver);
    this.pointerObserver = null;
    this.groundMirror?.dispose();
    this.groundMirror = null;
    for (const visual of this.plotVisuals.values()) {
      visual.root.dispose(false, true);
      visual.wireframeLines.forEach((line) => line.dispose(false, true));
    }
    this.plotVisuals.clear();
    for (const visual of this.pointLightVisuals.values()) {
      visual.shadow?.dispose();
      visual.gizmo.dispose(false, true);
      visual.light.dispose();
    }
    this.pointLightVisuals.clear();
    this.axesMeshes.forEach((m) => m.dispose(false, true));
    this.axesMeshes = [];
    this.gridMesh?.dispose(false, true);
    this.groundMesh?.dispose(false, true);
    this.plotRoot.dispose();
    this.lightRoot.dispose();
    this.scene?.dispose();
    this.engine?.dispose();
    this.scene = null;
    this.engine = null;
  }

  getApi(): ViewportApi {
    return {
      exportPng: async (filename = '3dplot.png') => {
        if (!this.canvas) return;
        await exportCanvasPng(this.canvas, filename);
      },
    };
  }

  sync(state: Pick<AppState, 'scene' | 'render' | 'objects' | 'selectedId'>): void {
    if (!this.scene || !this.camera || !this.directionalLight) {
      return;
    }

    this.syncSceneSettings(state);
    this.syncLights(state);
    this.syncPlots(state);
    this.syncSelection(state.selectedId);

    const sceneSignature = JSON.stringify({
      objects: state.objects,
      scene: state.scene,
      render: state.render.mode,
    });
    if (sceneSignature !== this.lastQualitySignature) {
      this.qualityProgressCounter = 0;
      this.lastQualitySignature = sceneSignature;
    }
  }

  private syncSceneSettings(state: Pick<AppState, 'scene' | 'render'>): void {
    if (!this.scene || !this.directionalLight || !this.groundMesh || !this.gridMesh) {
      return;
    }

    this.directionalLight.diffuse = color3(state.scene.directional.color);
    this.directionalLight.specular = color3(state.scene.directional.color);
    this.directionalLight.intensity = state.scene.directional.intensity;
    this.directionalLight.setDirectionToTarget(
      new Vector3(
        -state.scene.directional.direction.x,
        -state.scene.directional.direction.y,
        -state.scene.directional.direction.z,
      ),
    );
    this.directionalLight.setEnabled(state.scene.directional.castShadows || state.scene.directional.intensity > 0);

    const clear = state.scene.backgroundMode === 'solid' ? state.scene.backgroundColor : state.scene.gradientBottomColor;
    this.scene.clearColor = Color4.FromColor3(color3(clear), 0);
    this.canvas.style.background =
      state.scene.backgroundMode === 'solid'
        ? state.scene.backgroundColor
        : `linear-gradient(${state.scene.gradientTopColor}, ${state.scene.gradientBottomColor})`;

    this.groundMesh.isVisible = state.scene.groundPlaneVisible;
    this.groundMesh.scaling = new Vector3(state.scene.groundPlaneSize, state.scene.groundPlaneSize, 1);
    this.gridMesh.isVisible = state.scene.gridVisible;
    this.gridMesh.scaling = new Vector3(state.scene.gridExtent, state.scene.gridExtent, 1);

    const groundMaterial = this.groundMesh.material;
    if (groundMaterial instanceof PBRMaterial) {
      groundMaterial.albedoColor = color3(state.scene.groundPlaneColor);
      groundMaterial.roughness = clamp01(state.scene.groundPlaneRoughness);
      groundMaterial.metallic = state.scene.groundPlaneReflective ? 0.05 : 0;
      groundMaterial.reflectionTexture = state.scene.groundPlaneReflective ? this.groundMirror : null;
      groundMaterial.reflectionTexture && (groundMaterial.reflectionTexture.level = state.scene.groundPlaneReflective ? 0.6 : 0);
    }

    const gridMaterial = this.gridMesh.material;
    if (gridMaterial instanceof GridMaterial) {
      gridMaterial.mainColor = color3(state.scene.groundPlaneColor);
      gridMaterial.lineColor = new Color3(0.15, 0.2, 0.3);
      gridMaterial.gridRatio = Math.max(0.05, state.scene.gridSpacing);
      gridMaterial.opacity = clamp01(state.scene.gridLineOpacity);
      gridMaterial.majorUnitFrequency = 5;
      gridMaterial.minorUnitVisibility = 0.3;
    }

    const axesVisible = state.scene.axesVisible;
    if (this.axesMeshes.length === 0 || Math.abs(this.axesMeshes[0].getBoundingInfo().boundingBox.extendSize.x - state.scene.axesLength / 2) > 1e-6) {
      this.createAxes(state.scene.axesLength);
    }
    this.axesMeshes.forEach((m) => {
      m.isVisible = axesVisible;
    });
  }

  private syncLights(state: Pick<AppState, 'scene' | 'objects'>): void {
    if (!this.scene || !this.directionalShadow) return;

    const pointLights = state.objects.filter((o): o is PointLightObject => o.type === 'point_light');
    const seen = new Set<string>();

    pointLights.forEach((lightObj, index) => {
      seen.add(lightObj.id);
      let visual = this.pointLightVisuals.get(lightObj.id);
      if (!visual) {
        const light = new PointLight(`point-${lightObj.id}`, vec3(lightObj.position), this.scene!);
        const gizmo = MeshBuilder.CreateSphere(`gizmo-${lightObj.id}`, { diameter: 0.25 }, this.scene!);
        gizmo.parent = this.lightRoot;
        gizmo.metadata = { selectableId: lightObj.id, selectableType: 'point_light' };
        gizmo.isPickable = true;
        const mat = new StandardMaterial(`gizmo-mat-${lightObj.id}`, this.scene!);
        mat.emissiveColor = new Color3(1, 0.8, 0.4);
        mat.disableLighting = true;
        gizmo.material = mat;
        let shadow: ShadowGenerator | null = null;
        if (index < 2) {
          shadow = new ShadowGenerator(1024, light);
          shadow.usePercentageCloserFiltering = true;
          shadow.bias = 0.001;
          shadow.normalBias = 0.02;
        }
        visual = { light, gizmo, shadow };
        this.pointLightVisuals.set(lightObj.id, visual);
      }

      visual.light.setEnabled(lightObj.visible);
      visual.gizmo.isVisible = lightObj.visible;
      visual.light.position.copyFrom(vec3(lightObj.position));
      visual.gizmo.position.copyFrom(vec3(lightObj.position));
      visual.light.diffuse = color3(lightObj.color);
      visual.light.specular = color3(lightObj.color);
      visual.light.intensity = lightObj.intensity;
      visual.light.range = lightObj.range;
      if (visual.shadow) {
        visual.shadow.getShadowMap()?.renderList?.length;
      }
    });

    for (const [id, visual] of this.pointLightVisuals.entries()) {
      if (!seen.has(id)) {
        visual.shadow?.dispose();
        visual.gizmo.dispose(false, true);
        visual.light.dispose();
        this.pointLightVisuals.delete(id);
      }
    }
  }

  private syncPlots(state: Pick<AppState, 'scene' | 'objects'>): void {
    if (!this.scene || !this.directionalShadow) return;
    const plots = state.objects.filter((obj): obj is PlotObject => obj.type === 'plot');
    const seen = new Set<string>();

    for (const plot of plots) {
      seen.add(plot.id);
      const geometryKey = buildGeometryKey(plot);
      const oldHash = this.meshHashCache.get(plot.id);

      let visual = this.plotVisuals.get(plot.id);
      if (!visual || oldHash !== geometryKey) {
        visual?.wireframeLines.forEach((line) => line.dispose(false, true));
        visual?.root.dispose(false, true);
        try {
          visual = this.buildPlotVisual(plot);
          this.plotVisuals.set(plot.id, visual);
          this.meshHashCache.set(plot.id, geometryKey);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Plot compile error';
          useAppStore.getState().setStatusMessage(message);
          continue;
        }
      }

      visual.root.parent = this.plotRoot;
      visual.root.isVisible = plot.visible;
      visual.root.position.copyFrom(vec3(plot.transform.position));
      visual.root.receiveShadows = true;
      this.applyPlotMaterial(plot, visual.root);
      this.directionalShadow.addShadowCaster(visual.root, true);
      for (const pointLight of this.pointLightVisuals.values()) {
        pointLight.shadow?.addShadowCaster(visual.root, true);
      }
      for (const wire of visual.wireframeLines) {
        wire.isVisible = plot.visible && Boolean(plot.material.wireframeVisible);
        wire.position.copyFrom(vec3(plot.transform.position));
      }
    }

    for (const [id, visual] of this.plotVisuals.entries()) {
      if (!seen.has(id)) {
        visual.wireframeLines.forEach((line) => line.dispose(false, true));
        visual.root.dispose(false, true);
        this.plotVisuals.delete(id);
        this.meshHashCache.delete(id);
      }
    }

    if (this.groundMirror) {
      this.groundMirror.renderList = [...this.plotVisuals.values()].map((visual) => visual.root);
    }
  }

  private buildPlotVisual(plot: PlotObject): PlotVisual {
    if (!this.scene) {
      throw new Error('Scene not initialized');
    }

    const compiled = compilePlotObject(plot);

    let root: Mesh;
    const wireframeLines: LinesMesh[] = [];

    if (compiled.kind === 'curve') {
      const sample = sampleCurve(
        compiled.spec.tDomain.min,
        compiled.spec.tDomain.max,
        compiled.spec.tDomain.samples,
        (t) => compiled.fn(t),
      );
      const path = sample.points.map((p) => new Vector3(p.x, p.y, p.z));
      if (compiled.spec.renderAsTube) {
        root = MeshBuilder.CreateTube(`plot-${plot.id}`, {
          path,
          radius: compiled.spec.tubeRadius,
          tessellation: 12,
          cap: Mesh.CAP_ALL,
        }, this.scene);
      } else {
        root = MeshBuilder.CreateLines(`plot-${plot.id}`, { points: path, updatable: false }, this.scene) as unknown as Mesh;
      }
    } else if (compiled.kind === 'surface') {
      const meshData = buildSurfaceMesh(
        compiled.spec.domain,
        (u, v) => compiled.fn(u, v),
        plot.material.wireframeCellSize ?? 4,
      );
      root = new Mesh(`plot-${plot.id}`, this.scene);
      const vd = new VertexData();
      vd.positions = Array.from(meshData.positions);
      vd.indices = Array.from(meshData.indices);
      if (meshData.normals) {
        vd.normals = Array.from(meshData.normals);
      }
      if (meshData.uvs) {
        vd.uvs = Array.from(meshData.uvs);
      }
      vd.applyToMesh(root);

      if (meshData.lines) {
        meshData.lines.forEach((coords, idx) => {
          const points: Vector3[] = [];
          for (let i = 0; i < coords.length; i += 3) {
            const x = coords[i];
            const y = coords[i + 1];
            const z = coords[i + 2];
            if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
              points.push(new Vector3(x, y, z));
            }
          }
          if (points.length >= 2) {
            const line = MeshBuilder.CreateLines(`plot-${plot.id}-wire-${idx}`, { points }, this.scene);
            line.color = Color3.FromHexString('#0f172a');
            line.parent = this.plotRoot;
            line.isPickable = false;
            wireframeLines.push(line);
          }
        });
      }
    } else {
      const meshData = buildImplicitMeshFromScalarField(
        compiled.spec.bounds,
        (x, y, z) => compiled.fn(x, y, z),
        compiled.spec.quality,
        compiled.spec.isoValue,
      );
      root = new Mesh(`plot-${plot.id}`, this.scene);
      const vd = new VertexData();
      vd.positions = Array.from(meshData.positions);
      vd.indices = Array.from(meshData.indices);
      if (meshData.normals) {
        vd.normals = Array.from(meshData.normals);
      }
      vd.applyToMesh(root);
    }

    root.metadata = { selectableId: plot.id, selectableType: 'plot' };
    root.isPickable = true;
    root.parent = this.plotRoot;
    root.receiveShadows = true;
    root.renderOverlay = false;

    return { root, wireframeLines, geometryKey: buildGeometryKey(plot) };
  }

  private applyPlotMaterial(plot: PlotObject, mesh: Mesh): void {
    if (!this.scene) return;
    let material = mesh.material;
    if (!(material instanceof PBRMaterial)) {
      material = new PBRMaterial(`mat-${plot.id}`, this.scene);
      mesh.material = material;
    }
    const pbr = material as PBRMaterial;
    pbr.albedoColor = color3(plot.material.baseColor);
    pbr.metallic = clamp01(plot.material.reflectiveness);
    pbr.roughness = clamp01(plot.material.roughness);
    pbr.alpha = clamp01(plot.material.opacity);
    pbr.transparencyMode = plot.material.opacity < 1 ? PBRMaterial.PBRMATERIAL_ALPHABLEND : PBRMaterial.PBRMATERIAL_OPAQUE;
    pbr.indexOfRefraction = Math.max(1, plot.material.ior);
    pbr.subSurface.isRefractionEnabled = plot.material.transmission > 0.05;
    pbr.subSurface.refractionIntensity = clamp01(plot.material.transmission);
    pbr.subSurface.indexOfRefraction = Math.max(1, plot.material.ior);
    pbr.separateCullingPass = plot.material.opacity < 0.95;
    pbr.backFaceCulling = false;
    pbr.environmentIntensity = 0.9;
  }

  private syncSelection(selectedId: string | null): void {
    for (const [id, visual] of this.plotVisuals.entries()) {
      visual.root.renderOverlay = id === selectedId;
      visual.root.overlayColor = id === selectedId ? new Color3(0.98, 0.78, 0.18) : new Color3(0, 0, 0);
      visual.root.overlayAlpha = id === selectedId ? 0.22 : 0;
    }
    for (const [id, visual] of this.pointLightVisuals.entries()) {
      const mat = visual.gizmo.material as StandardMaterial | null;
      if (mat) {
        mat.emissiveColor = id === selectedId ? new Color3(1, 0.95, 0.3) : new Color3(1, 0.75, 0.35);
      }
      visual.gizmo.scaling.setAll(id === selectedId ? 1.4 : 1);
    }
  }

  private createGroundAndGrid(): void {
    if (!this.scene) return;

    this.groundMesh?.dispose(false, true);
    this.gridMesh?.dispose(false, true);

    this.groundMesh = MeshBuilder.CreateGround('ground', { width: 1, height: 1, subdivisions: 1 }, this.scene);
    this.groundMesh.position.z = 0;
    this.groundMesh.rotationQuaternion = null;
    this.groundMesh.rotation = new Vector3(0, 0, 0);
    const groundMaterial = new PBRMaterial('ground-pbr', this.scene);
    groundMaterial.albedoColor = new Color3(0.95, 0.93, 0.9);
    groundMaterial.roughness = 0.35;
    groundMaterial.metallic = 0.02;
    groundMaterial.backFaceCulling = false;
    groundMaterial.alpha = 1;
    this.groundMesh.material = groundMaterial;
    this.groundMesh.receiveShadows = true;

    this.gridMesh = MeshBuilder.CreateGround('grid', { width: 1, height: 1, subdivisions: 1 }, this.scene);
    this.gridMesh.position.z = 0.002;
    const gridMaterial = new GridMaterial('grid-mat', this.scene);
    gridMaterial.backFaceCulling = false;
    gridMaterial.majorUnitFrequency = 5;
    gridMaterial.minorUnitVisibility = 0.3;
    gridMaterial.gridRatio = 1;
    gridMaterial.opacity = 0.25;
    this.gridMesh.material = gridMaterial;
    this.gridMesh.isPickable = false;

    this.groundMirror?.dispose();
    this.groundMirror = new MirrorTexture('ground-mirror', 1024, this.scene, true);
    this.groundMirror.mirrorPlane = new Plane(0, 0, -1, 0.001);
    this.groundMirror.renderList = [];
    groundMaterial.reflectionTexture = this.groundMirror;
    groundMaterial.reflectionTexture.level = 0.5;
  }

  private createAxes(length: number): void {
    if (!this.scene) return;
    this.axesMeshes.forEach((m) => m.dispose(false, true));
    this.axesMeshes = [];

    const x = MeshBuilder.CreateLines('axis-x', { points: [new Vector3(0, 0, 0), new Vector3(length, 0, 0)] }, this.scene);
    x.color = Color3.FromHexString('#ef4444');
    x.isPickable = false;
    const y = MeshBuilder.CreateLines('axis-y', { points: [new Vector3(0, 0, 0), new Vector3(0, length, 0)] }, this.scene);
    y.color = Color3.FromHexString('#22c55e');
    y.isPickable = false;
    const z = MeshBuilder.CreateLines('axis-z', { points: [new Vector3(0, 0, 0), new Vector3(0, 0, length)] }, this.scene);
    z.color = Color3.FromHexString('#3b82f6');
    z.isPickable = false;

    this.axesMeshes = [x, y, z];
  }

  private attachInputHandlers(): void {
    if (!this.scene || !this.camera) return;

    this.pointerObserver = this.scene.onPointerObservable.add((pointerInfo) => {
      const event = pointerInfo.event as PointerEvent;
      switch (pointerInfo.type) {
        case PointerEventTypes.POINTERDOWN:
          this.handlePointerDown(event);
          break;
        case PointerEventTypes.POINTERUP:
          this.handlePointerUp(event);
          break;
        case PointerEventTypes.POINTERMOVE:
          this.handlePointerMove(event);
          break;
        default:
          break;
      }
    });

    this.canvas.addEventListener('wheel', (event) => {
      if (!this.camera) return;
      event.preventDefault();
      this.camera.radius *= Math.exp(event.deltaY * 0.0015);
      this.camera.radius = Math.max(this.camera.lowerRadiusLimit ?? 1, Math.min(this.camera.upperRadiusLimit ?? 200, this.camera.radius));
    }, { passive: false });
  }

  private handlePointerDown(event: PointerEvent): void {
    if (!this.scene || !this.camera) return;
    if (event.button === 2) {
      this.cameraDrag = {
        mode: event.shiftKey ? 'pan' : 'orbit',
        pointerId: event.pointerId,
        lastX: event.clientX,
        lastY: event.clientY,
      };
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }

    if (event.button !== 0) {
      return;
    }

    const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (mesh) => !!mesh.metadata?.selectableId);
    const selectableId = pick?.pickedMesh?.metadata?.selectableId as string | undefined;
    if (!selectableId) {
      useAppStore.getState().selectObject(null);
      return;
    }

    useAppStore.getState().selectObject(selectableId);

    if (!pick.pickedPoint) {
      return;
    }

    const selected = useAppStore.getState().objects.find((obj) => obj.id === selectableId);
    if (!selected) return;

    const startPosition = selected.type === 'plot' ? vec3(selected.transform.position) : vec3(selected.position);
    if (event.shiftKey) {
      this.dragState = {
        objectId: selectableId,
        mode: 'z',
        startPosition,
        startClientY: event.clientY,
      };
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }

    const hit = rayPlaneIntersectZ(this.scene.createPickingRay(this.scene.pointerX, this.scene.pointerY, Matrix.Identity(), this.camera), startPosition.z);
    if (!hit) {
      return;
    }

    this.dragState = {
      objectId: selectableId,
      mode: 'xy',
      startPosition,
      planeZ: startPosition.z,
      startPoint: hit,
    };
    this.canvas.setPointerCapture(event.pointerId);
  }

  private handlePointerUp(event: PointerEvent): void {
    if (this.cameraDrag && this.cameraDrag.pointerId === event.pointerId) {
      this.cameraDrag = null;
      this.canvas.releasePointerCapture(event.pointerId);
    }
    if (this.dragState) {
      this.dragState = null;
      this.canvas.releasePointerCapture(event.pointerId);
    }
  }

  private handlePointerMove(event: PointerEvent): void {
    if (!this.scene || !this.camera) return;

    if (this.cameraDrag && this.cameraDrag.pointerId === event.pointerId) {
      const dx = event.clientX - this.cameraDrag.lastX;
      const dy = event.clientY - this.cameraDrag.lastY;
      this.cameraDrag.lastX = event.clientX;
      this.cameraDrag.lastY = event.clientY;

      if (this.cameraDrag.mode === 'orbit') {
        this.camera.alpha -= dx * 0.01;
        this.camera.beta = clamp(this.camera.beta + dy * 0.01, 0.1, Math.PI - 0.1);
      } else {
        const panScale = this.camera.radius * 0.002;
        const right = this.camera.getDirection(new Vector3(1, 0, 0));
        const up = this.camera.getDirection(new Vector3(0, 0, 1));
        this.camera.target.addInPlace(right.scale(-dx * panScale));
        this.camera.target.addInPlace(up.scale(dy * panScale));
      }
      return;
    }

    if (!this.dragState) return;

    const current = useAppStore.getState().objects.find((obj) => obj.id === this.dragState?.objectId);
    if (!current) return;

    if (this.dragState.mode === 'xy') {
      const ray = this.scene.createPickingRay(this.scene.pointerX, this.scene.pointerY, Matrix.Identity(), this.camera);
      const hit = rayPlaneIntersectZ(ray, this.dragState.planeZ);
      if (!hit) return;
      const delta = hit.subtract(this.dragState.startPoint);
      const pos = this.dragState.startPosition.add(delta);
      useAppStore.getState().setObjectPosition(current.id, { x: pos.x, y: pos.y, z: pos.z });
    } else {
      const dy = event.clientY - this.dragState.startClientY;
      const dz = -dy * this.camera.radius * 0.005;
      const pos = this.dragState.startPosition.clone();
      pos.z += dz;
      useAppStore.getState().setObjectPosition(current.id, { x: pos.x, y: pos.y, z: pos.z });
    }
  }

  private tickQualityCounter(): void {
    const { render, markQualityProgress } = useAppStore.getState();
    if (render.mode !== 'quality') {
      if (render.qualityCurrentSamples !== 0 || render.qualityRunning) {
        markQualityProgress(0, false);
      }
      return;
    }
    if (this.qualityProgressCounter >= render.qualitySamplesTarget) {
      markQualityProgress(this.qualityProgressCounter, false);
      return;
    }
    this.qualityProgressCounter += 1;
    markQualityProgress(this.qualityProgressCounter, true);
  }

  private readonly handleResize = () => {
    this.engine?.resize();
  };
}

function buildGeometryKey(plot: PlotObject): string {
  return JSON.stringify({ equation: plot.equation, materialWireframe: { v: plot.material.wireframeVisible, c: plot.material.wireframeCellSize } });
}

function color3(hex: string): Color3 {
  try {
    return Color3.FromHexString(hex);
  } catch {
    return Color3.White();
  }
}

function vec3(v: { x: number; y: number; z: number }): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function rayPlaneIntersectZ(ray: { origin: Vector3; direction: Vector3 }, z: number): Vector3 | null {
  const dz = ray.direction.z;
  if (Math.abs(dz) < 1e-6) return null;
  const t = (z - ray.origin.z) / dz;
  if (t < 0) return null;
  return ray.origin.add(ray.direction.scale(t));
}

async function exportCanvasPng(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) {
    throw new Error('Failed to export PNG');
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
