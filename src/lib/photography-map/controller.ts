import * as Cesium from "cesium";
import { frustumOrientationFromCamera } from "./cesium-orientation";
import { containAwareFov } from "./math";
import { nextSimplerTier } from "./tiers";
import {
  resolvePosition,
  type CitySceneConfig,
  type GeoPosition,
  type PhotoSceneRecord,
  type RenderingTier,
} from "./types";

declare const CESIUM_BASE_URL: string;

type ControllerOptions = {
  googleKey?: string;
  ionToken?: string;
  mobile?: boolean;
  onPhotoSelected?: (id: string) => void;
  onStatus?: (message: string) => void;
  onTierChanged?: (tier: RenderingTier) => void;
  allowTierFallback?: boolean;
  onFatalError?: (error: unknown) => void;
};

function describeError(error: unknown) {
  if (!(error instanceof Object)) return String(error);
  const detail = error as {
    message?: string;
    name?: string;
    response?: unknown;
    statusCode?: number;
  };
  const response =
    typeof detail.response === "string"
      ? detail.response.slice(0, 300)
      : detail.response;
  return JSON.stringify({
    name: detail.name ?? error.constructor.name,
    message: detail.message,
    statusCode: detail.statusCode,
    response,
  });
}

export class CesiumSceneController {
  private widget: Cesium.CesiumWidget;
  private city?: CitySceneConfig;
  private photos: PhotoSceneRecord[] = [];
  private selected?: PhotoSceneRecord;
  private tier: RenderingTier = "terrain";
  private tileset?: Cesium.Cesium3DTileset;
  private frustumPrimitives: Cesium.Primitive[] = [];
  private shader?: Cesium.CustomShader;
  private handler: Cesium.ScreenSpaceEventHandler;
  private resizeObserver: ResizeObserver;
  private removeRenderErrorListener?: () => void;
  private removeTileFailureListener?: () => void;
  private tileFailures: number[] = [];
  private handlingRenderFailure = false;
  private destroyed = false;
  private providerLoadId = 0;
  private cityLoadId = 0;
  private alignedPhoto?: PhotoSceneRecord;

  constructor(
    private container: HTMLElement,
    private options: ControllerOptions,
  ) {
    if (!document.querySelector("link[data-cesium-widgets]")) {
      const stylesheet = document.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href = `${CESIUM_BASE_URL}/Widgets/widgets.css`;
      stylesheet.dataset.cesiumWidgets = "true";
      document.head.append(stylesheet);
    }
    if (options.ionToken) Cesium.Ion.defaultAccessToken = options.ionToken;
    this.widget = new Cesium.CesiumWidget(this.container, {
      baseLayer: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      scene3DOnly: true,
      requestRenderMode: true,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
      targetFrameRate: options.mobile ? 30 : 60,
      showRenderLoopErrors: false,
    });
    this.widget.resolutionScale = Math.min(
      window.devicePixelRatio || 1,
      options.mobile ? 1 : 1.25,
    );
    this.widget.scene.globe.baseColor =
      Cesium.Color.fromCssColorString("#111612");
    this.widget.scene.backgroundColor =
      Cesium.Color.fromCssColorString("#090b09");
    this.widget.scene.fog.enabled = true;
    const controls = this.widget.scene.screenSpaceCameraController;
    controls.inertiaSpin = 0.82;
    controls.inertiaTranslate = 0.82;
    controls.inertiaZoom = 0.72;
    controls.bounceAnimationTime = 0.8;
    controls.minimumZoomDistance = 2;
    this.handler = new Cesium.ScreenSpaceEventHandler(this.widget.scene.canvas);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.removeRenderErrorListener =
      this.widget.scene.renderError.addEventListener((_scene, error) => {
        void this.handleRenderFailure(error);
      });
    this.resize();
    this.handler.setInputAction(
      (movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
        const picked = this.widget.scene.pick(movement.position) as
          { id?: Cesium.Entity } | undefined;
        const entityId = picked?.id?.id;
        if (typeof entityId === "string" && entityId.startsWith("photo:")) {
          const id = entityId.slice(6);
          this.options.onPhotoSelected?.(id);
        }
      },
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );
  }

