import { useEffect, useMemo, useRef, useState } from "react";
import {
  groupPhotoMarkers,
  photoReviewCategory,
  photoReviewLabel,
} from "@/lib/photography-map/presentation";
import { projectStaticMapPosition } from "@/lib/photography-map/static-map";
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
  staticMapUrl?: string;
  viewport: StaticMapViewport;
  googleKey?: string;
};

type CameraAction = "frustum" | "camera" | "comparison" | "enter";

type ControllerApi = {
  loadCity: (
    city: CitySceneConfig,
    photos: PhotoSceneRecord[],
    tier: "photorealistic",
  ) => Promise<void>;
  selectPhoto: (id: string) => void;
  showFrustum: (id?: string) => void;
  hideFrustum: () => void;
  alignToPhoto: (id?: string, duration?: number) => void;
  enterPhoto: (id?: string, duration?: number) => void;
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
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
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
    ["Heading", evaluation.headingErrorDeg, "Â°"],
    ["Pitch", evaluation.pitchErrorDeg, "Â°"],
    ["Roll", evaluation.rollErrorDeg, "Â°"],
    ["FOV", evaluation.horizontalFovErrorDeg, "Â°"],
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
  staticMapUrl,
  viewport,
  googleKey,
}: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ControllerApi | undefined>(undefined);
  const scenePayloadRef = useRef<CityScenePayload | undefined>(undefined);
  const drawerToggleRef = useRef<HTMLButtonElement>(null);
  const [hydrated, setHydrated] = useState(false);
  const [selectedId, setSelectedId] = useState(photos[0]?.id ?? null);
  const [reconstructionMethod, setReconstructionMethod] =
    useState<ReconstructionMethod>("metadata-assisted");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mode, setMode] = useState<MapMode>("2d");
  const [loading3d, setLoading3d] = useState(false);
  const [staticImageFailed, setStaticImageFailed] = useState(false);
  const [status, setStatus] = useState(
    staticMapUrl
      ? "Satellite map ready. Photorealistic 3D loads only when requested."
      : "Satellite imagery is unavailable. The photo index and gallery remain available.",
  );
  const [frustumVisible, setFrustumVisible] = useState(false);
  const [comparison, setComparison] = useState(false);
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

  useEffect(() => {
    const restoreFromUrl = () => {
      const requested = new URLSearchParams(location.search).get("photo");
      const requestedMethod = new URLSearchParams(location.search).get(
        "reconstruction",
      );
      const method =
        requestedMethod === "image-only" && imageOnlyPhotos
          ? "image-only"
          : "metadata-assisted";
      setReconstructionMethod(method);
      if (requested && activePhotos.some((photo) => photo.id === requested)) {
        setSelectedId(requested);
        setDrawerOpen(true);
        controllerRef.current?.selectPhoto(requested);
      }
    };
    const hydrationFrame = requestAnimationFrame(() => {
      setHydrated(true);
      restoreFromUrl();
    });
    window.addEventListener("popstate", restoreFromUrl);
    return () => {
      cancelAnimationFrame(hydrationFrame);
      window.removeEventListener("popstate", restoreFromUrl);
      controllerRef.current?.destroy();
    };
  }, [activePhotos, imageOnlyPhotos]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !drawerOpen) return;
      setDrawerOpen(false);
      drawerToggleRef.current?.focus();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [drawerOpen]);

  function selectPhoto(id: string) {
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
    controllerRef.current?.destroy();
    controllerRef.current = undefined;
    setMode("2d");
    setLoading3d(false);
    setFrustumVisible(false);
    setComparison(false);
    setStatus(
      message ??
        "Satellite map ready. Photorealistic 3D loads only when requested.",
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

  async function loadSceneRecords(method = reconstructionMethod) {
    if (scenePayloadRef.current)
      return recordsForMethod(scenePayloadRef.current, method);
    const response = await fetch(sceneUrl, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok)
      throw new Error(`Scene request failed (${response.status}).`);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("variants" in payload))
      throw new Error("Scene response is invalid.");
    const scenePayload = payload as CityScenePayload;
    scenePayloadRef.current = scenePayload;
    const records = recordsForMethod(scenePayload, method);
    setScenePhotos(records);
    return records;
  }

  function switchReconstruction(method: ReconstructionMethod) {
    if (method === reconstructionMethod) return;
    setReconstructionMethod(method);
    setFrustumVisible(false);
    setComparison(false);
    const url = new URL(location.href);
    if (method === "image-only")
      url.searchParams.set("reconstruction", "image-only");
    else url.searchParams.delete("reconstruction");
    history.replaceState({}, "", url);
    if (scenePayloadRef.current) {
      const records = recordsForMethod(scenePayloadRef.current, method);
      setScenePhotos(records);
      controllerRef.current?.replacePhotos(records);
      if (selectedId) controllerRef.current?.selectPhoto(selectedId);
    }
    setStatus(
      method === "image-only"
        ? "Showing image-only pose reconstruction. Embedded metadata is used only for the displayed error evaluation."
        : "Showing the metadata-assisted reconstruction.",
    );
  }

  async function openThreeD(action?: CameraAction) {
    if (loading3d || mode === "3d") return;
    if (!hasWebGl()) {
      setStatus("WebGL is unavailable. The satellite map remains active.");
      return;
    }
    const saveData = Boolean(
      (navigator as Navigator & { connection?: { saveData?: boolean } })
        .connection?.saveData,
    );
    if (saveData) {
      setStatus(
        "3D is paused by your reduced-data preference. The satellite map remains active.",
      );
      return;
    }
    if (!googleKey) {
      setStatus(
        "Photorealistic 3D is unavailable because the map credential is missing.",
      );
      return;
    }

    setLoading3d(true);
    setMode("3d");
    setStatus("Loading Google photorealistic 3D…");
    const resources = Promise.all([
      import("@/lib/photography-map/controller"),
      loadSceneRecords(),
    ]);
    try {
      if (!mapRef.current) throw new Error("The 3D map shell is unavailable.");
      await waitForLayout(mapRef.current);
      const [{ CesiumSceneController }, fullPhotos] = await resources;
      const controller = new CesiumSceneController(mapRef.current, {
        googleKey,
        mobile: matchMedia("(max-width: 700px)").matches,
        allowTierFallback: false,
        onPhotoSelected: selectPhoto,
        onStatus: setStatus,
        onFatalError: () =>
          returnToTwoD(
            "Photorealistic 3D stopped. The satellite map is active again.",
          ),
      });
      controllerRef.current = controller;
      await controller.loadCity(city, fullPhotos, "photorealistic");
      if (selectedId) controller.selectPhoto(selectedId);
      if (selectedId && action === "frustum") {
        controller.showFrustum(selectedId);
        setFrustumVisible(true);
      }
      if (selectedId && action === "camera")
        controller.alignToPhoto(selectedId, reduced ? 0 : 900);
      if (selectedId && action === "comparison") {
        controller.alignToPhoto(selectedId, reduced ? 0 : 900);
        setComparison(true);
      }
      if (selectedId && action === "enter")
        controller.enterPhoto(selectedId, reduced ? 0 : 900);
    } catch (error) {
      console.error("The optional 3D photography map could not start.", error);
      returnToTwoD(
        "Photorealistic 3D could not start. The satellite map is active again.",
      );
    } finally {
      setLoading3d(false);
    }
  }

  function runThreeDAction(action: CameraAction) {
    if (mode !== "3d" || !controllerRef.current) {
      void openThreeD(action);
      return;
    }
    if (!selectedId) return;
    if (action === "frustum") {
      if (frustumVisible) controllerRef.current.hideFrustum();
      else controllerRef.current.showFrustum(selectedId);
      setFrustumVisible((current) => !current);
    }
    if (action === "camera")
      controllerRef.current.alignToPhoto(selectedId, reduced ? 0 : 900);
    if (action === "enter")
      controllerRef.current.enterPhoto(selectedId, reduced ? 0 : 900);
    if (action === "comparison") {
      if (!comparison)
        controllerRef.current.alignToPhoto(selectedId, reduced ? 0 : 900);
      setComparison((current) => !current);
    }
  }

  return (
    <section
      className="city-atlas"
      aria-labelledby="city-atlas-title"
      data-city-map-experience
      data-city-map-mode={mode}
      data-reconstruction-method={reconstructionMethod}
    >
      <header className="city-atlas-heading">
        <div>
          <p className="eyebrow">City field / {photos.length} frames</p>
          <h1 id="city-atlas-title">{city.name}</h1>
          <p>{city.description}</p>
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
            {loading3d ? "Opening 3D…" : "3D photorealistic"}
          </button>
          <button
            ref={drawerToggleRef}
            type="button"
            aria-expanded={drawerOpen}
            aria-controls="city-photo-drawer"
            onClick={() => setDrawerOpen((current) => !current)}
            disabled={!hydrated}
          >
            {drawerOpen ? "Close photo index" : "Open photo index"}
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
        {status}
      </p>
      <div className="city-atlas-stage">
        <div className="city-satellite-map" hidden={mode !== "2d"}>
          {staticMapUrl && !staticImageFailed ? (
            <>
              <img
                src={staticMapUrl}
                width="640"
                height="480"
                alt={`Satellite map of ${city.name}`}
                loading="eager"
                decoding="async"
                fetchPriority="high"
                onError={() => {
                  setStaticImageFailed(true);
                  setStatus(
                    "Satellite imagery could not load. The photo index and gallery remain available.",
                  );
                }}
              />
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
            </>
          ) : (
            <p className="city-map-unavailable">
              Satellite imagery is unavailable. Use the photo index or gallery
              below.
            </p>
          )}
        </div>
        <div
          ref={mapRef}
          className="city-map-canvas"
          aria-label={`Google photorealistic 3D map of ${city.name}`}
          hidden={mode !== "3d"}
        />
        {comparison && selectedScene && (
          <img
            className="city-map-camera-comparison"
            src={selectedScene.image.url}
            alt=""
            aria-hidden="true"
          />
        )}
      </div>
      {selected && (
        <div
          className="city-photo-view-controls"
          aria-label={`3D view controls for ${selected.id}`}
        >
          <span>{selected.id}</span>
          <button
            type="button"
            aria-pressed={frustumVisible}
            disabled={!selected.capabilities.frustum || loading3d}
            onClick={() => runThreeDAction("frustum")}
          >
            {frustumVisible ? "Hide frustum" : "View camera frustum"}
          </button>
          <button
            type="button"
            disabled={!selected.capabilities.comparison || loading3d}
            onClick={() => runThreeDAction("camera")}
          >
            Match camera
          </button>
          <button
            type="button"
            aria-pressed={comparison}
            disabled={!selected.capabilities.comparison || loading3d}
            onClick={() => runThreeDAction("comparison")}
          >
            {comparison ? "Hide comparison" : "Compare photo"}
          </button>
          <button
            type="button"
            disabled={!selected.capabilities.comparison || loading3d}
            onClick={() => runThreeDAction("enter")}
          >
            Enter camera
          </button>
        </div>
      )}
      <aside
        id="city-photo-drawer"
        className="city-photo-drawer"
        data-open={drawerOpen ? "true" : "false"}
        aria-label={`${city.name} photo review index`}
      >
        <header>
          <p>Photo review index</p>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
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
          The satellite view, review index, and gallery remain available without
          JavaScript. 3D is optional.
        </p>
        {imageOnlyPhotos && (
          <div className="city-map-noscript">
            <p>
              San Francisco also has an image-only experiment. Its results are
              compared after sealing against embedded device metadata; those
              differences are not survey truth.
            </p>
            <ul>
              {imageOnlyPhotos.map((photo) => (
                <li key={photo.id}>
                  {photo.id}: {photo.reconstruction.status} â€”{" "}
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
