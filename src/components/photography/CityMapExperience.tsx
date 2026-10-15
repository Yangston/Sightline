import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { getStartingPhoto } from "@/lib/collection";
import {
  groupPhotoMarkers,
  photoReviewCategory,
  photoReviewLabel,
} from "@/lib/photography-map/presentation";
import {
  buildSatelliteTileGrid,
  projectStaticMapPosition,
  type StaticMapTile,
} from "@/lib/photography-map/static-map";
import {
  clampStaticMapTransform,
  zoomStaticMapTransform,
  type StaticMapTransform,
} from "@/lib/photography-map/static-interaction";
import type {
  CitySceneConfig,
  MapMode,
  PhotoReviewCategory,
  PhotoSceneRecord,
  ReconstructionMethod,
  CityScenePayload,
  PublicMapPhotoSummary,
  StaticMapViewport,
} from "@/lib/photography-map";

type Props = {
  city: CitySceneConfig;
  photos: PublicMapPhotoSummary[];
  imageOnlyPhotos?: PublicMapPhotoSummary[];
  sceneUrl: string;
  viewport: StaticMapViewport;
  googleKey?: string;
};

type CameraAction = "frustum" | "camera" | "comparison";

type ControllerApi = {
  loadCity: (
    city: CitySceneConfig,
    photos: PhotoSceneRecord[],
    tier: "photorealistic" | "marker",
  ) => Promise<void>;
  selectPhoto: (id: string) => void;
  showFrustum: (id?: string) => void;
  hideFrustum: () => void;
  alignToPhoto: (id?: string, duration?: number) => void;
  setComparisonLocked: (locked: boolean) => void;
  resetView: () => void;
  replacePhotos: (photos: PhotoSceneRecord[]) => void;
  destroy: () => void;
};

const categories: PhotoReviewCategory[] = [
  "complete",
  "failed-tests",
  "missing-data",
];

function hasWebGl() {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2");
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return Boolean(context);
  } catch {
    return false;
  }
}

function humanize(value: string) {
  return value
    .replaceAll(":", " / ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function placementLabel(photo: PublicMapPhotoSummary) {
  if (photo.rejectionReasons.includes("outside-image-only-pilot-area"))
    return "Outside image-only pilot area";
  if (
    photo.reconstruction.method === "image-only" &&
    !photo.capabilities.marker
  )
    return "No image-only marker";
  if (photo.placement.kind === "region") return "Region-only placement";
  if (photo.placement.kind === "rounded-gps") return "Approximate GPS";
  if (photo.placement.kind === "hidden") return "Location hidden";
  return "Exact published position";
}

function evaluationItems(photo: PublicMapPhotoSummary) {
  const evaluation = photo.reconstruction.evaluation;
  if (!evaluation?.referenceAvailable) return [];
  return [
    ["Horizontal", evaluation.horizontalErrorM, "m"],
    ["Altitude", evaluation.altitudeErrorM, "m"],
    ["Heading", evaluation.headingErrorDeg, "°"],
    ["Pitch", evaluation.pitchErrorDeg, "°"],
    ["Roll", evaluation.rollErrorDeg, "°"],
    ["FOV", evaluation.horizontalFovErrorDeg, "°"],
  ].filter((item): item is [string, number, string] => item[1] !== undefined);
}

async function waitForLayout(container: HTMLElement) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    if (container.clientWidth > 0 && container.clientHeight > 0) return;
  }
  throw new Error("The 3D map container did not become visible.");
}

