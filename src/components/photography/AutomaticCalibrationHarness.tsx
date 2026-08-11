import { useEffect, useRef, useState } from "react";
import type { CitySceneConfig, GeoPosition } from "@/lib/photography-map/types";

type View = {
  position: GeoPosition;
  pose: { headingDeg: number; pitchDeg: number; rollDeg?: number };
  optics: { horizontalFovDeg: number; verticalFovDeg: number };
  viewport?: { width: number; height: number };
};

declare global {
  interface Window {
    __PHOTO_AUTO_CALIBRATION__?: {
      loadCity: (cityId: string) => Promise<void>;
      render: (view: View) => Promise<void>;
      pick: (points: { x: number; y: number }[]) => ({
        latitude: number;
        longitude: number;
        altitudeM: number;
      } | null)[];
      pickDepth: (points: { x: number; y: number }[]) => ({
        latitude: number;
        longitude: number;
        altitudeM: number;
      } | null)[];
      drillPickDepth: (points: { x: number; y: number }[]) => Promise<
        {
          latitude: number;
          longitude: number;
          altitudeM: number;
        }[][]
      >;
      pickDepthBeyond: (
        points: { x: number; y: number }[],
        startDistanceM: number,
      ) => Promise<
        ({
          latitude: number;
          longitude: number;
          altitudeM: number;
        } | null)[]
      >;
      size: () => { width: number; height: number };
      destroy: () => void;
    };
  }
}

export default function AutomaticCalibrationHarness({
  cities,
  googleKey,
  ionToken,
}: {
  cities: CitySceneConfig[];
  googleKey?: string;
  ionToken?: string;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<
    | InstanceType<
        (typeof import("@/lib/photography-map/controller"))["CesiumSceneController"]
      >
    | undefined
  >(undefined);
  const [status, setStatus] = useState("initializing");

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      if (!mapRef.current) return;
      const { CesiumSceneController } =
        await import("@/lib/photography-map/controller");
      if (cancelled || !mapRef.current) return;
      const controller = new CesiumSceneController(mapRef.current, {
        googleKey,
        ionToken,
        onStatus: setStatus,
      });
      controllerRef.current = controller;
      window.__PHOTO_AUTO_CALIBRATION__ = {
        loadCity: async (cityId) => {
          const city = cities.find((candidate) => candidate.id === cityId);
          if (!city) throw new Error(`Unknown calibration city: ${cityId}`);
          if (city.coverage.photorealistic === "unsupported")
            throw new Error(
              `${city.name} has no approved photorealistic reference coverage.`,
            );
          await controller.loadCity(city, [], "photorealistic");
          await controller.waitForStableFrame(12_000);
        },
        render: async (view) => {
          if (view.viewport && mapRef.current) {
            mapRef.current.style.width = `${view.viewport.width}px`;
            mapRef.current.style.height = `${view.viewport.height}px`;
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            );
          }
          controller.setCalibrationView(view.position, view.pose, view.optics);
          await controller.waitForStableFrame(3_500);
        },
        pick: (points) => controller.pickWorldPositions(points),
        pickDepth: (points) => controller.pickDepthWorldPositions(points),
        drillPickDepth: (points) =>
          controller.drillPickDepthWorldPositions(points),
        pickDepthBeyond: (points, startDistanceM) =>
          controller.pickDepthBeyondWorldPositions(points, startDistanceM),
        size: () => ({
          width: mapRef.current?.clientWidth ?? 0,
          height: mapRef.current?.clientHeight ?? 0,
        }),
        destroy: () => controller.destroy(),
      };
      document.documentElement.dataset.autoCalibrationReady = "true";
      setStatus("ready");
    }
    void initialize();
    return () => {
      cancelled = true;
      delete window.__PHOTO_AUTO_CALIBRATION__;
      controllerRef.current?.destroy();
    };
  }, [cities, googleKey, ionToken, controllerRef]);

  return (
    <main
      style={{
        margin: 0,
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "#090b09",
      }}
    >
      <div
        ref={mapRef}
        data-calibration-canvas
        style={{ width: "1280px", height: "960px" }}
      />
      <output
        aria-live="polite"
        style={{
          position: "fixed",
          left: 8,
          bottom: 8,
          zIndex: 10,
          color: "white",
          background: "#000b",
          padding: 4,
        }}
      >
        {status}
      </output>
    </main>
  );
}
