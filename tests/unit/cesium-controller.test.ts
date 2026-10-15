import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Cesium from "cesium";
import { CesiumSceneController } from "../../src/lib/photography-map/controller";
import { cityScenes } from "../../src/lib/photography-map/cities";
import { getPilotPhotosForCity } from "../../src/lib/photography-map/data";

const mocks = vi.hoisted(() => ({
  widget: {} as object,
  google: vi.fn(),
  osm: vi.fn(),
  basic: vi.fn(),
  resize: undefined as (() => void) | undefined,
}));

vi.mock("cesium", async (importOriginal) => {
  const actual = await importOriginal<typeof import("cesium")>();
  return {
    ...actual,
    CesiumWidget: class {
      constructor() {
        return mocks.widget;
      }
    },
    ScreenSpaceEventHandler: class {
      setInputAction() {}
      destroy() {}
    },
    createGooglePhotorealistic3DTileset: mocks.google,
    createOsmBuildingsAsync: mocks.osm,
    TileMapServiceImageryProvider: { fromUrl: mocks.basic },
    buildModuleUrl: (url: string) => url,
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createWidget() {
  let destroyed = false;
  const canvas = {
    clientWidth: 960,
    clientHeight: 600,
    getBoundingClientRect: () => ({ left: 120, top: 240 }),
  };
  const camera = {
    frustum: new Cesium.PerspectiveFrustum(),
    flyTo: vi.fn(),
    setView: vi.fn(),
    flyToBoundingSphere: vi.fn(),
    cancelFlight: vi.fn(),
    getPickRay: vi.fn(
      () => new Cesium.Ray(Cesium.Cartesian3.UNIT_X, Cesium.Cartesian3.UNIT_Y),
    ),
  };
  const scene = {
    canvas,
    camera,
    globe: { show: true, baseColor: undefined },
    backgroundColor: undefined,
    fog: { enabled: false },
    screenSpaceCameraController: {
      enableInputs: true,
      enableCollisionDetection: true,
    },
    renderError: new Cesium.Event(),
    primitives: { add: vi.fn(), remove: vi.fn() },
    imageryLayers: { addImageryProvider: vi.fn(), removeAll: vi.fn() },
    requestRender: vi.fn(() => {
      if (destroyed) throw new Error("Rendering after destruction");
    }),
    pickPositionSupported: true,
    pickPosition: vi.fn(() => Cesium.Cartesian3.fromDegrees(-79, 43, 20)),
    drillPickFromRayMostDetailed: vi.fn(async () => []),
    pickFromRayMostDetailed: vi.fn(async () => undefined),
  };
  return {
    scene,
    camera,
    entities: { add: vi.fn(), removeAll: vi.fn() },
    resize: vi.fn(),
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => {
      destroyed = true;
    }),
  };
}

function createTileset() {
  return { destroy: vi.fn(), tileFailed: new Cesium.Event() };
}

function createController() {
  const widget = createWidget();
  mocks.widget = widget;
  const controller = new CesiumSceneController(
    { clientWidth: 960, clientHeight: 600 } as HTMLElement,
    { googleKey: "test-only", allowTierFallback: false },
  );
  return { controller, widget };
}

beforeEach(() => {
  vi.stubGlobal("document", { querySelector: () => ({}) });
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        mocks.resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  mocks.google.mockReset();
  mocks.basic.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("3D provider lifecycle", () => {
  it("disposes a provider that finishes after the visitor leaves 3D", async () => {
    const pending = deferred<ReturnType<typeof createTileset>>();
    mocks.google.mockReturnValue(pending.promise);
    const { controller, widget } = createController();
    const loading = controller.loadCity(cityScenes[0], [], "photorealistic");
    controller.destroy();
    const tileset = createTileset();
    pending.resolve(tileset);
    await expect(loading).resolves.toBeUndefined();
    expect(tileset.destroy).toHaveBeenCalledOnce();
    expect(widget.scene.primitives.add).not.toHaveBeenCalled();
    expect(widget.entities.removeAll).not.toHaveBeenCalled();
    expect(widget.camera.flyToBoundingSphere).not.toHaveBeenCalled();
    controller.destroy();
    expect(widget.destroy).toHaveBeenCalledOnce();
  });

  it("does not attach an obsolete provider after another tier is ready", async () => {
    const pending = deferred<ReturnType<typeof createTileset>>();
    mocks.google.mockReturnValue(pending.promise);
    const { controller, widget } = createController();
    const loading = controller.setTier("photorealistic");
    await controller.setTier("marker");
    const tileset = createTileset();
    pending.resolve(tileset);
    await loading;
    expect(tileset.destroy).toHaveBeenCalledOnce();
    expect(widget.scene.primitives.add).not.toHaveBeenCalled();
    expect(
      widget.scene.imageryLayers.addImageryProvider,
    ).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it("invalidates a timed-out provider even if it eventually resolves", async () => {
    vi.useFakeTimers();
    const pending = deferred<ReturnType<typeof createTileset>>();
    mocks.google.mockReturnValue(pending.promise);
    const { controller, widget } = createController();
    const loading = expect(
      controller.setTier("photorealistic"),
    ).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(20_000);
    await loading;
    const tileset = createTileset();
    pending.resolve(tileset);
    await Promise.resolve();
    expect(tileset.destroy).toHaveBeenCalledOnce();
    expect(widget.scene.primitives.add).not.toHaveBeenCalled();
    controller.destroy();
  });
});

describe("photo alignment", () => {
  it("keeps photo projection registered when the viewport changes shape", () => {
    const { controller, widget } = createController();
    const photo = getPilotPhotosForCity("toronto").find(
      (record) => record.capabilities.comparison,
    )!;
    controller.replacePhotos([photo]);
    controller.alignToPhoto(photo.id, 0);
    controller.setComparisonLocked(true);
    const imageAspect = photo.image.width / photo.image.height;
    for (const [width, height] of [
      [1200, 600],
      [320, 700],
      [600, 600],
    ]) {
      widget.scene.canvas.clientWidth = width;
      widget.scene.canvas.clientHeight = height;
      mocks.resize?.();
      const frustum = widget.camera.frustum;
      const imageWidth = Math.min(width, height * imageAspect);
      const imageHeight = Math.min(height, width / imageAspect);
      const viewportVerticalTan = Math.tan(frustum.fovy! / 2);
      const viewportHorizontalTan = viewportVerticalTan * frustum.aspectRatio!;
      expect((viewportHorizontalTan * imageWidth) / width).toBeCloseTo(
        Math.tan(Cesium.Math.toRadians(photo.optics.horizontalFovDeg) / 2),
        6,
      );
      expect((viewportVerticalTan * imageHeight) / height).toBeCloseTo(
        Math.tan(Cesium.Math.toRadians(photo.optics.verticalFovDeg) / 2),
        6,
      );
    }
    expect(widget.scene.screenSpaceCameraController.enableInputs).toBe(false);
    expect(
      widget.scene.screenSpaceCameraController.enableCollisionDetection,
    ).toBe(false);
    controller.selectPhoto(photo.id);
    expect(widget.scene.screenSpaceCameraController.enableInputs).toBe(true);
    expect(
      widget.scene.screenSpaceCameraController.enableCollisionDetection,
    ).toBe(true);
    expect(widget.camera.frustum.fov).toBeCloseTo(Math.PI / 3);
    controller.destroy();
  });

  it("samples depth in canvas coordinates regardless of page position", async () => {
    const { controller, widget } = createController();
    const points = [
      { x: 20, y: 30 },
      { x: 300, y: 200 },
    ];
    controller.pickDepthWorldPositions(points);
    expect(widget.scene.pickPosition).toHaveBeenNthCalledWith(
      1,
      new Cesium.Cartesian2(20, 30),
    );
    expect(widget.scene.pickPosition).toHaveBeenNthCalledWith(
      2,
      new Cesium.Cartesian2(300, 200),
    );
    await controller.drillPickDepthWorldPositions(points);
    await controller.pickDepthBeyondWorldPositions(points, 10);
    expect(widget.camera.getPickRay).toHaveBeenNthCalledWith(
      1,
      new Cesium.Cartesian2(20, 30),
    );
    expect(widget.camera.getPickRay).toHaveBeenNthCalledWith(
      3,
      new Cesium.Cartesian2(20, 30),
    );
    controller.destroy();
  });
});