  async loadCity(
    city: CitySceneConfig,
    photos: PhotoSceneRecord[],
    tier: RenderingTier,
  ) {
    if (this.destroyed) return;
    const cityLoadId = ++this.cityLoadId;
    this.city = city;
    this.photos = [...photos];
    await this.setTier(tier);
    if (this.destroyed || cityLoadId !== this.cityLoadId) return;
    this.addMarkers();
    this.flyToCity();
  }

  async setTier(tier: RenderingTier) {
    if (this.destroyed) return;
    const loadId = ++this.providerLoadId;
    this.clearProvider();
    this.tier = tier;
    this.options.onStatus?.(`Loading ${tier.replace("-", " ")}…`);
    try {
      const loading =
        tier === "photorealistic"
          ? this.loadPhotorealistic(loadId)
          : tier === "osm-buildings"
            ? this.loadOsmBuildings(loadId)
            : tier === "terrain"
              ? this.loadTerrain(loadId)
              : tier === "marker"
                ? this.loadBasicMap(loadId)
                : Promise.resolve();
      await this.withTimeout(loading, 20_000);
      if (!this.isCurrentProvider(loadId)) return;
      if (tier === "gallery")
        this.options.onStatus?.(
          "3D providers unavailable; the standard gallery remains available.",
        );
      this.options.onTierChanged?.(tier);
      if (tier !== "gallery")
        this.options.onStatus?.(`${tier.replace("-", " ")} ready`);
      this.widget.scene.requestRender();
    } catch (error) {
      if (!this.isCurrentProvider(loadId)) return;
      // A timed-out provider can still resolve. Invalidate it before fallback.
      this.providerLoadId += 1;
      this.clearProvider();
      if (this.options.allowTierFallback === false) {
        this.options.onStatus?.(
          `${tier.replace("-", " ")} failed. Returning to the satellite map.`,
        );
        throw error;
      }
      this.options.onStatus?.(
        `${tier.replace("-", " ")} failed; using a simpler view.`,
      );
      const fallback = nextSimplerTier(tier);
      if (fallback !== tier) await this.setTier(fallback);
      else throw error;
    }
  }

  selectPhoto(photoId: string) {
    if (this.destroyed) return;
    const photo = this.photos.find((candidate) => candidate.id === photoId);
    if (!photo) return;
    this.selected = photo;
    this.leavePhotoView();
    this.hideFrustum();
    if (photo.capabilities.marker) this.focusOnPhoto(photo);
  }

  updatePhoto(photo: PhotoSceneRecord) {
    if (this.destroyed) return;
    const index = this.photos.findIndex(
      (candidate) => candidate.id === photo.id,
    );
    if (index >= 0) this.photos[index] = photo;
    else this.photos.push(photo);
    this.selected = photo;
    this.addMarkers();
    this.hideFrustum();
  }

  replacePhotos(photos: PhotoSceneRecord[]) {
    if (this.destroyed) return;
    this.leavePhotoView();
    const selectedId = this.selected?.id;
    this.photos = [...photos];
    this.selected = selectedId
      ? photos.find((photo) => photo.id === selectedId)
      : undefined;
    this.hideFrustum();
    this.addMarkers();
    this.widget.scene.requestRender();
  }