export default function CityMapExperience({
  city,
  photos,
  imageOnlyPhotos,
  sceneUrl,
  viewport,
  googleKey,
}: Props) {
  const startingPhotoId = getStartingPhoto(city.id, photos)?.id ?? null;
  const experienceRef = useRef<HTMLElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const staticMapRef = useRef<HTMLDivElement>(null);
  const staticSurfaceRef = useRef<HTMLDivElement>(null);
  const loadedTileIdsRef = useRef(new Set<string>());
  const controllerRef = useRef<ControllerApi | undefined>(undefined);
  const scenePayloadRef = useRef<CityScenePayload | undefined>(undefined);
  const drawerToggleRef = useRef<HTMLButtonElement>(null);
  const threeDLoadRef = useRef(0);
  const initialViewRequestedRef = useRef(false);
  const modeRef = useRef<MapMode>("2d");
  const selectionRef = useRef<{
    id: string | null;
    method: ReconstructionMethod;
  }>({ id: startingPhotoId, method: "metadata-assisted" });
  const staticTransformRef = useRef<StaticMapTransform>({
    x: 0,
    y: 0,
    scale: 1,
  });
  const staticDragRef = useRef<
    | {
        pointerId: number;
        clientX: number;
        clientY: number;
        origin: StaticMapTransform;
      }
    | undefined
  >(undefined);
  const [hydrated, setHydrated] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(startingPhotoId);
  const [reconstructionMethod, setReconstructionMethod] =
    useState<ReconstructionMethod>("metadata-assisted");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mode, setMode] = useState<MapMode>("2d");
  const [loading3d, setLoading3d] = useState(false);
  const [staticTiles, setStaticTiles] = useState<StaticMapTile[]>([]);
  const [mapAttribution, setMapAttribution] = useState("Google Maps");
  const [staticImageReady, setStaticImageReady] = useState(false);
  const [staticImageFailed, setStaticImageFailed] = useState(false);
  const [status, setStatus] = useState(
    googleKey
      ? "Loading satellite map…"
      : "Map imagery unavailable. Camera geometry is available in 3D.",
  );
  const [frustumVisible, setFrustumVisible] = useState(false);
  const [comparison, setComparison] = useState(false);
  const [comparisonOpacity, setComparisonOpacity] = useState(50);
  const [scenePhotos, setScenePhotos] = useState<PhotoSceneRecord[]>();
  const activePhotos =
    reconstructionMethod === "image-only" && imageOnlyPhotos
      ? imageOnlyPhotos
      : photos;
  const groups = useMemo(() => groupPhotoMarkers(activePhotos), [activePhotos]);
  const selected = activePhotos.find((photo) => photo.id === selectedId);
  const selectedScene = scenePhotos?.find((photo) => photo.id === selectedId);
  const reduced = useMemo(
    () =>
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const openInitialThreeD = useEffectEvent(() => {
    void openThreeD();
  });

  useEffect(() => {
    const restoreFromUrl = () => {
      const params = new URLSearchParams(location.search);
      const requested = params.get("photo");
      const requestedMethod = params.get("reconstruction");
      const method =
        requestedMethod === "image-only" && imageOnlyPhotos
          ? "image-only"
          : "metadata-assisted";
      const methodPhotos =
        method === "image-only" && imageOnlyPhotos ? imageOnlyPhotos : photos;
      const nextId =
        requested && methodPhotos.some((photo) => photo.id === requested)
          ? requested
          : (getStartingPhoto(city.id, methodPhotos)?.id ?? null);
      selectionRef.current = { id: nextId, method };
      setReconstructionMethod(method);
      setSelectedId(nextId);
      setFrustumVisible(false);
      setComparison(false);
      if (requested) setDrawerOpen(true);
      if (scenePayloadRef.current) {
        const records = recordsForMethod(scenePayloadRef.current, method);
        setScenePhotos(records);
        controllerRef.current?.replacePhotos(records);
      }
      if (nextId) controllerRef.current?.selectPhoto(nextId);
    };
    const hydrationFrame = requestAnimationFrame(() => {
      setHydrated(true);
      restoreFromUrl();
      if (
        !initialViewRequestedRef.current &&
        new URLSearchParams(location.search).get("view") === "3d"
      ) {
        initialViewRequestedRef.current = true;
        openInitialThreeD();
      }
    });
    window.addEventListener("popstate", restoreFromUrl);
    return () => {
      cancelAnimationFrame(hydrationFrame);
      window.removeEventListener("popstate", restoreFromUrl);
      threeDLoadRef.current += 1;
      controllerRef.current?.destroy();
      controllerRef.current = undefined;
    };
  }, [city.id, imageOnlyPhotos, photos]);

  useEffect(() => {
    if (!googleKey) return;
    const controller = new AbortController();
    loadedTileIdsRef.current.clear();

    async function prepareSatelliteMap() {
      try {
        const sessionResponse = await fetch(
          `https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(googleKey!)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mapType: "satellite",
              language: "en-US",
              region: "US",
            }),
            signal: controller.signal,
          },
        );
        if (!sessionResponse.ok)
          throw new Error(`Map session failed (${sessionResponse.status}).`);
        const payload = (await sessionResponse.json()) as { session?: string };
        if (!payload.session)
          throw new Error("Map session is missing a token.");
        const tiles = buildSatelliteTileGrid(
          viewport,
          payload.session,
          googleKey!,
        );
        if (controller.signal.aborted) return;
        setStaticTiles(tiles);

        const bounds = city.bounds;
        const attributionQuery = new URLSearchParams({
          session: payload.session,
          key: googleKey!,
          zoom: String(viewport.zoom),
          north: String(bounds.north),
          south: String(bounds.south),
          east: String(bounds.east),
          west: String(bounds.west),
        });
        const attributionResponse = await fetch(
          `https://tile.googleapis.com/tile/v1/viewport?${attributionQuery}`,
          { signal: controller.signal },
        );
        if (attributionResponse.ok) {
          const attribution = (await attributionResponse.json()) as {
            copyright?: string;
          };
          if (attribution.copyright) setMapAttribution(attribution.copyright);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("The satellite map could not start.", error);
        setStaticImageFailed(true);
        setStatus("Map imagery unavailable. Photographs remain available.");
      }
    }

    void prepareSatelliteMap();
    return () => controller.abort();
  }, [city.bounds, googleKey, viewport]);

  function markStaticTileReady(id: string) {
    loadedTileIdsRef.current.add(id);
    if (
      staticTiles.length > 0 &&
      loadedTileIdsRef.current.size >= staticTiles.length
    ) {
      setStaticImageReady(true);
      if (modeRef.current === "2d") setStatus("Satellite map ready.");
    }
  }

  useEffect(() => {
    const viewportElement = staticMapRef.current;
    if (!viewportElement) return;
    const observer = new ResizeObserver(() => {
      const next = clampStaticMapTransform(
        staticTransformRef.current,
        viewportElement.clientWidth,
        viewportElement.clientHeight,
      );
      applyStaticTransform(next);
    });
    observer.observe(viewportElement);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (
        !(event.target instanceof Node) ||
        !experienceRef.current?.contains(event.target)
      )
        return;
      if (comparison) {
        setComparison(false);
        controllerRef.current?.setComparisonLocked(false);
        return;
      }
      if (!drawerOpen) return;
      setDrawerOpen(false);
      drawerToggleRef.current?.focus();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [comparison, drawerOpen]);

  function selectPhoto(id: string) {
    selectionRef.current.id = id;
    setSelectedId(id);
    setDrawerOpen(true);
    setFrustumVisible(false);
    setComparison(false);
    const url = new URL(location.href);
    url.searchParams.set("photo", id);
    history.replaceState({}, "", url);
    controllerRef.current?.selectPhoto(id);
  }

  function returnToTwoD(message?: string) {
    threeDLoadRef.current += 1;
    controllerRef.current?.destroy();
    controllerRef.current = undefined;
    modeRef.current = "2d";
    setMode("2d");
    setLoading3d(false);
    setFrustumVisible(false);
    setComparison(false);
    setStatus(
      message ??
        (staticImageFailed || !googleKey
          ? "Map imagery unavailable. Camera geometry is available in 3D."
          : "Satellite map ready."),
    );
  }

  function recordsForMethod(
    payload: CityScenePayload,
    method: ReconstructionMethod,
  ) {
    return (payload.variants[method] ?? []).flatMap((variant) =>
      variant.record ? [variant.record] : [],
    );
  }

  async function loadScenePayload() {
    if (scenePayloadRef.current) return scenePayloadRef.current;
    const response = await fetch(sceneUrl, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok)
      throw new Error(`Scene request failed (${response.status}).`);
    const payload: unknown = await response.json();
    if (
      !payload ||
      typeof payload !== "object" ||
      !("variants" in payload) ||
      !("cityId" in payload) ||
      payload.cityId !== city.id
    )
      throw new Error("Scene response is invalid.");
    const scenePayload = payload as CityScenePayload;
    scenePayloadRef.current = scenePayload;
    return scenePayload;
  }

  function switchReconstruction(method: ReconstructionMethod) {
    if (method === reconstructionMethod) return;
    const nextPhotos =
      method === "image-only" && imageOnlyPhotos ? imageOnlyPhotos : photos;
    const nextSelectedId =
      selectedId && nextPhotos.some((photo) => photo.id === selectedId)
        ? selectedId
        : (getStartingPhoto(city.id, nextPhotos)?.id ?? null);
    selectionRef.current = { id: nextSelectedId, method };
    setReconstructionMethod(method);
    setSelectedId(nextSelectedId);
    setFrustumVisible(false);
    setComparison(false);
    const url = new URL(location.href);
    if (method === "image-only")
      url.searchParams.set("reconstruction", "image-only");
    else url.searchParams.delete("reconstruction");
    if (nextSelectedId) url.searchParams.set("photo", nextSelectedId);
    else url.searchParams.delete("photo");
    history.replaceState({}, "", url);
    if (scenePayloadRef.current) {
      const records = recordsForMethod(scenePayloadRef.current, method);
      setScenePhotos(records);
      controllerRef.current?.replacePhotos(records);
      if (nextSelectedId) controllerRef.current?.selectPhoto(nextSelectedId);
    }
    setStatus(
      method === "image-only"
        ? "Image-only reconstruction. Metadata is used only for evaluation."
        : "Metadata-assisted reconstruction.",
    );
  }

  async function openThreeD(action?: CameraAction) {
    if (modeRef.current === "3d") return;
    if (!hasWebGl()) {
      setStatus("3D requires WebGL. Photographs remain available.");
      return;
    }
    const saveData = Boolean(
      (navigator as Navigator & { connection?: { saveData?: boolean } })
        .connection?.saveData,
    );
    if (saveData) {
      setStatus("3D is paused by your reduced-data preference.");
      return;
    }
    const loadId = ++threeDLoadRef.current;
    const requestedSelection = { ...selectionRef.current };
    setLoading3d(true);
    modeRef.current = "3d";
    setMode("3d");
    setStatus(
      googleKey
        ? "Loading Google photorealistic 3D…"
        : "Opening the 3D camera geometry…",
    );
    try {
      if (!mapRef.current) throw new Error("The 3D map shell is unavailable.");
      const [, { CesiumSceneController }, payload] = await Promise.all([
        waitForLayout(mapRef.current),
        import("@/lib/photography-map/controller"),
        loadScenePayload(),
      ]);
      if (loadId !== threeDLoadRef.current) return;
      const fullPhotos = recordsForMethod(payload, selectionRef.current.method);
      const controller = new CesiumSceneController(mapRef.current, {
        googleKey,
        mobile: matchMedia("(max-width: 700px)").matches,
        allowTierFallback: false,
        onPhotoSelected: selectPhoto,
        onStatus: (message) => {
          if (loadId === threeDLoadRef.current)
            setStatus(
              !googleKey && message === "marker ready"
                ? "Camera geometry ready. Detailed imagery is unavailable."
                : message,
            );
        },
        onFatalError: () => {
          if (loadId === threeDLoadRef.current)
            returnToTwoD("3D unavailable. Retry or continue in 2D.");
        },
      });
      controllerRef.current = controller;
      await controller.loadCity(
        city,
        fullPhotos,
        googleKey ? "photorealistic" : "marker",
      );
      if (loadId !== threeDLoadRef.current) {
        controller.destroy();
        return;
      }
      // The visitor can change photograph or method while providers load.
      const latest = selectionRef.current;
      const latestPhotos = recordsForMethod(payload, latest.method);
      controller.replacePhotos(latestPhotos);
      setScenePhotos(latestPhotos);
      if (latest.id) controller.selectPhoto(latest.id);
      const selectedRecord = latestPhotos.find(
        (photo) => photo.id === latest.id,
      );
      const requestedAction =
        requestedSelection.id === latest.id &&
        requestedSelection.method === latest.method
          ? action
          : undefined;
      if (
        latest.id &&
        requestedAction === "frustum" &&
        selectedRecord?.capabilities.frustum
      ) {
        controller.showFrustum(latest.id);
        setFrustumVisible(true);
      }
      if (latest.id && requestedAction === "camera")
        controller.alignToPhoto(latest.id, reduced ? 0 : 900);
      if (
        latest.id &&
        requestedAction === "comparison" &&
        selectedRecord?.capabilities.comparison
      ) {
        controller.alignToPhoto(latest.id, 0);
        controller.setComparisonLocked(true);
        setComparison(true);
      }
    } catch (error) {
      console.error("The optional 3D photography map could not start.", error);
      if (loadId === threeDLoadRef.current)
        returnToTwoD(
          "The 3D view could not start. Retry or browse the photographs.",
        );
    } finally {
      if (loadId === threeDLoadRef.current) setLoading3d(false);
    }
  }

  function applyStaticTransform(transform: StaticMapTransform) {
    staticTransformRef.current = transform;
    if (!staticSurfaceRef.current) return;
    staticSurfaceRef.current.style.transform = `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`;
    staticSurfaceRef.current.style.setProperty(
      "--map-marker-scale",
      String(1 / transform.scale),
    );
    staticSurfaceRef.current.dataset.zoomed =
      transform.scale > 1.01 ? "true" : "false";
  }

  function staticMapSize() {
    return {
      width: staticMapRef.current?.clientWidth ?? 0,
      height: staticMapRef.current?.clientHeight ?? 0,
    };
  }

  function changeStaticZoom(nextScale: number, anchorX = 0, anchorY = 0) {
    const { width, height } = staticMapSize();
    applyStaticTransform(
      zoomStaticMapTransform(
        staticTransformRef.current,
        nextScale,
        anchorX,
        anchorY,
        width,
        height,
      ),
    );
  }

  function resetStaticMap() {
    applyStaticTransform({ x: 0, y: 0, scale: 1 });
  }

  function startStaticPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (!googleKey || staticImageFailed) return;
    if (event.button !== 0 || (event.target as Element).closest("button"))
      return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.dragging = "true";
    staticDragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      origin: staticTransformRef.current,
    };
  }

  function moveStaticMap(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = staticDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const { width, height } = staticMapSize();
    applyStaticTransform(
      clampStaticMapTransform(
        {
          x: drag.origin.x + event.clientX - drag.clientX,
          y: drag.origin.y + event.clientY - drag.clientY,
          scale: drag.origin.scale,
        },
        width,
        height,
      ),
    );
  }

  function stopStaticPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (staticDragRef.current?.pointerId !== event.pointerId) return;
    staticDragRef.current = undefined;
    event.currentTarget.dataset.dragging = "false";
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function zoomStaticMapAtPointer(event: ReactWheelEvent<HTMLDivElement>) {
    if (!googleKey || staticImageFailed) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const anchorX = event.clientX - bounds.left - bounds.width / 2;
    const anchorY = event.clientY - bounds.top - bounds.height / 2;
    const factor = Math.exp(-event.deltaY * 0.0015);
    changeStaticZoom(
      staticTransformRef.current.scale * factor,
      anchorX,
      anchorY,
    );
  }

  function navigateStaticMap(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!googleKey || staticImageFailed) return;
    if (event.target !== event.currentTarget) return;
    const { width, height } = staticMapSize();
    const current = staticTransformRef.current;
    const step = 42;
    if (["+", "="].includes(event.key)) changeStaticZoom(current.scale * 1.25);
    else if (["-", "_"].includes(event.key))
      changeStaticZoom(current.scale / 1.25);
    else if (event.key === "0" || event.key === "Home") resetStaticMap();
    else if (event.key === "ArrowLeft")
      applyStaticTransform(
        clampStaticMapTransform(
          { ...current, x: current.x + step },
          width,
          height,
        ),
      );
    else if (event.key === "ArrowRight")
      applyStaticTransform(
        clampStaticMapTransform(
          { ...current, x: current.x - step },
          width,
          height,
        ),
      );
    else if (event.key === "ArrowUp")
      applyStaticTransform(
        clampStaticMapTransform(
          { ...current, y: current.y + step },
          width,
          height,
        ),
      );
    else if (event.key === "ArrowDown")
      applyStaticTransform(
        clampStaticMapTransform(
          { ...current, y: current.y - step },
          width,
          height,
        ),
      );
    else return;
    event.preventDefault();
  }

  function runThreeDAction(action: CameraAction) {
    if (mode !== "3d" || !controllerRef.current) {
      void openThreeD(action);
      return;
    }
    if (!selectedId) return;
    if (action === "frustum") {
      setComparison(false);
      controllerRef.current.setComparisonLocked(false);
      if (frustumVisible) controllerRef.current.hideFrustum();
      else controllerRef.current.showFrustum(selectedId);
      setFrustumVisible((current) => !current);
    }
    if (action === "camera") {
      setComparison(false);
      setFrustumVisible(false);
      controllerRef.current.setComparisonLocked(false);
      controllerRef.current.alignToPhoto(selectedId, reduced ? 0 : 900);
    }
    if (action === "comparison") {
      if (!comparison) {
        controllerRef.current.alignToPhoto(selectedId, 0);
        setFrustumVisible(false);
      }
      controllerRef.current.setComparisonLocked(!comparison);
      setComparison((current) => !current);
    }
  }

  return (
    <section
      ref={experienceRef}
      className="city-atlas"
      aria-labelledby="city-atlas-title"
      data-city-map-experience
      data-city-map-mode={mode}
      data-reconstruction-method={reconstructionMethod}
      data-comparison-active={comparison ? "true" : "false"}
    >
      <header className="city-atlas-heading">
        <div>
          <p className="eyebrow">{photos.length} photographs</p>
          <h1 id="city-atlas-title">{city.name}</h1>
        </div>
        <div className="city-atlas-actions" role="group" aria-label="Map mode">
          <button
            type="button"
            aria-pressed={mode === "2d"}
            onClick={() => returnToTwoD()}
          >
            2D satellite
          </button>
          <button
            type="button"
            aria-pressed={mode === "3d"}
            onClick={() => void openThreeD()}
            disabled={!hydrated || loading3d}
            data-open-3d
          >
            {loading3d ? "Opening 3D…" : "Explore in 3D"}
          </button>
          <button
            ref={drawerToggleRef}
            type="button"
            aria-expanded={drawerOpen}
            aria-controls="city-photo-drawer"
            onClick={() => setDrawerOpen((current) => !current)}
            disabled={!hydrated}
          >
            {drawerOpen ? "Hide photographs" : "Browse photographs"}
          </button>
        </div>
      </header>
      {imageOnlyPhotos && (
        <fieldset className="city-reconstruction-toggle">
          <legend>Pose reconstruction</legend>
          <button
            type="button"
            aria-pressed={reconstructionMethod === "metadata-assisted"}
            onClick={() => switchReconstruction("metadata-assisted")}
          >
            Metadata-assisted
          </button>
          <button
            type="button"
            aria-pressed={reconstructionMethod === "image-only"}
            onClick={() => switchReconstruction("image-only")}
          >
            Image-only (no file metadata)
          </button>
        </fieldset>
      )}
      <p className="city-atlas-status" aria-live="polite">
        <span aria-hidden="true"></span>
        {status}
      </p>
      <div className="city-atlas-stage">
        <div
          ref={staticMapRef}
          className="city-satellite-map"
          data-map-available={
            googleKey && !staticImageFailed ? "true" : "false"
          }
          hidden={mode !== "2d"}
          tabIndex={mode === "2d" ? 0 : -1}
          aria-label={`Interactive satellite map of ${city.name}. Drag to pan, scroll or use plus and minus to zoom.`}
          onPointerDown={startStaticPan}
          onPointerMove={moveStaticMap}
          onPointerUp={stopStaticPan}
          onPointerCancel={stopStaticPan}
          onWheel={zoomStaticMapAtPointer}
          onKeyDown={navigateStaticMap}
        >
          {googleKey && !staticImageFailed ? (
            <div ref={staticSurfaceRef} className="city-static-map-surface">
              <div className="city-satellite-tiles" aria-hidden="true">
                {staticTiles.map((tile) => (
                  <img
                    key={tile.id}
                    src={tile.url}
                    width={tile.width}
                    height={tile.height}
                    alt=""
                    loading="eager"
                    decoding="async"
                    draggable={false}
                    style={{
                      left: `${(tile.left / viewport.width) * 100}%`,
                      top: `${(tile.top / viewport.height) * 100}%`,
                      width: `${(tile.width / viewport.width) * 100}%`,
                      height: `${(tile.height / viewport.height) * 100}%`,
                    }}
                    onLoad={() => markStaticTileReady(tile.id)}
                    onError={() => {
                      setStaticImageFailed(true);
                      setStatus(
                        "Map imagery unavailable. Photographs remain available.",
                      );
                    }}
                  />
                ))}
              </div>
              <div className="city-satellite-markers">
                {groups.map((group) => {
                  const point = projectStaticMapPosition(
                    group.position,
                    viewport,
                  );
                  const selectedGroup = group.photos.some(
                    (photo) => photo.id === selectedId,
                  );
                  return (
                    <button
                      type="button"
                      key={group.id}
                      className="city-coordinate-marker"
                      style={{ left: `${point.x}%`, top: `${point.y}%` }}
                      aria-label={`${group.photos.length} ${group.placementKind} photograph${group.photos.length === 1 ? "" : "s"}`}
                      aria-pressed={selectedGroup}
                      data-marker-count={group.photos.length}
                      data-photo-id={group.photos[0].id}
                      onClick={() => selectPhoto(group.photos[0].id)}
                    >
                      <span>{group.photos.length}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="city-map-unavailable">
              {selected && (
                <img
                  className="city-map-placeholder-photo"
                  src={selected.image.thumbnailUrl}
                  alt=""
                  aria-hidden="true"
                />
              )}
              <div>
                <p>Map imagery unavailable.</p>
                <button
                  type="button"
                  className="sightline-button primary"
                  disabled={!hydrated || loading3d}
                  onClick={() => void openThreeD()}
                >
                  Open 3D camera view
                </button>
              </div>
            </div>
          )}
          {googleKey && !staticImageReady && !staticImageFailed && (
            <div className="city-map-loading" aria-hidden="true">
              <span></span>
              Loading satellite view
            </div>
          )}
          {googleKey && !staticImageFailed && (
            <>
              <div
                className="city-static-map-controls"
                aria-label="Map zoom controls"
              >
                <button
                  type="button"
                  aria-label="Zoom in"
                  onClick={() =>
                    changeStaticZoom(staticTransformRef.current.scale * 1.25)
                  }
                >
                  +
                </button>
                <button
                  type="button"
                  aria-label="Zoom out"
                  onClick={() =>
                    changeStaticZoom(staticTransformRef.current.scale / 1.25)
                  }
                >
                  -
                </button>
                <button type="button" onClick={resetStaticMap}>
                  Reset
                </button>
              </div>
              <p className="city-static-map-hint">
                Drag to move / scroll to zoom
              </p>
              <p className="city-map-attribution">
                <span>Google Maps</span> {mapAttribution}
              </p>
            </>
          )}
        </div>
        <div
          ref={mapRef}
          className="city-map-canvas"
          aria-label={`Interactive 3D view of ${city.name}`}
          hidden={mode !== "3d"}
        />
        {mode === "3d" && !loading3d && (
          <div className="city-three-d-controls">
            <span>
              {comparison
                ? "Camera locked for comparison"
                : "Drag to explore · scroll to zoom · Ctrl + drag to orbit"}
            </span>
            <button
              type="button"
              onClick={() => {
                controllerRef.current?.resetView();
                setFrustumVisible(false);
                setComparison(false);
              }}
            >
              City overview
            </button>
          </div>
        )}
        {loading3d && (
          <div className="city-map-loading city-map-loading-3d" role="status">
            <span></span>
            Preparing the 3D city
          </div>
        )}
        {comparison && selectedScene && (
          <img
            className="city-map-camera-comparison"
            src={selectedScene.image.url}
            alt=""
            aria-hidden="true"
            style={{ opacity: comparisonOpacity / 100 }}
            onError={() => {
              setComparison(false);
              controllerRef.current?.setComparisonLocked(false);
              setStatus(
                "This photograph could not load. The 3D scene remains available.",
              );
            }}
          />
        )}
      </div>
      {selected && (
        <div
          className="city-photo-view-controls"
          aria-label={`3D view controls for ${selected.id}`}
        >
          <div className="city-selected-photo">
            <img
              src={selected.image.thumbnailUrl}
              width="64"
              height="48"
              alt=""
              loading="lazy"
              decoding="async"
            />
            <span>
              <strong>{selected.id}</strong>
              <small>{placementLabel(selected)}</small>
            </span>
          </div>
          <div className="city-photo-action-buttons">
            <button
              type="button"
              aria-pressed={frustumVisible}
              disabled={
                !hydrated || !selected.capabilities.frustum || loading3d
              }
              onClick={() => runThreeDAction("frustum")}
            >
              {frustumVisible ? "Hide frustum" : "View camera frustum"}
            </button>
            <button
              type="button"
              disabled={
                !hydrated || !selected.capabilities.comparison || loading3d
              }
              onClick={() => runThreeDAction("camera")}
            >
              Align to photo
            </button>
            <button
              type="button"
              aria-pressed={comparison}
              disabled={
                !hydrated || !selected.capabilities.comparison || loading3d
              }
              onClick={() => runThreeDAction("comparison")}
            >
              {comparison ? "Hide comparison" : "Compare photo"}
            </button>
          </div>
        </div>
      )}
      {comparison && (
        <div className="city-comparison-controls">
          <label htmlFor="photo-comparison-opacity">Photo opacity</label>
          <input
            id="photo-comparison-opacity"
            type="range"
            min="0"
            max="100"
            step="1"
            value={comparisonOpacity}
            onChange={(event) =>
              setComparisonOpacity(Number(event.target.value))
            }
            aria-valuetext={`${comparisonOpacity} percent photograph`}
          />
          <output htmlFor="photo-comparison-opacity">
            {comparisonOpacity}%
          </output>
          <span>0% city · 100% photograph. Press Esc to leave comparison.</span>
        </div>
      )}
      {selected && (
        <p
          className="city-view-notice"
          data-pose-status={selected.pose.calibration}
        >
          {selected.pose.calibration === "rejected"
            ? "Rejected pose. Not verified."
            : selected.pose.calibration === "calibrated"
              ? "Solved pose."
              : selected.capabilities.frustum
                ? "Approximate pose. Position and alignment are unverified."
                : "No publishable camera alignment."}
        </p>
      )}
      <aside
        id="city-photo-drawer"
        className="city-photo-drawer"
        data-open={drawerOpen ? "true" : "false"}
        inert={hydrated && !drawerOpen}
        aria-label={`${city.name} photo review index`}
      >
        <header>
          <p>Photographs</p>
          <button
            type="button"
            onClick={() => {
              setDrawerOpen(false);
              drawerToggleRef.current?.focus();
            }}
            aria-label="Close photo index"
          >
            ×
          </button>
        </header>
        {categories.map((category) => {
          const items = activePhotos.filter(
            (photo) => photoReviewCategory(photo) === category,
          );
          return (
            <section key={category} data-photo-category={category}>
              <h2>
                {photoReviewLabel(category)} <span>{items.length}</span>
              </h2>
              <ul>
                {items.map((photo) => (
                  <li key={photo.id}>
                    <button
                      type="button"
                      aria-pressed={photo.id === selectedId}
                      data-photo-id={photo.id}
                      onClick={() => selectPhoto(photo.id)}
                    >
                      <img
                        src={photo.image.thumbnailUrl}
                        width="72"
                        height={Math.max(
                          1,
                          Math.round(
                            (72 * photo.image.height) / photo.image.width,
                          ),
                        )}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                      <span>
                        <strong>{photo.id}</strong>
                        <small>
                          {photo.reconstruction.status} /{" "}
                          {placementLabel(photo)}
                        </small>
                        {photo.rejectionReasons.length > 0 && (
                          <small>
                            {photo.rejectionReasons.map(humanize).join(" · ")}
                          </small>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {selected && (
          <div className="city-photo-inspector" aria-live="polite">
            <p>{selected.image.alt}</p>
            <dl>
              <div>
                <dt>Calibration</dt>
                <dd>{selected.pose.calibration}</dd>
              </div>
              <div>
                <dt>Placement</dt>
                <dd>{placementLabel(selected)}</dd>
              </div>
              <div>
                <dt>Method</dt>
                <dd>
                  {selected.reconstruction.method === "image-only"
                    ? "Image-only (no file metadata)"
                    : "Metadata-assisted"}
                </dd>
              </div>
            </dl>
            {selected.reconstruction.method === "image-only" &&
              evaluationItems(selected).length > 0 && (
                <div className="city-pose-evaluation">
                  <p>
                    Post-hoc differences from embedded device metadata, not
                    survey truth.
                  </p>
                  <dl>
                    {evaluationItems(selected).map(([label, value, unit]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>
                          {value.toFixed(1)} {unit}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
          </div>
        )}
      </aside>
      <noscript>
        <style>{`
          .city-photo-drawer {
            max-height: none !important;
            visibility: visible !important;
            margin-top: 0.75rem !important;
          }
        `}</style>
        <p className="city-map-noscript">
          Maps and 3D require JavaScript. Photographs are listed above.
        </p>
        {imageOnlyPhotos && (
          <div className="city-map-noscript">
            <p>
              Image-only results are evaluated against device metadata, not
              survey measurements.
            </p>
            <ul>
              {imageOnlyPhotos.map((photo) => (
                <li key={photo.id}>
                  {photo.id}: {photo.reconstruction.status} —{" "}
                  {placementLabel(photo)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </noscript>
    </section>
  );
}
