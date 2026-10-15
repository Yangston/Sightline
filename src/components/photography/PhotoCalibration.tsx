import { useEffect, useRef, useState, type MouseEvent } from "react";
import type {
  CitySceneConfig,
  PhotoSceneRecord,
  RenderingTier,
} from "@/lib/photography-map/types";
import {
  containedImagePoint,
  refineCameraFromControlPoints,
  refineOrientationFromControlPoints,
  type CalibrationControlPoint,
  type CalibrationSolution,
} from "@/lib/photography-map/calibration";
import {
  photoSceneRecordSchema,
  resolvePosition,
} from "@/lib/photography-map/schema";

type Props = {
  cities: CitySceneConfig[];
  photos: PhotoSceneRecord[];
  googleKey?: string;
  ionToken?: string;
};

type ControllerApi = {
  loadCity: (
    city: CitySceneConfig,
    photos: PhotoSceneRecord[],
    tier: RenderingTier,
  ) => Promise<void>;
  selectPhoto: (id: string) => void;
  updatePhoto: (photo: PhotoSceneRecord) => void;
  showFrustum: (id?: string) => void;
  alignToPhoto: (id?: string, duration?: number) => void;
  setTier: (tier: RenderingTier) => Promise<void>;
  pickWorldPosition: (
    clientX: number,
    clientY: number,
  ) => { latitude: number; longitude: number; altitudeM: number } | undefined;
  destroy: () => void;
};