  showFrustum(photoId = this.selected?.id) {
    if (this.destroyed) return;
    const photo = this.photos.find((candidate) => candidate.id === photoId);
    this.clearFrustum();
    this.clearHighlight();
    if (!photo?.capabilities.frustum) return;
    this.leavePhotoView();
    this.focusOnPhoto(photo);
    const position = resolvePosition(photo);
    const origin = Cesium.Cartesian3.fromDegrees(
      position.longitude,
      position.latitude,
      position.altitudeM,
    );
    const orientation = this.getPhotoOrientation(photo, origin);
    const aspectRatio = photo.image.width / photo.image.height;
    const rejected = photo.pose.calibration === "rejected";
    const frustum = new Cesium.PerspectiveFrustum({
      fov: Cesium.Math.toRadians(
        aspectRatio >= 1
          ? photo.optics.horizontalFovDeg
          : photo.optics.verticalFovDeg,
      ),
      aspectRatio,
      near: photo.frustum.nearM,
      far: photo.frustum.farM,
    });
    const fill = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.FrustumGeometry({ frustum, origin, orientation }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromCssColorString(
              rejected ? "#ff3d22" : "#ff7656",
            ).withAlpha(rejected ? 0.2 : 0.12),
          ),
        },
      }),
      appearance: new Cesium.PerInstanceColorAppearance({
        translucent: true,
        closed: true,
      }),
      asynchronous: false,
    });
    const outline = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.FrustumOutlineGeometry({
          frustum,
          origin,
          orientation,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromCssColorString(
              rejected ? "#ff7656" : "#ffd15c",
            ).withAlpha(0.9),
          ),
        },
      }),
      appearance: new Cesium.PerInstanceColorAppearance({
        flat: true,
        translucent: true,
      }),
      asynchronous: false,
    });
    this.widget.scene.primitives.add(fill);
    this.widget.scene.primitives.add(outline);
    this.frustumPrimitives = [fill, outline];
    this.applyHighlight(photo);
    this.widget.scene.requestRender();
  }

  hideFrustum() {
    if (this.destroyed) return;
    this.clearFrustum();
    this.clearHighlight();
    this.widget.scene.requestRender();
  }

  alignToPhoto(photoId = this.selected?.id, duration = 900) {
    if (this.destroyed) return;
    const photo = this.photos.find((candidate) => candidate.id === photoId);
    if (!photo?.capabilities.comparison) return;
    this.hideFrustum();
    this.alignedPhoto = photo;
    // Do not let terrain collision handling move a published camera pose.
    this.widget.scene.screenSpaceCameraController.enableCollisionDetection = false;
    const position = resolvePosition(photo);
    const destination = Cesium.Cartesian3.fromDegrees(
      position.longitude,
      position.latitude,
      position.altitudeM,
    );
    const orientation = {
      heading: Cesium.Math.toRadians(photo.pose.headingDeg ?? 0),
      pitch: Cesium.Math.toRadians(photo.pose.pitchDeg ?? 0),
      roll: Cesium.Math.toRadians(photo.pose.rollDeg ?? 0),
    };
    this.fitPhotoFrustum(photo);
    this.widget.camera.cancelFlight();
    if (duration <= 0) this.widget.camera.setView({ destination, orientation });
    else
      this.widget.camera.flyTo({
        destination,
        orientation,
        duration: duration / 1_000,
      });
    this.widget.scene.requestRender();
  }

  setComparisonLocked(locked: boolean) {
    if (this.destroyed) return;
    this.widget.scene.screenSpaceCameraController.enableInputs = !locked;
  }

  resetView() {
    if (this.destroyed) return;
    this.hideFrustum();
    this.leavePhotoView();
    this.flyToCity();
  }

  enterPhoto(photoId = this.selected?.id, duration = 900) {
    const photo = this.photos.find((candidate) => candidate.id === photoId);
    if (!photo?.capabilities.comparison) return;
    this.alignToPhoto(photoId, duration);
  }

  pickWorldPosition(clientX: number, clientY: number): GeoPosition | undefined {
    const canvas = this.widget.scene.canvas;
    const bounds = canvas.getBoundingClientRect();
    const windowPosition = new Cesium.Cartesian2(
      clientX - bounds.left,
      clientY - bounds.top,
    );
    let cartesian: Cesium.Cartesian3 | undefined;
    if (this.widget.scene.pickPositionSupported)
      cartesian = this.widget.scene.pickPosition(windowPosition);
    if (!Cesium.defined(cartesian)) {
      const ray = this.widget.camera.getPickRay(windowPosition);
      if (ray) cartesian = this.widget.scene.globe.pick(ray, this.widget.scene);
    }
    if (!Cesium.defined(cartesian)) return undefined;
    const position = Cesium.Cartographic.fromCartesian(cartesian);
    return {
      latitude: Cesium.Math.toDegrees(position.latitude),
      longitude: Cesium.Math.toDegrees(position.longitude),
      altitudeM: position.height,
    };
  }

  setCalibrationView(
    position: GeoPosition,
    pose: { headingDeg: number; pitchDeg: number; rollDeg?: number },
    optics: { horizontalFovDeg: number; verticalFovDeg: number },
  ) {
    if (this.destroyed) return;
    this.alignedPhoto = undefined;
    this.widget.camera.cancelFlight();
    const canvas = this.widget.scene.canvas;
    const aspectRatio = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const frustum = this.widget.camera.frustum;
    if (frustum instanceof Cesium.PerspectiveFrustum) {
      frustum.aspectRatio = aspectRatio;
      frustum.fov = Cesium.Math.toRadians(
        aspectRatio >= 1 ? optics.horizontalFovDeg : optics.verticalFovDeg,
      );
    }
    this.widget.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        position.longitude,
        position.latitude,
        position.altitudeM,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(pose.headingDeg),
        pitch: Cesium.Math.toRadians(pose.pitchDeg),
        roll: Cesium.Math.toRadians(pose.rollDeg ?? 0),
      },
    });
    this.widget.scene.requestRender();
  }

  pickWorldPositions(
    points: { x: number; y: number }[],
  ): (GeoPosition | null)[] {
    const bounds = this.widget.scene.canvas.getBoundingClientRect();
    return points.map(
      (point) =>
        this.pickWorldPosition(bounds.left + point.x, bounds.top + point.y) ??
        null,
    );
  }

  pickDepthWorldPositions(
    points: { x: number; y: number }[],
  ): (GeoPosition | null)[] {
    if (!this.widget.scene.pickPositionSupported) return points.map(() => null);
    return points.map((point) => {
      const windowPosition = new Cesium.Cartesian2(point.x, point.y);
      const cartesian = this.widget.scene.pickPosition(windowPosition);
      if (!Cesium.defined(cartesian)) return null;
      const position = Cesium.Cartographic.fromCartesian(cartesian);
      return {
        latitude: Cesium.Math.toDegrees(position.latitude),
        longitude: Cesium.Math.toDegrees(position.longitude),
        altitudeM: position.height,
      };
    });
  }

  async drillPickDepthWorldPositions(
    points: { x: number; y: number }[],
    limit = 8,
  ): Promise<GeoPosition[][]> {
    const scene = this.widget.scene as Cesium.Scene & {
      drillPickFromRayMostDetailed: (
        ray: Cesium.Ray,
        limit?: number,
        objectsToExclude?: object[],
        width?: number,
      ) => Promise<{ position?: Cesium.Cartesian3 }[]>;
    };
    return Promise.all(
      points.map(async (point) => {
        const windowPosition = new Cesium.Cartesian2(point.x, point.y);
        const ray = scene.camera.getPickRay(windowPosition);
        if (!ray) return [];
        try {
          const intersections = await scene.drillPickFromRayMostDetailed(
            ray,
            limit,
          );
          return intersections.flatMap((intersection) => {
            if (!Cesium.defined(intersection.position)) return [];
            const position = Cesium.Cartographic.fromCartesian(
              intersection.position,
            );
            return [
              {
                latitude: Cesium.Math.toDegrees(position.latitude),
                longitude: Cesium.Math.toDegrees(position.longitude),
                altitudeM: position.height,
              },
            ];
          });
        } catch {
          // This most-detailed ray API is available only in Cesium 3D mode.
          // The caller retains the ordinary depth grid when it is unavailable.
          return [];
        }
      }),
    );
  }

  async pickDepthBeyondWorldPositions(
    points: { x: number; y: number }[],
    startDistanceM: number,
  ): Promise<(GeoPosition | null)[]> {
    const scene = this.widget.scene as Cesium.Scene & {
      pickFromRayMostDetailed: (
        ray: Cesium.Ray,
        objectsToExclude?: object[],
        width?: number,
      ) => Promise<{ position?: Cesium.Cartesian3 } | undefined>;
    };
    return Promise.all(
      points.map(async (point) => {
        const windowPosition = new Cesium.Cartesian2(point.x, point.y);
        const cameraRay = scene.camera.getPickRay(windowPosition);
        if (!cameraRay) return null;
        const advancedOrigin = Cesium.Ray.getPoint(
          cameraRay,
          startDistanceM,
          new Cesium.Cartesian3(),
        );
        const advancedRay = new Cesium.Ray(advancedOrigin, cameraRay.direction);
        try {
          const intersection = await scene.pickFromRayMostDetailed(advancedRay);
          if (!Cesium.defined(intersection?.position)) return null;
          const position = Cesium.Cartographic.fromCartesian(
            intersection.position,
          );
          return {
            latitude: Cesium.Math.toDegrees(position.latitude),
            longitude: Cesium.Math.toDegrees(position.longitude),
            altitudeM: position.height,
          };
        } catch {
          return null;
        }
      }),
    );
  }

  async waitForStableFrame(timeoutMs = 8_000) {
    const started = performance.now();
    let stableFrames = 0;
    while (performance.now() - started < timeoutMs) {
      if (this.destroyed) return;
      this.widget.scene.requestRender();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      if (this.destroyed) return;
      if (!this.tileset || this.tileset.tilesLoaded) stableFrames += 1;
      else stableFrames = 0;
      if (stableFrames >= 12) {
        return;
      }
    }
    // Some streaming 3D tilesets continuously refine distant LODs. A bounded
    // screenshot is still safe because automatic match/PnP gates reject a
    // sparse or inconsistent reference.
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.providerLoadId += 1;
    this.resizeObserver.disconnect();
    this.removeRenderErrorListener?.();
    this.removeTileFailureListener?.();
    this.handler.destroy();
    this.clearFrustum();
    this.clearHighlight();
    this.widget.destroy();
  }

  private isCurrentProvider(loadId: number) {
    return !this.destroyed && loadId === this.providerLoadId;
  }

  private async loadPhotorealistic(loadId: number) {
    if (!this.options.googleKey)
      throw new Error("Missing Google Map Tiles key.");
    this.widget.scene.globe.show = false;
    const tileset = await Cesium.createGooglePhotorealistic3DTileset(
      {
        key: this.options.googleKey,
        onlyUsingWithGoogleGeocoder: true,
      },
      {
        showCreditsOnScreen: true,
        maximumScreenSpaceError: this.options.mobile ? 18 : 12,
        dynamicScreenSpaceError: true,
        cullRequestsWhileMoving: true,
        cullRequestsWhileMovingMultiplier: 80,
        foveatedScreenSpaceError: true,
        skipLevelOfDetail: true,
        skipLevels: 1,
        skipScreenSpaceErrorFactor: 12,
      },
    );
    if (!this.isCurrentProvider(loadId)) {
      tileset.destroy();
      return;
    }
    this.tileset = tileset;
    this.widget.scene.primitives.add(tileset);
    this.observeTileFailures(tileset);
  }

  private async loadOsmBuildings(loadId: number) {
    if (!this.options.ionToken) throw new Error("Missing Cesium ion token.");
    await this.loadTerrain(loadId);
    if (!this.isCurrentProvider(loadId)) return;
    const tileset = await Cesium.createOsmBuildingsAsync();
    if (!this.isCurrentProvider(loadId)) {
      tileset.destroy();
      return;
    }
    this.tileset = tileset;
    this.widget.scene.primitives.add(tileset);
    this.observeTileFailures(tileset);
  }

  private async loadTerrain(loadId: number) {
    await this.loadBasicMap(loadId);
    if (!this.isCurrentProvider(loadId)) return;
    if (this.options.ionToken) {
      const terrain = await Cesium.createWorldTerrainAsync({
        requestWaterMask: true,
        requestVertexNormals: true,
      });
      if (this.isCurrentProvider(loadId))
        this.widget.scene.terrainProvider = terrain;
    }
  }

  private async loadBasicMap(loadId: number) {
    this.widget.scene.globe.show = true;
    this.widget.scene.terrainProvider = new Cesium.EllipsoidTerrainProvider();
    const provider = await Cesium.TileMapServiceImageryProvider.fromUrl(
      Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII"),
    );
    if (this.isCurrentProvider(loadId))
      this.widget.scene.imageryLayers.addImageryProvider(provider);
  }

  private addMarkers() {
    this.widget.entities.removeAll();
    const regionOnly = this.photos.filter(
      (photo) => photo.capabilities.marker && photo.placement.kind === "region",
    );
    for (const photo of this.photos.filter(
      (candidate) =>
        candidate.capabilities.marker && candidate.placement.kind !== "region",
    )) {
      const position = resolvePosition(photo);
      const markerColor =
        photo.pose.calibration === "rejected"
          ? "#ff5a36"
          : photo.placement.kind === "rounded-gps"
            ? "#ffd15c"
            : photo.presentation === "hero"
              ? "#ff7656"
              : "#c4d37b";
      this.widget.entities.add({
        id: `photo:${photo.id}`,
        name: photo.image.alt,
        position: Cesium.Cartesian3.fromDegrees(
          position.longitude,
          position.latitude,
          position.altitudeM,
        ),
        point: {
          pixelSize: photo.presentation === "hero" ? 14 : 10,
          color: Cesium.Color.fromCssColorString(markerColor),
          outlineColor: Cesium.Color.fromCssColorString("#090b09"),
          outlineWidth: 3,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    if (regionOnly.length) {
      const first = regionOnly[0];
      const position = resolvePosition(first);
      this.widget.entities.add({
        id: `photo:${first.id}`,
        name: `${regionOnly.length} region-only photographs`,
        position: Cesium.Cartesian3.fromDegrees(
          position.longitude,
          position.latitude,
          position.altitudeM,
        ),
        point: {
          pixelSize: 18,
          color: Cesium.Color.fromCssColorString("#c4d37b"),
          outlineColor: Cesium.Color.fromCssColorString("#090b09"),
          outlineWidth: 3,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `${regionOnly.length} region-only`,
          font: "12px sans-serif",
          fillColor: Cesium.Color.fromCssColorString("#f0eadc"),
          outlineColor: Cesium.Color.fromCssColorString("#090b09"),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -28),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
  }

  private flyToCity() {
    if (!this.city) return;
    const target = Cesium.Cartesian3.fromDegrees(
      this.city.center.longitude,
      this.city.center.latitude,
      this.city.center.altitudeM,
    );
    this.widget.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(target, 1),
      {
        offset: new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(this.city.defaultCamera.headingDeg),
          Cesium.Math.toRadians(this.city.defaultCamera.pitchDeg),
          this.city.defaultCamera.rangeM,
        ),
        duration: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : 1.2,
      },
    );
  }

  private focusOnPhoto(photo: PhotoSceneRecord) {
    if (!photo.capabilities.marker || photo.placement.kind === "hidden") return;
    const position = resolvePosition(photo);
    const target = Cesium.Cartesian3.fromDegrees(
      position.longitude,
      position.latitude,
      position.altitudeM,
    );
    this.widget.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(target, 1),
      {
        offset: new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians((photo.pose.headingDeg ?? 0) + 180),
          Cesium.Math.toRadians(-28),
          Math.max(140, photo.frustum.farM * 1.4),
        ),
        duration: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : 0.8,
      },
    );
  }

  private getPhotoOrientation(
    photo: PhotoSceneRecord,
    origin: Cesium.Cartesian3,
  ) {
    const camera = new Cesium.Camera(this.widget.scene);
    camera.setView({
      destination: origin,
      orientation: {
        heading: Cesium.Math.toRadians(photo.pose.headingDeg ?? 0),
        pitch: Cesium.Math.toRadians(photo.pose.pitchDeg ?? 0),
        roll: Cesium.Math.toRadians(photo.pose.rollDeg ?? 0),
      },
    });
    return frustumOrientationFromCamera(camera);
  }

  private applyHighlight(photo: PhotoSceneRecord) {
    this.clearHighlight();
    if (
      !this.tileset ||
      !photo.capabilities.projection ||
      photo.presentation !== "hero" ||
      photo.pose.calibration !== "calibrated" ||
      photo.highlight.mode === "off" ||
      !photo.highlight.approved
    )
      return;
    try {
      const position = resolvePosition(photo);
      const tempCamera = new Cesium.Camera(this.widget.scene);
      tempCamera.setView({
        destination: Cesium.Cartesian3.fromDegrees(
          position.longitude,
          position.latitude,
          position.altitudeM,
        ),
        orientation: {
          heading: Cesium.Math.toRadians(photo.pose.headingDeg ?? 0),
          pitch: Cesium.Math.toRadians(photo.pose.pitchDeg ?? 0),
          roll: Cesium.Math.toRadians(photo.pose.rollDeg ?? 0),
        },
      });
      tempCamera.frustum = new Cesium.PerspectiveFrustum({
        fov: Cesium.Math.toRadians(
          photo.image.width >= photo.image.height
            ? photo.optics.horizontalFovDeg
            : photo.optics.verticalFovDeg,
        ),
        aspectRatio: photo.image.width / photo.image.height,
        near: photo.frustum.nearM,
        far: photo.frustum.farM,
      });
      const viewProjection = Cesium.Matrix4.multiply(
        tempCamera.frustum.projectionMatrix,
        tempCamera.viewMatrix,
        new Cesium.Matrix4(),
      );
      this.shader = new Cesium.CustomShader({
        uniforms: {
          u_photoViewProjection: {
            type: Cesium.UniformType.MAT4,
            value: viewProjection,
          },
          u_tint: {
            type: Cesium.UniformType.VEC3,
            value: new Cesium.Cartesian3(1, 0.32, 0.14),
          },
          u_photo: {
            type: Cesium.UniformType.SAMPLER_2D,
            value: new Cesium.TextureUniform({
              url: photo.image.url,
              repeat: false,
            }),
          },
          u_projectPhoto: {
            type: Cesium.UniformType.FLOAT,
            value: photo.highlight.mode === "projective-texture" ? 1 : 0,
          },
        },
        fragmentShaderText: `
          void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
            vec4 world = czm_inverseView * vec4(fsInput.attributes.positionEC, 1.0);
            vec4 clip = u_photoViewProjection * world;
            vec3 ndc = clip.xyz / max(clip.w, 0.0001);
            float facing = dot(normalize(fsInput.attributes.normalEC), normalize(-fsInput.attributes.positionEC));
            if (clip.w > 0.0 && abs(ndc.x) <= 1.0 && abs(ndc.y) <= 1.0 && ndc.z >= -1.0 && ndc.z <= 1.0 && facing > 0.05) {
              vec2 uv = ndc.xy * 0.5 + 0.5;
              uv.y = 1.0 - uv.y;
              vec3 projectedPhoto = texture(u_photo, uv).rgb;
              vec3 overlay = mix(u_tint, projectedPhoto, u_projectPhoto);
              material.diffuse = mix(material.diffuse, overlay, u_projectPhoto > 0.5 ? 0.52 : 0.26);
            }
          }
        `,
      });
      this.tileset.customShader = this.shader;
    } catch {
      this.options.onStatus?.(
        "Surface highlight unavailable; showing the calibrated frustum only.",
      );
      this.clearHighlight();
    }
  }

  private observeTileFailures(tileset: Cesium.Cesium3DTileset) {
    this.removeTileFailureListener = tileset.tileFailed.addEventListener(() => {
      const now = Date.now();
      this.tileFailures = this.tileFailures
        .filter((time) => now - time < 15_000)
        .concat(now);
      if (this.tileFailures.length >= 12) {
        this.tileFailures = [];
        if (this.options.allowTierFallback === false) {
          this.options.onFatalError?.(
            new Error("Photorealistic tiles repeatedly failed to load."),
          );
        } else void this.setTier(nextSimplerTier(this.tier));
      }
    });
  }

  private resize() {
    if (this.destroyed || this.widget.isDestroyed()) return;
    if (this.container.clientWidth <= 0 || this.container.clientHeight <= 0)
      return;
    this.widget.resize();
    if (this.alignedPhoto) this.fitPhotoFrustum(this.alignedPhoto);
    this.widget.scene.requestRender();
  }

  private fitPhotoFrustum(photo: PhotoSceneRecord) {
    const frustum = this.widget.camera.frustum;
    if (!(frustum instanceof Cesium.PerspectiveFrustum)) return;
    const canvas = this.widget.scene.canvas;
    const viewportAspect =
      Math.max(1, canvas.clientWidth) / Math.max(1, canvas.clientHeight);
    const fitted = containAwareFov(
      photo.optics.horizontalFovDeg,
      photo.optics.verticalFovDeg,
      photo.image.width / photo.image.height,
      viewportAspect,
    );
    frustum.fov = Cesium.Math.toRadians(
      viewportAspect >= 1 ? fitted.horizontalFovDeg : fitted.verticalFovDeg,
    );
    frustum.aspectRatio = viewportAspect;
  }

  private leavePhotoView() {
    this.alignedPhoto = undefined;
    this.setComparisonLocked(false);
    this.widget.scene.screenSpaceCameraController.enableCollisionDetection = true;
    const frustum = this.widget.camera.frustum;
    if (frustum instanceof Cesium.PerspectiveFrustum)
      frustum.fov = Cesium.Math.toRadians(60);
    this.widget.camera.cancelFlight();
  }

  private async handleRenderFailure(error: unknown) {
    if (this.destroyed || this.handlingRenderFailure) return;
    this.handlingRenderFailure = true;
    const failedTier = this.tier;
    const fallback = nextSimplerTier(failedTier);
    console.error(
      `Photography map renderer failed on ${failedTier}: ${describeError(error)}`,
    );
    try {
      if (this.options.allowTierFallback === false) {
        this.options.onFatalError?.(error);
        return;
      }
      if (fallback === failedTier) {
        this.options.onStatus?.(
          "The 3D renderer stopped. The standard gallery remains available.",
        );
        return;
      }
      this.options.onStatus?.(
        `${failedTier.replace("-", " ")} renderer failed; using ${fallback.replace("-", " ")}.`,
      );
      await this.setTier(fallback);
      if (!this.destroyed) {
        this.resize();
        this.widget.useDefaultRenderLoop = true;
      }
    } finally {
      this.handlingRenderFailure = false;
    }
  }

  private clearProvider() {
    this.removeTileFailureListener?.();
    this.removeTileFailureListener = undefined;
    this.tileFailures = [];
    this.clearHighlight();
    if (this.tileset) {
      this.widget.scene.primitives.remove(this.tileset);
      this.tileset = undefined;
    }
    this.widget.scene.imageryLayers.removeAll(true);
  }

  private clearFrustum() {
    for (const primitive of this.frustumPrimitives)
      this.widget.scene.primitives.remove(primitive);
    this.frustumPrimitives = [];
  }

  private clearHighlight() {
    if (this.tileset) this.tileset.customShader = undefined;
    this.shader?.destroy();
    this.shader = undefined;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Provider readiness timeout.")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
