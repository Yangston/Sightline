import { readPhotoMetadata, type PhotoMetadata } from "./metadata";
import { createUploadScene } from "./scene";
import type { CitySceneConfig } from "../photography-map/types";
import type { CesiumSceneController } from "../photography-map/controller";

type PreparedScene = ReturnType<typeof createUploadScene>;
type PoseKey = "headingDeg" | "pitchDeg" | "rollDeg" | "horizontalFovDeg";

class PhotoUpload extends HTMLElement {
  private cities: CitySceneConfig[] = [];
  private metadata: PhotoMetadata = {};
  private image?: { url: string; width: number; height: number };
  private prepared?: PreparedScene;
  private initial?: PreparedScene;
  private controller?: CesiumSceneController;
  private generation = 0;
  private viewerGeneration = 0;
  private aligned = false;
  private initialized = false;
  private cleanupEvents = new AbortController();
  private resize?: ResizeObserver;

  private element<T extends HTMLElement>(selector: string) {
    return this.querySelector<T>(selector)!;
  }

  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;
    this.cities = JSON.parse(
      this.element("[data-upload-cities]").textContent ?? "[]",
    );
    const file = this.element<HTMLInputElement>("#upload-file");
    file.disabled = false;
    const listen = (
      element: EventTarget,
      event: string,
      callback: EventListener,
    ) =>
      element.addEventListener(event, callback, {
        signal: this.cleanupEvents.signal,
      });
    listen(file, "change", () => {
      if (file.files?.[0]) void this.readFile(file.files[0]);
    });
    const dropzone = this.element("[data-upload-dropzone]");
    listen(dropzone, "dragover", (event) => {
      event.preventDefault();
      dropzone.dataset.dragging = "true";
    });
    listen(dropzone, "dragleave", () => {
      delete dropzone.dataset.dragging;
    });
    listen(dropzone, "drop", (event) => {
      event.preventDefault();
      delete dropzone.dataset.dragging;
      const files = (event as DragEvent).dataTransfer?.files;
      if (files?.length !== 1)
        this.status("Choose one photograph at a time.", true);
      else void this.readFile(files[0]);
    });
    listen(this.element("[data-upload-reset]"), "click", () => {
      this.reset();
      file.focus();
    });
    listen(this.element("[data-upload-close]"), "click", () => {
      this.closeViewer();
      this.element("[data-upload-open]").focus();
    });
    listen(
      this.element("[data-upload-open]"),
      "click",
      () => void this.openViewer(),
    );
    listen(this.element("[data-upload-orbit]"), "click", () =>
      this.setView(false),
    );
    listen(this.element("[data-upload-align]"), "click", () =>
      this.setView(true),
    );
    listen(this.element("[data-upload-pose-reset]"), "click", () => {
      if (!this.initial) return;
      this.prepared = structuredClone(this.initial);
      this.syncControls();
      this.updateCamera();
    });
    listen(this.element("#upload-city-select"), "change", () => {
      const id = this.element<HTMLSelectElement>("#upload-city-select").value;
      const city = this.cities.find((item) => item.id === id);
      if (!city) return;
      this.element<HTMLInputElement>("#upload-latitude").value = String(
        city.center.latitude,
      );
      this.element<HTMLInputElement>("#upload-longitude").value = String(
        city.center.longitude,
      );
      this.element<HTMLInputElement>("#upload-altitude").value = String(
        city.center.altitudeM,
      );
      this.status(
        "City centre selected. Adjust the coordinates to your camera position, then prepare the scene.",
      );
    });
    listen(this.element("[data-upload-manual]"), "submit", (event) => {
      event.preventDefault();
      if (!this.image) return;
      const latitude =
        this.element<HTMLInputElement>("#upload-latitude").valueAsNumber;
      const longitude =
        this.element<HTMLInputElement>("#upload-longitude").valueAsNumber;
      const height =
        this.element<HTMLInputElement>("#upload-altitude").valueAsNumber;
      try {
        const prepared = createUploadScene(
          this.metadata,
          this.image,
          this.cities,
          {
            latitude,
            longitude,
            ...(Number.isFinite(height) ? { altitudeM: height } : {}),
          },
        );
        this.closeViewer();
        this.acceptScene(prepared, true);
        this.status(
          "Location updated. Your approximate camera scene is ready to open in 3D.",
        );
      } catch (error) {
        this.status(
          error instanceof Error
            ? error.message
            : "Check the coordinates and try again.",
          true,
        );
      }
    });
    for (const control of this.querySelectorAll<HTMLInputElement>(
      "[data-upload-pose]",
    )) {
      listen(control, "input", () => {
        if (!this.prepared) return;
        const key = control.dataset.uploadPose as PoseKey;
        const value = control.valueAsNumber;
        if (!Number.isFinite(value)) return;
        if (key === "horizontalFovDeg") {
          this.prepared.photo.optics.horizontalFovDeg = value;
          this.prepared.photo.optics.verticalFovDeg =
            (Math.atan(
              (Math.tan((value * Math.PI) / 360) *
                this.prepared.photo.image.height) /
                this.prepared.photo.image.width,
            ) *
              360) /
            Math.PI;
        } else this.prepared.photo.pose[key] = value;
        this.prepared.photo.pose.source = "manual";
        this.syncControls();
        this.updateCamera();
      });
    }
    listen(this.element("#upload-opacity"), "input", () => {
      const value =
        this.element<HTMLInputElement>("#upload-opacity").valueAsNumber;
      this.element("[data-upload-overlay]").style.opacity = String(value / 100);
      this.element("[data-upload-opacity-output]").textContent = `${value}%`;
    });
    listen(window, "pagehide", () => this.reset());
  }

  disconnectedCallback() {
    this.dispose();
    this.cleanupEvents.abort();
  }

  private status(message: string, error = false) {
    const status = this.element("[data-upload-status]");
    status.textContent = message;
    status.toggleAttribute("data-error", error);
  }

  private reset() {
    this.generation += 1;
    this.dispose();
    this.metadata = {};
    this.prepared = undefined;
    this.initial = undefined;
    this.setView(false);
    this.element<HTMLInputElement>("#upload-opacity").value = "50";
    this.element("[data-upload-opacity-output]").textContent = "50%";
    this.element("[data-upload-overlay]").style.opacity = "0.5";
    this.element<HTMLButtonElement>("[data-upload-open]").disabled = true;
    this.element("[data-upload-result]").hidden = true;
    this.element<HTMLInputElement>("#upload-file").value = "";
    this.element<HTMLFormElement>("[data-upload-manual]").reset();
    this.element<HTMLImageElement>("[data-upload-image]").removeAttribute(
      "src",
    );
    this.element<HTMLImageElement>("[data-upload-overlay]").removeAttribute(
      "src",
    );
    this.status("Photo removed from this tab. Choose a photograph to begin.");
  }

  private dispose() {
    this.closeViewer();
    if (this.image) URL.revokeObjectURL(this.image.url);
    this.image = undefined;
  }

  private async readFile(file: File) {
    this.reset();
    const generation = ++this.generation;
    if (
      !/\.(jpe?g|png|webp)$/i.test(file.name) &&
      !/^image\/(jpeg|png|webp)$/.test(file.type)
    ) {
      this.status(
        "Choose a JPEG, PNG or WebP photograph. Export HEIC or RAW files as JPEG with location metadata included.",
        true,
      );
      return;
    }
    if (!file.size || file.size > 40 * 1024 * 1024) {
      this.status("Choose a non-empty photograph smaller than 40 MB.", true);
      return;
    }
    this.status("Reading the photograph on your device…");
    const url = URL.createObjectURL(file);
    try {
      const [buffer, dimensions] = await Promise.all([
        file.arrayBuffer(),
        new Promise<{ width: number; height: number }>((resolve, reject) => {
          const image = new Image();
          image.onload = () =>
            resolve({ width: image.naturalWidth, height: image.naturalHeight });
          image.onerror = () =>
            reject(
              new Error(
                "This file could not be displayed. Try exporting it as a JPEG.",
              ),
            );
          image.src = url;
        }),
      ]);
      if (generation !== this.generation) {
        URL.revokeObjectURL(url);
        return;
      }
      if (!dimensions.width || !dimensions.height)
        throw new Error("This photograph has no readable image dimensions.");
      this.metadata = readPhotoMetadata(buffer);
      this.image = { url, ...dimensions };
      this.element<HTMLImageElement>("[data-upload-image]").src = url;
      this.element<HTMLImageElement>("[data-upload-overlay]").src = url;
      this.element("[data-upload-filename]").textContent =
        `${file.name} · ${dimensions.width.toLocaleString()} × ${dimensions.height.toLocaleString()}`;
      this.element("[data-upload-result]").hidden = false;
      this.element("[data-upload-lens]").textContent = this.metadata
        .focalLength35Mm
        ? `${this.metadata.focalLength35Mm} mm equivalent · from metadata`
        : "28 mm equivalent · starting estimate";
      this.element("[data-upload-direction]").textContent =
        this.metadata.headingReference === "T" &&
        this.metadata.headingDeg !== undefined
          ? `${Math.round(this.metadata.headingDeg)}° · true north, from metadata`
          : this.metadata.headingReference === "M"
            ? "Magnetic bearing found · set direction in 3D"
            : "Not recorded · set direction in 3D";
      if (
        this.metadata.latitude !== undefined &&
        this.metadata.longitude !== undefined
      ) {
        this.acceptScene(
          createUploadScene(this.metadata, this.image, this.cities),
        );
        this.status(
          "Location found. Your camera draft and scene are ready; open 3D when you’re ready.",
        );
      } else {
        this.element("[data-upload-city]").textContent =
          "A location is needed.";
        this.element("[data-upload-gps]").textContent =
          "No GPS coordinates in this file";
        this.element("[data-upload-explanation]").textContent =
          "Shared or edited photos often lose their location. Choose a city or enter the camera coordinates below to prepare your scene.";
        this.element("[data-upload-collection]").hidden = true;
        this.element<HTMLDetailsElement>(
          "[data-upload-location-details]",
        ).open = true;
        this.status(
          "Photo ready. No GPS metadata was found; add a location below to continue.",
        );
      }
    } catch (error) {
      URL.revokeObjectURL(url);
      if (generation !== this.generation) return;
      this.reset();
      this.status(
        error instanceof Error
          ? error.message
          : "The photograph could not be read. Try another file.",
        true,
      );
    }
  }

  private acceptScene(prepared: PreparedScene, manual = false) {
    this.prepared = prepared;
    this.initial = structuredClone(prepared);
    const position = prepared.photo.location.original!;
    this.element("[data-upload-city]").textContent = prepared.city.name;
    this.element("[data-upload-gps]").textContent =
      `${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)} · ${manual ? "entered location" : "from metadata"}`;
    this.element("[data-upload-explanation]").textContent =
      `${prepared.matchedCity ? "Location matched to a featured city." : "Outside the featured city areas; the preview will use your coordinates."} A camera frustum is prepared from the available metadata. Tilt, roll and height still need review; this is not a solved or verified pose.`;
    const collection = this.element<HTMLAnchorElement>(
      "[data-upload-collection]",
    );
    collection.hidden = !prepared.matchedCity;
    if (prepared.matchedCity) collection.href = `/explore/${prepared.city.id}`;
    this.element<HTMLInputElement>("#upload-latitude").value = String(
      position.latitude,
    );
    this.element<HTMLInputElement>("#upload-longitude").value = String(
      position.longitude,
    );
    this.element<HTMLInputElement>("#upload-altitude").value = String(
      position.altitudeM,
    );
    this.element<HTMLSelectElement>("#upload-city-select").value =
      prepared.matchedCity?.id ?? "";
    this.element<HTMLDetailsElement>("[data-upload-location-details]").open =
      false;
    this.element<HTMLButtonElement>("[data-upload-open]").disabled = false;
    this.syncControls();
  }

  private syncControls() {
    if (!this.prepared) return;
    for (const control of this.querySelectorAll<HTMLInputElement>(
      "[data-upload-pose]",
    )) {
      const key = control.dataset.uploadPose as PoseKey;
      const value =
        key === "horizontalFovDeg"
          ? this.prepared.photo.optics.horizontalFovDeg
          : (this.prepared.photo.pose[key] ?? 0);
      control.value = String(value);
      this.element(`[data-upload-output="${key}"]`).textContent =
        `${Math.round(value * 10) / 10}°`;
    }
  }

  private closeViewer() {
    this.viewerGeneration += 1;
    this.resize?.disconnect();
    this.resize = undefined;
    this.controller?.destroy();
    this.controller = undefined;
    this.element("[data-upload-viewer]").hidden = true;
    this.element<HTMLButtonElement>("[data-upload-open]").disabled =
      !this.prepared;
  }

  private async openViewer() {
    if (!this.prepared) return;
    this.closeViewer();
    const generation = ++this.viewerGeneration;
    const current = () =>
      generation === this.viewerGeneration && this.isConnected;
    const status = this.element("[data-upload-viewer-status]");
    this.element<HTMLButtonElement>("[data-upload-open]").disabled = true;
    this.element("[data-upload-viewer]").hidden = false;
    status.textContent = "Opening the 3D workspace…";
    const fail = () => {
      if (!current()) return;
      this.closeViewer();
      this.status(
        "The 3D preview could not start on this device. Your photo and camera draft are still ready; try opening 3D again.",
        true,
      );
      this.element("[data-upload-open]").focus();
    };
    try {
      const { CesiumSceneController } =
        await import("../photography-map/controller");
      if (!current() || !this.prepared) return;
      const controller = new CesiumSceneController(
        this.element("[data-upload-canvas]"),
        {
          googleKey: this.dataset.googleKey,
          ionToken: this.dataset.ionToken,
          mobile: matchMedia("(max-width: 720px)").matches,
          onStatus: (message) => {
            if (current()) status.textContent = message;
          },
          onTierChanged: (tier) => {
            if (current()) status.dataset.tier = tier;
          },
          onFatalError: fail,
        },
      );
      this.controller = controller;
      const tier = this.dataset.googleKey
        ? "photorealistic"
        : this.dataset.ionToken
          ? "osm-buildings"
          : "marker";
      await controller.loadCity(
        this.prepared.city,
        [this.prepared.photo],
        tier,
      );
      if (!current()) {
        controller.destroy();
        return;
      }
      this.setView(false);
      const actualTier = status.dataset.tier;
      status.textContent =
        actualTier === "photorealistic"
          ? "3D scene ready. Orbit the camera frustum, or match the photograph to adjust alignment."
          : actualTier === "osm-buildings"
            ? "Building geometry ready. Use the frustum and photo overlay to inspect your draft camera."
            : "Basic preview ready. Detailed buildings are unavailable; the frustum shows the draft camera geometry only.";
      this.resize = new ResizeObserver(() => {
        if (this.aligned && this.prepared && this.controller)
          this.controller.alignToPhoto(this.prepared.photo.id, 0);
      });
      this.resize.observe(this.element("[data-upload-canvas]"));
      this.element("[data-upload-orbit]").focus({ preventScroll: true });
      this.element("[data-upload-viewer]").scrollIntoView({
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        block: "start",
      });
    } catch {
      fail();
    }
  }

  private setView(aligned: boolean) {
    this.aligned = aligned;
    this.element("[data-upload-overlay]").hidden = !aligned;
    this.element("[data-upload-orbit]").setAttribute(
      "aria-pressed",
      String(!aligned),
    );
    this.element("[data-upload-align]").setAttribute(
      "aria-pressed",
      String(aligned),
    );
    if (!this.prepared || !this.controller) return;
    this.controller.setComparisonLocked(aligned);
    if (aligned) {
      this.controller.hideFrustum();
      this.controller.alignToPhoto(this.prepared.photo.id, 0);
    } else {
      this.controller.selectPhoto(this.prepared.photo.id);
      this.controller.showFrustum(this.prepared.photo.id);
    }
  }

  private updateCamera() {
    if (!this.prepared || !this.controller) return;
    this.controller.updatePhoto(this.prepared.photo);
    if (this.aligned) this.controller.alignToPhoto(this.prepared.photo.id, 0);
    else this.controller.showFrustum(this.prepared.photo.id);
  }
}

if (!customElements.get("photo-upload"))
  customElements.define("photo-upload", PhotoUpload);