export default function PhotoCalibration({
  cities,
  photos,
  googleKey,
  ionToken,
}: Props) {
  const [draft, setDraft] = useState<PhotoSceneRecord>(() =>
    structuredClone(photos[0]),
  );
  const [tier, setTier] = useState<RenderingTier>(draft.preferredTier);
  const [status, setStatus] = useState("Load a scene to begin calibration.");
  const [importText, setImportText] = useState("");
  const [comparison, setComparison] = useState(false);
  const [pendingImagePoint, setPendingImagePoint] = useState<
    { xPx: number; yPx: number } | undefined
  >();
  const [controlPoints, setControlPoints] = useState<CalibrationControlPoint[]>(
    [],
  );
  const [controlPointText, setControlPointText] = useState("");
  const [solution, setSolution] = useState<CalibrationSolution | undefined>();
  const [solutionMethod, setSolutionMethod] = useState<
    | "fixed-position-orientation-refinement"
    | "full-camera-refinement"
    | undefined
  >();
  const mapRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ControllerApi | undefined>(undefined);
  const city = cities.find((candidate) => candidate.id === draft.cityId)!;
  const position = resolvePosition(draft);

  useEffect(() => () => controllerRef.current?.destroy(), []);
  useEffect(() => {
    controllerRef.current?.updatePhoto(draft);
  }, [draft]);

  const load = async () => {
    if (!mapRef.current) return;
    const { CesiumSceneController } =
      await import("@/lib/photography-map/controller");
    controllerRef.current?.destroy();
    const controller = new CesiumSceneController(mapRef.current, {
      googleKey,
      ionToken,
      onStatus: setStatus,
      onTierChanged: setTier,
    });
    controllerRef.current = controller;
    await controller.loadCity(city, [draft], tier);
    controller.selectPhoto(draft.id);
  };

  const updatePosition = (
    key: "latitude" | "longitude" | "altitudeM",
    value: number,
  ) =>
    setDraft((current) => ({
      ...current,
      location: {
        ...current.location,
        corrected: { ...resolvePosition(current), [key]: value },
      },
      pose: { ...current.pose, source: "manual", calibration: "approximate" },
    }));
  const updatePose = (
    key: "headingDeg" | "pitchDeg" | "rollDeg",
    value: number,
  ) =>
    setDraft((current) => ({
      ...current,
      pose: {
        ...current.pose,
        [key]: value,
        source: "manual",
        calibration: "approximate",
      },
    }));
  const updateOptics = (
    key: "horizontalFovDeg" | "verticalFovDeg",
    value: number,
  ) =>
    setDraft((current) => ({
      ...current,
      optics: { ...current.optics, [key]: value },
    }));
  const updateRange = (key: "nearM" | "farM", value: number) =>
    setDraft((current) => ({
      ...current,
      frustum: { ...current.frustum, [key]: value },
    }));

  const exportJson = async () => {
    const parsed = photoSceneRecordSchema.parse(draft);
    const text = `${JSON.stringify(parsed, null, 2)}\n`;
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Validated pose JSON copied to clipboard.");
    } catch {
      setStatus("Clipboard unavailable; JSON download created.");
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([text], { type: "application/json" }),
    );
    link.download = `${draft.id}-pose.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    if (controlPoints.length) {
      const evidence = `${JSON.stringify(
        {
          method: solutionMethod ?? "unrefined-control-points",
          photoId: draft.id,
          rmsErrorPx: solution?.rmsErrorPx,
          controlPoints,
        },
        null,
        2,
      )}\n`;
      const evidenceLink = document.createElement("a");
      evidenceLink.href = URL.createObjectURL(
        new Blob([evidence], { type: "application/json" }),
      );
      evidenceLink.download = `${draft.id}-calibration-evidence.json`;
      evidenceLink.click();
      URL.revokeObjectURL(evidenceLink.href);
    }
  };

  const addImagePoint = (event: MouseEvent<HTMLImageElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = containedImagePoint(
      bounds.width,
      bounds.height,
      draft.image.width,
      draft.image.height,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
    );
    if (!point) {
      setStatus("Click inside the displayed photograph, not its letterbox.");
      return;
    }
    setPendingImagePoint(point);
    setComparison(false);
    setStatus("Image landmark captured. Click the same point on 3D geometry.");
  };

  const addWorldPoint = (event: MouseEvent<HTMLDivElement>) => {
    if (!pendingImagePoint) return;
    const world = controllerRef.current?.pickWorldPosition(
      event.clientX,
      event.clientY,
    );
    if (!world) {
      setStatus("No rendered geometry was available at that map point.");
      return;
    }
    setControlPoints((current) => [
      ...current,
      { image: pendingImagePoint, world },
    ]);
    setPendingImagePoint(undefined);
    setSolution(undefined);
    setSolutionMethod(undefined);
    setStatus(
      "Control point paired. One landmark can refine orientation; full pose needs at least four, with six or more preferred.",
    );
  };

  const refineOrientationFromPoints = () => {
    try {
      const refined = refineOrientationFromControlPoints(
        {
          position,
          headingDeg: draft.pose.headingDeg ?? 0,
          pitchDeg: draft.pose.pitchDeg ?? 0,
          rollDeg: draft.pose.rollDeg ?? 0,
          horizontalFovDeg: draft.optics.horizontalFovDeg,
          verticalFovDeg: draft.optics.verticalFovDeg,
          imageWidth: draft.image.width,
          imageHeight: draft.image.height,
        },
        controlPoints,
      );
      setSolution(refined);
      setSolutionMethod("fixed-position-orientation-refinement");
      setDraft((current) => ({
        ...current,
        pose: {
          ...current.pose,
          headingDeg: refined.headingDeg,
          pitchDeg: refined.pitchDeg,
          source: "computer-vision",
          confidence: controlPoints.length >= 2 ? 0.82 : 0.72,
          calibration: "approximate",
        },
      }));
      setStatus(
        `Refined heading and pitch from ${controlPoints.length} fixed-position landmark${controlPoints.length === 1 ? "" : "s"}: ${refined.rmsErrorPx.toFixed(1)} px RMS. Full pose remains approximate.`,
      );
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Orientation refinement failed.",
      );
    }
  };

  const refineFromPoints = () => {
    try {
      const refined = refineCameraFromControlPoints(
        {
          position,
          headingDeg: draft.pose.headingDeg ?? 0,
          pitchDeg: draft.pose.pitchDeg ?? 0,
          rollDeg: draft.pose.rollDeg ?? 0,
          horizontalFovDeg: draft.optics.horizontalFovDeg,
          verticalFovDeg: draft.optics.verticalFovDeg,
          imageWidth: draft.image.width,
          imageHeight: draft.image.height,
        },
        controlPoints,
        {
          horizontalPriorSigmaM: draft.location.horizontalAccuracyM ?? 12,
          altitudePriorSigmaM: Math.max(
            15,
            (draft.location.horizontalAccuracyM ?? 12) * 1.5,
          ),
        },
      );
      setSolution(refined);
      setSolutionMethod("full-camera-refinement");
      setDraft((current) => ({
        ...current,
        location: { ...current.location, corrected: refined.position },
        pose: {
          ...current.pose,
          headingDeg: refined.headingDeg,
          pitchDeg: refined.pitchDeg,
          rollDeg: refined.rollDeg,
          source: "computer-vision",
          confidence: refined.rmsErrorPx <= 8 ? 0.9 : 0.7,
          calibration: refined.rmsErrorPx <= 8 ? "calibrated" : "approximate",
        },
        optics: {
          ...current.optics,
          horizontalFovDeg: refined.horizontalFovDeg,
          verticalFovDeg: refined.verticalFovDeg,
        },
      }));
      setStatus(
        `Refined from ${controlPoints.length} pairs: ${refined.rmsErrorPx.toFixed(1)} px RMS reprojection error.`,
      );
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Pose refinement failed.",
      );
    }
  };

  const importControlPoints = () => {
    try {
      const imported = JSON.parse(controlPointText) as unknown;
      const candidate =
        imported instanceof Array
          ? imported
          : imported &&
              typeof imported === "object" &&
              "controlPoints" in imported
            ? (imported as { controlPoints: unknown }).controlPoints
            : undefined;
      if (
        !(candidate instanceof Array) ||
        !candidate.every(
          (point) =>
            point &&
            typeof point === "object" &&
            "image" in point &&
            "world" in point &&
            typeof (point as CalibrationControlPoint).image?.xPx === "number" &&
            typeof (point as CalibrationControlPoint).image?.yPx === "number" &&
            typeof (point as CalibrationControlPoint).world?.latitude ===
              "number" &&
            typeof (point as CalibrationControlPoint).world?.longitude ===
              "number" &&
            typeof (point as CalibrationControlPoint).world?.altitudeM ===
              "number",
        )
      )
        throw new Error("Expected an array of image/world control points.");
      setControlPoints(candidate as CalibrationControlPoint[]);
      setPendingImagePoint(undefined);
      setSolution(undefined);
      setSolutionMethod(undefined);
      setStatus(`Imported ${candidate.length} control-point pairs.`);
    } catch (error) {
      setStatus(
        `Invalid control points: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  };

  const importJson = () => {
    try {
      const parsed = photoSceneRecordSchema.parse(JSON.parse(importText));
      setDraft(parsed);
      setTier(parsed.preferredTier);
      setStatus("Pose JSON imported and validated.");
    } catch (error) {
      setStatus(
        `Invalid pose JSON: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  };

  return (
    <main className="calibration-page">
      <header>
        <p className="eyebrow">Development tool / Not published</p>
        <h1>Camera pose calibration.</h1>
        <p>
          Adjust the camera against available geometry, compare from outside the
          frustum and from the original point of view, then export a validated
          record.
        </p>
      </header>
      <div className="calibration-layout">
        <form
          onSubmit={(event) => event.preventDefault()}
          className="calibration-controls"
        >
          <label>
            Photo
            <select
              value={draft.id}
              onChange={(event) => {
                const next = photos.find(
                  (photo) => photo.id === event.target.value,
                )!;
                setDraft(structuredClone(next));
                setTier(next.preferredTier);
                setComparison(false);
                setPendingImagePoint(undefined);
                setControlPoints([]);
                setControlPointText("");
                setSolution(undefined);
                setSolutionMethod(undefined);
              }}
            >
              {photos.map((photo) => (
                <option key={photo.id} value={photo.id}>
                  {photo.id} — {photo.cityId}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>Position / WGS84</legend>
            <NumberField
              label="Latitude"
              value={position.latitude}
              step={0.000001}
              onChange={(value) => updatePosition("latitude", value)}
            />
            <NumberField
              label="Longitude"
              value={position.longitude}
              step={0.000001}
              onChange={(value) => updatePosition("longitude", value)}
            />
            <NumberField
              label="Altitude m"
              value={position.altitudeM}
              step={0.1}
              onChange={(value) => updatePosition("altitudeM", value)}
            />
            <p className="calibration-evidence-note">
              Resolved ellipsoid altitude {position.altitudeM.toFixed(2)} m.
              {draft.location.originalAltitudeReference === "mean-sea-level" &&
                draft.location.original &&
                ` Original EXIF ${draft.location.original.altitudeM.toFixed(2)} m above sea level; EGM96 ${draft.location.geoidUndulationM?.toFixed(2)} m.`}
              {draft.location.horizontalAccuracyM !== undefined &&
                ` GPS horizontal accuracy +/-${draft.location.horizontalAccuracyM.toFixed(1)} m.`}
            </p>
          </fieldset>
          <fieldset>
            <legend>Orientation / degrees</legend>
            <NumberField
              label="Heading"
              value={draft.pose.headingDeg ?? 0}
              step={0.1}
              onChange={(value) => updatePose("headingDeg", value)}
            />
            <NumberField
              label="Pitch"
              value={draft.pose.pitchDeg ?? 0}
              step={0.1}
              onChange={(value) => updatePose("pitchDeg", value)}
            />
            <NumberField
              label="Roll"
              value={draft.pose.rollDeg ?? 0}
              step={0.1}
              onChange={(value) => updatePose("rollDeg", value)}
            />
          </fieldset>
          <fieldset>
            <legend>Optics and range</legend>
            <NumberField
              label="Horizontal FOV"
              value={draft.optics.horizontalFovDeg}
              step={0.1}
              onChange={(value) => updateOptics("horizontalFovDeg", value)}
            />
            <NumberField
              label="Vertical FOV"
              value={draft.optics.verticalFovDeg}
              step={0.1}
              onChange={(value) => updateOptics("verticalFovDeg", value)}
            />
            <NumberField
              label="Near m"
              value={draft.frustum.nearM}
              step={0.1}
              onChange={(value) => updateRange("nearM", value)}
            />
            <NumberField
              label="Far m"
              value={draft.frustum.farM}
              step={1}
              onChange={(value) => updateRange("farM", value)}
            />
          </fieldset>
          <label>
            Provider tier
            <select
              value={tier}
              onChange={(event) => {
                const next = event.target.value as RenderingTier;
                setTier(next);
                void controllerRef.current?.setTier(next);
              }}
            >
              {(
                [
                  "photorealistic",
                  "osm-buildings",
                  "terrain",
                  "marker",
                ] as RenderingTier[]
              ).map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="calibration-check">
            <input
              type="checkbox"
              checked={draft.highlight.approved}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  highlight: {
                    mode: event.target.checked ? "projective-texture" : "off",
                    approved: event.target.checked,
                  },
                }))
              }
            />{" "}
            Approve projective photo texture
          </label>
          <div className="calibration-actions">
            <button onClick={() => void load()}>Load / verify provider</button>
            <button
              onClick={() => controllerRef.current?.showFrustum(draft.id)}
            >
              Outside view
            </button>
            <button
              onClick={() => {
                controllerRef.current?.alignToPhoto(draft.id, 0);
                setComparison(false);
              }}
            >
              Camera POV
            </button>
            <button
              aria-pressed={comparison}
              onClick={() => {
                controllerRef.current?.alignToPhoto(draft.id, 0);
                setComparison((current) => !current);
              }}
            >
              {comparison ? "Hide overlay" : "Compare overlay"}
            </button>
            <button onClick={() => void exportJson()}>Export JSON</button>
          </div>
          <fieldset>
            <legend>2D-to-3D control points</legend>
            <p>
              Click a stable corner in the reference photo, then the same corner
              in rendered 3D geometry. Spread points across depth and the image;
              avoid sky, foliage, vehicles, and coplanar-only sets.
            </p>
            <div className="calibration-actions">
              <button
                disabled={!controlPoints.length}
                onClick={refineOrientationFromPoints}
              >
                Refine orientation from {controlPoints.length} pair
                {controlPoints.length === 1 ? "" : "s"}
              </button>
              <button
                disabled={controlPoints.length < 4}
                onClick={refineFromPoints}
              >
                Refine from {controlPoints.length} pairs
              </button>
              <button
                disabled={!controlPoints.length}
                onClick={() => {
                  setControlPoints([]);
                  setPendingImagePoint(undefined);
                  setSolution(undefined);
                  setSolutionMethod(undefined);
                }}
              >
                Clear pairs
              </button>
            </div>
            {solution && <p>RMS error: {solution.rmsErrorPx.toFixed(1)} px</p>}
            <label>
              Import control-point array or evidence JSON
              <textarea
                value={controlPointText}
                onChange={(event) => setControlPointText(event.target.value)}
                rows={4}
              />
            </label>
            <button onClick={importControlPoints}>
              Validate control points
            </button>
          </fieldset>
          <label>
            Import corrected JSON
            <textarea
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              rows={5}
            />
          </label>
          <button onClick={importJson}>Validate import</button>
          <p aria-live="polite">{status}</p>
        </form>
        <div className="calibration-stage">
          <div
            className={`calibration-map ${pendingImagePoint ? "is-pairing" : ""}`}
            onClick={addWorldPoint}
          >
            <div ref={mapRef} />
            {comparison && (
              <img
                src={draft.image.url}
                alt=""
                aria-hidden="true"
                onClick={(event) => {
                  event.stopPropagation();
                  addImagePoint(event);
                }}
              />
            )}
          </div>
          <figure>
            <img
              src={draft.image.url}
              alt={draft.image.alt}
              onClick={addImagePoint}
            />
            <figcaption>{draft.image.alt}</figcaption>
          </figure>
        </div>
      </div>
    </main>
  );
}

function NumberField({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        step={step}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
    </label>
  );
}
