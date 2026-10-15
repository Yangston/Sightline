# Automatic photography calibration

This study explains how the portfolio turns an iPhone photograph into a
reviewable camera on the Cesium photography map. It documents the current
implementation, all persisted and decision-driving calibration variables, the
division between photograph metadata and calculated evidence, the construction
of the matching camera frustum, and the experimental approaches that were
removed.

The operational contracts remain [Photography publishing](../PHOTOGRAPHY.md)
and [Photography map and calibration](../PHOTOGRAPHY_3D.md). Internal workers
under `scripts/photography/` are implementation details, not additional public
commands.

## Central claim

An iPhone photograph is not calibrated from EXIF alone. EXIF supplies a noisy
prior: approximate position, altitude, uncertainty, compass direction, phone
attitude clues, focal length, and dimensions. The active pipeline then:

1. finds an official outdoor Street View reference near the GPS prior;
2. matches learned image features with geometric verification;
3. lifts reference pixels into WGS84 positions using Cesium provider depth;
4. solves a metric camera pose and refines its focal length;
5. derives near and far frustum planes from full-frame provider depth;
6. renders the solved camera exactly;
7. measures photograph-to-render residuals and optionally repairs the pose;
8. rerenders and reverifies before publishing the camera as calibrated.

In repository terminology, an `exact` placement is unrounded and contains
complete numeric camera geometry. It is not a claim of survey-grade truth. The
result is still limited by GPS uncertainty, provider-model accuracy, scene
changes over time, and the assumptions of the camera model.

## The complete pipeline

### 1. Import, classify, and publish the gallery image

A new JPEG enters
`src/content/photography/iCloud Photos/Unprocessed` and is processed by
`npm run photos`.

The incremental publisher:

1. reads the complete inbox without moving sources;
2. extracts compact metadata with Sharp and rich local metadata with ExifTool;
3. normalizes the filename into a manifest ID, such as
   `IMG_7561.JPEG` to `img-7561`;
4. classifies exact-GPS photographs into the smallest configured city boundary;
5. uses an unambiguous capture-sequence neighbor only for archive classification
   when GPS is absent;
6. generates oriented responsive WebPs;
7. commits source moves, media, manifest, sanitized audit, and private metadata
   as one rollback-capable transaction;
8. attempts optional automatic calibration for exact-GPS records.

Capture-sequence classification never invents a coordinate. A photograph
without exact GPS cannot enter the automatic pose solver and receives
`exact-gps-required-for-map-calibration`. Gallery publication remains the
success boundary even when automatic calibration is skipped or rejected.

The extraction and normalization rules live in
[`photography-records.mjs`](../../scripts/photography/lib/photography-records.mjs)
and the inbox transaction lives in
[`photography-inbox.mjs`](../../scripts/photography/lib/photography-inbox.mjs).

### 2. Read calibration-relevant photograph metadata

The rich ExifTool record stays under `.private` and is never copied wholesale
into generated public data or documentation. The calibration worker selects
only the fields it needs.

| Record field              | Photograph tag or source                                       | Role                                                                        |
| ------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `id`                      | normalized filename                                            | Stable join key across manifest, audit, pilots, rejections, and map catalog |
| `source`                  | canonical archive path                                         | Proves source membership                                                    |
| `captureDate`             | `DateTimeOriginal`, then `CreateDate` or `ModifyDate` fallback | Ordering, archive context, and date-only public policy                      |
| `make`, `model`           | EXIF                                                           | Private diagnostic context; not required by the solver                      |
| `orientation`             | EXIF orientation                                               | Determines displayed dimensions and pixel coordinate system                 |
| `width`, `height`         | EXIF/Sharp                                                     | Image aspect, FOV derivation, coverage, and camera matrix                   |
| `gps.latitude`            | `GPSLatitude`                                                  | Exact positional prior and city classification                              |
| `gps.longitude`           | `GPSLongitude`                                                 | Exact positional prior and city classification                              |
| `gps.altitudeM`           | `GPSAltitude`                                                  | Mean-sea-level altitude prior for current iPhone records                    |
| `gps.altitudeReference`   | `GPSAltitudeRef`                                               | Describes the original altitude datum                                       |
| `gps.horizontalAccuracyM` | `GPSHPositioningError`                                         | Bounds acceptable movement away from the GPS prior                          |
| `headingDeg`              | `GPSImgDirection`, then `GPSDestBearing`                       | Compass prior for reference-view sweeps                                     |
| `accelerationVector`      | Apple `AccelerationVector`                                     | Input for pitch and roll priors                                             |
| `focalLengthMm`           | `FocalLength`                                                  | Physical lens metadata retained for provenance                              |
| `focalLength35Mm`         | `FocalLengthIn35mmFormat`                                      | Primary automatic FOV input                                                 |

Country, region, city membership, provider coverage, recommended tier,
calibration status, and public privacy policy are repository decisions. They
are not photograph metadata.

The sanitized audit publishes only availability flags such as `hasGps`,
`hasHeading`, and `hasFocalLength`. Provider images, matcher reports, rich
device metadata, and exact intermediate evidence remain private.

### 3. Derive Apple pitch and roll priors

Apple's acceleration vector is expressed in phone coordinates. The repository
uses:

```text
planarMagnitude = hypot(x, y)
pitchDeg = degrees(atan2(z, planarMagnitude))

deviceAngleDeg = degrees(atan2(x, -y))
nearestOrientationDeg = round(deviceAngleDeg / 90) * 90
rollDeg = normalizeSigned(deviceAngleDeg - nearestOrientationDeg)
```

Vectors with `planarMagnitude < 0.5` are rejected as unstable. The acceleration
vector does not supply heading. These values are pose priors, not verified
camera orientation. The implementation is in
[`apple-camera-pose.mjs`](../../scripts/photography/lib/apple-camera-pose.mjs).

### 4. Convert mean-sea-level altitude to WGS84 ellipsoid height

Cesium positions use WGS84 ellipsoid height. Current iPhone GPS altitude is
treated as height above mean sea level, so the worker samples the local EGM96
grid and calculates:

```text
h = H + N

h = WGS84 ellipsoid height
H = EXIF mean-sea-level altitude
N = EGM96 geoid undulation at the EXIF latitude and longitude
```

A negative ellipsoid height does not mean the camera was physically below sea
level. Mean sea level and the mathematical ellipsoid are different reference
surfaces.

The grid reader performs bilinear interpolation in
[`geoid-grid.mjs`](../../scripts/photography/lib/geoid-grid.mjs). A
mean-sea-level original cannot become a valid public camera record without an
EGM96 undulation and a resolved ellipsoid position.

The resulting prior is:

```text
prior = {
  longitude,
  latitude,
  altitudeM: ellipsoidHeight,
  horizontalAccuracyM: exifAccuracy ?? 10,
  coarse: false
}
```

### 5. Derive initial field of view

Physical focal length alone is insufficient without physical sensor
dimensions. The automatic worker therefore prefers the 35 mm-equivalent focal
length and the oriented image dimensions.

For oriented width `w`, height `h`, and 35 mm-equivalent focal length `f35`:

```text
fullFrameDiagonal = sqrt(36^2 + 24^2)
imageDiagonal = sqrt(w^2 + h^2)

sensorWidth = fullFrameDiagonal * w / imageDiagonal
sensorHeight = fullFrameDiagonal * h / imageDiagonal

horizontalFovDeg = degrees(2 * atan(sensorWidth / (2 * f35)))
verticalFovDeg = degrees(2 * atan(sensorHeight / (2 * f35)))
```

If `focalLength35Mm` is absent, the automatic worker starts from a 28 mm
equivalent. Separately, the runtime data adapter falls back to an explicitly
approximate `55° x 42°` when neither solved FOV nor 35 mm equivalence exists.
Those are starting assumptions, not verified optics.

The solver later refines focal scale. The final FOV can therefore differ from
the direct metadata calculation.

### 6. Retrieve bounded Street View reference views

The worker requests an official outdoor Street View panorama within 80 metres
of the exact GPS prior. It does not use broad learned geolocation as a
publishable location.

When a heading prior exists:

- the fast pass renders heading offsets `-30°, 0°, +30°` at the prior pitch;
- the wide pass renders heading offsets `-60°, -30°, 0°, +30°, +60°`;
- the wide pass combines those headings with pitch offsets `-15°, 0°, +15°`.

When heading is absent, the worker covers the compass in 60° increments for a
fast sweep or 30° increments for the broader sweep.

Street View references use a `640 x 640` request with scale `2`. Requested FOV
is clamped to `10°–120°`. The panorama camera altitude is estimated from Google
Elevation, plus an assumed 2.5 metre camera height, then converted to ellipsoid
height with EGM96.

Reference files and provider identifiers are ephemeral and remain under
`.private`; provider tiles are never proxied, persisted, or cached.

### 7. Match learned features and verify geometry

The adaptive matcher runs these stages until a publishable solution appears:

1. SuperPoint/LightGlue with a fast reference sweep;
2. SuperPoint/LightGlue with a wide reference sweep;
3. ALIKED/LightGlue with a fast reference sweep.

Decision-driving matcher variables are:

| Variable                      | SuperPoint |   ALIKED |
| ----------------------------- | ---------: | -------: |
| Maximum keypoints             |      2,048 |    4,096 |
| Extraction resize             |   1,600 px | 1,600 px |
| LightGlue depth confidence    |       0.95 |     0.95 |
| LightGlue width confidence    |       0.99 |     0.99 |
| Candidate references retained |          3 |        3 |

Raw learned matches are not pose evidence by themselves. Each reference is
filtered by both:

- fundamental matrix: USAC MAGSAC, 2.5 px threshold;
- homography: USAC MAGSAC, 3.0 px threshold.

Both models use confidence `0.999` and up to 10,000 iterations. The model with
more inliers is retained, and a reference needs at least eight geometric
inliers before the pose stage.

See
[`match_images.py`](../../scripts/photography/calibration/match_images.py).

### 8. Lift 2D correspondences into WGS84 control points

At this point a match says:

```text
photograph pixel <-> Street View reference pixel
```

That relationship is not metric. The worker renders Cesium photorealistic
geometry from the Street View reference camera and depth-picks the matched
reference pixels. Every valid pick produces:

```text
photograph pixel (u, v)
  <-> WGS84 world point (longitude, latitude, ellipsoid altitude)
```

These 2D-to-3D correspondences are the bridge from appearance matching to an
absolute camera on the map.

### 9. Solve absolute camera pose

The pose solver converts WGS84 points to Earth-Centered, Earth-Fixed coordinates
and then into a local East-North-Up frame centered on the GPS prior.

The active camera model assumes:

- principal point at the image center;
- zero skew;
- square pixels, so `fx = fy`;
- zero lens distortion;
- a shared focal scale for both image axes.

The initial focal length in pixels is:

```text
fx = imageWidth / (2 * tan(horizontalFov / 2))
fy = fx
cx = imageWidth / 2
cy = imageHeight / 2
```

The solver evaluates 15 focal scales from `0.72` through `1.28`. Each attempt
uses EPNP RANSAC with:

```text
iterations = 5,000
reprojection threshold = 6 px
confidence = 0.999
```

The best candidate is refined with Levenberg-Marquardt. A later
`calibrateCamera` step may refine focal scale from `0.65` through `1.45`, but
only when it reduces RMS while keeping the centered-principal-point,
fixed-aspect, zero-distortion model.

The solver calculates:

- camera center in ENU, ECEF, and WGS84 coordinates;
- forward, right, and up axes;
- heading, pitch, and roll;
- refined horizontal and vertical FOV;
- convex-hull image coverage;
- positive-depth ratio;
- reprojection RMS;
- position displacement from the GPS prior;
- feature-derived near and far distances.

Absolute-pose acceptance requires:

| Gate                       |                                  Requirement |
| -------------------------- | -------------------------------------------: |
| Inliers                    |                                  at least 12 |
| Inlier ratio               |                                at least 0.35 |
| Reprojection RMS           |                                 at most 6 px |
| Convex-hull image coverage |                                at least 0.06 |
| Positive-depth ratio       |                                at least 0.90 |
| Position displacement      | at most `max(35 m, 4 * horizontalAccuracyM)` |

The implementation is in
[`solve_pose.py`](../../scripts/photography/calibration/solve_pose.py).

### 10. Fall back to a GPS-fixed orientation solve

When absolute position does not pass, the pipeline can keep the exact corrected
GPS prior and solve orientation only. The separate bearing solver converts
query and reference pixels to camera rays, fits a rotation with Wahba/SVD, and
uses angular RANSAC.

Its primary gates are:

| Gate                     |    Requirement |
| ------------------------ | -------------: |
| Minimum inliers          |             12 |
| Inlier ratio             |  at least 0.50 |
| Angular RMS              |     at most 2° |
| Image coverage           | at least 0.008 |
| Inlier angular threshold |           2.5° |

The solver searches query and reference focal scales and may use a strongly
supported homography pose. When this fallback succeeds, position remains the
GPS/EGM96 prior. See
[`solve_rotation.py`](../../scripts/photography/calibration/solve_rotation.py).

### 11. Derive near and far frustum planes from provider depth

Pose and FOV define the frustum's direction and angular extent, but not the
useful depth interval. The worker renders the solved camera at the photograph's
aspect ratio and samples a full-frame grid:

```text
columns = 13
rows = 9
sampleCount = 117
edgeMargin = 0.025
minimum valid samples = 12
accepted depth interval = 0.1 m to 50,000 m
```

It measures `p02`, `p05`, `p50`, `p95`, and `p98` of valid provider depths and
calculates:

```text
nearM = max(0.25, 0.20 * p02)
farM = min(20,000, max(30, 1.15 * p98))
```

The low percentile prevents one anomalous close pixel from moving the near
plane. The upper percentile avoids isolated infinite/background values while
adding 15 percent padding.

The worker rejects conflicting geometry when provider depth:

- entirely misses the surfaces supporting the feature solution;
- truncates a trusted distant feature range;
- conflicts with a large feature-derived near range.

Provider depth can override a grossly inflated feature range only when depth
coverage is at least 0.75, unoccluded range is present, and the feature far
range is at least ten times the provider `p98`.

If `p98 < 30 m`, near geometry may be occluding the provider camera. The worker
uses selected drill-picks and, for narrow FOV cameras, offset probes at
increasing forward/up distances. At least eight valid secondary depths are
required before the occlusion repair can be trusted.

See
[`frustum-depth.mjs`](../../scripts/photography/lib/frustum-depth.mjs) and
[`calibrate-map.mjs`](../../scripts/photography/calibrate-map.mjs).

### 12. Perform the exact-render overlay audit

A solver-level acceptance is only a candidate. Before verification, the worker
adds a rejection-ledger entry with
`pending-exact-render-overlay-audit`.

The verifier:

1. renders Cesium twice from the candidate position, pose, FOV, and aspect;
2. waits for photogrammetry refinement;
3. screenshots the provider canvas;
4. verifies that the render has sufficient entropy and channel variation;
5. matches the photograph to the exact render with SuperPoint, retrying with
   ALIKED when necessary;
6. calculates normalized screen residuals and image coverage.

Overlay classification uses:

| Gate                                                                   | Result                         |
| ---------------------------------------------------------------------- | ------------------------------ |
| At least 8 matches, coverage at least 0.01, median residual above 0.12 | Rejected as gross misalignment |
| Fewer than 12 matches                                                  | Inconclusive                   |
| Coverage below 0.01                                                    | Inconclusive                   |
| Median residual above 0.04                                             | Rejected                       |
| P90 residual above 0.10                                                | Rejected                       |
| Otherwise                                                              | Accepted                       |

If the initial overlay does not pass but contains at least eight geometric
inliers, the verifier depth-picks spatially balanced overlay matches and solves
the camera again. A repair is written only after:

1. the repaired pose solves successfully;
2. a fresh exact render is produced;
3. the repaired overlay passes the same residual gates;
4. a new full-frame depth grid yields an accepted frustum.

Only then does the repaired result replace the initial rejection. See
[`verify-map.mjs`](../../scripts/photography/verify-map.mjs),
[`overlay-residual.mjs`](../../scripts/photography/lib/overlay-residual.mjs),
and
[`map-verification.mjs`](../../scripts/photography/lib/map-verification.mjs).

### 13. Publish, reject, or leave marker-only

An automatic record enters `photography-auto-pilots.json` only when it has:

- canonical manifest and configured city membership;
- exact GPS converted to ellipsoid height with EGM96;
- a publishable SuperPoint or ALIKED LightGlue result;
- accepted full-frame provider-depth evidence;
- accepted exact-render overlay evidence;
- no rejection-ledger entry.

A rejected attempt with a complete numeric camera becomes a sanitized public
`cameraCandidate`. It can show an exact warning marker, red rejected frustum,
camera alignment, and comparison view, but can never enable projective
highlighting. An incomplete attempt remains marker-only.

The map catalog includes every manifest photograph exactly once:

- verified, authored, and complete rejected cameras retain exact placement;
- other GPS is rounded to three decimal degrees with altitude removed;
- no-GPS photographs share the configured region anchor.

Projective texture or tint is a separate editorial decision. A calibrated pose
does not automatically authorize projection.

## Persisted calibration variables

The verified automatic pilot record persists these fields:

| Group                   | Variables                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                | `id`, `cityId`, `country`                                                                                                                                             |
| Original location       | `location.latitude`, `location.longitude`, `location.altitudeM`                                                                                                       |
| Datum and uncertainty   | `originalAltitudeReference`, `geoidUndulationM`, `horizontalAccuracyM`                                                                                                |
| Corrected camera center | `corrected.longitude`, `corrected.latitude`, `corrected.altitudeM`                                                                                                    |
| Orientation             | `headingDeg`, `pitchDeg`, `rollDeg`                                                                                                                                   |
| Optics provenance       | `focalLengthMm`, `focalLength35Mm`                                                                                                                                    |
| Solved optics           | `horizontalFovDeg`, `verticalFovDeg`                                                                                                                                  |
| Pose provenance         | `source`, `confidence`, `calibration`                                                                                                                                 |
| Runtime preference      | `preferredTier`                                                                                                                                                       |
| Frustum                 | `nearM`, `farM`                                                                                                                                                       |
| Feature evidence        | `matcher`, `matches`, `inliers`, `inlierRatio`, `rmsErrorPx`, `imageCoverage`, `positionDeltaM`, `referenceView`, `solutionMode`                                      |
| Depth evidence          | `accepted`, `method`, `columns`, `rows`, `sampleCount`, `validDepthCount`, `validDepthRatio`, `nonCityDepthCount`, `p02`, `p05`, `p50`, `p95`, `p98`, `nearM`, `farM` |
| Overlay evidence        | `matcher`, `geometricInliers`, `imageCoverage`, `medianResidual`, `p90Residual`                                                                                       |

`confidence` is a bounded heuristic, not a probability of geographic truth:

```text
confidence = min(
  0.99,
  0.55 + 0.25 * inlierRatio + 0.20 * imageCoverage
)
```

It is assigned before the exact-render audit. When an overlay repair replaces
the evidence fields, the existing confidence is retained, so it may not be
recomputable from the final post-repair metrics.

## Worked example: `IMG_7561.JPEG`

`IMG_7561.JPEG` is the canonical San Francisco source represented by
`img-7561`. The public manifest records:

| Manifest variable           | Value                                       |
| --------------------------- | ------------------------------------------- |
| `source`                    | `United-States/san-francisco/IMG_7561.JPEG` |
| `country`                   | `united-states`                             |
| `region`                    | `san-francisco`                             |
| `captureDate`               | `2026-07-11T11:49:12.000Z`                  |
| `width`                     | 1,536 px                                    |
| `height`                    | 2,048 px                                    |
| Largest calibration variant | 1,536 px WebP                               |

The sanitized audit confirms GPS, altitude, horizontal accuracy, heading,
pitch, roll, focal length, and dimensions without publishing the rich private
metadata payload.

### Public starting prior

The verified public pilot retains the approved source prior:

```text
latitude = 37.798594
longitude = -122.430886
meanSeaLevelAltitude = 17.88360955 m
geoidUndulation = -32.23837936334322 m
horizontalAccuracy = 14.24595457 m
```

The ellipsoid prior is:

```text
ellipsoidAltitude
  = 17.88360955 + (-32.23837936334322)
  = -14.354769813343221 m
```

The absolute solver's allowed displacement was:

```text
max(35, 4 * 14.24595457)
  = 56.98381828 m
```

### Metadata-derived optical starting point

The retained focal metadata is:

```text
physical focal length = 6.8 mm
35 mm equivalent = 24 mm
oriented dimensions = 1536 x 2048
```

The direct 35 mm-equivalent calculation gives approximately:

```text
horizontal FOV = 56.8119°
vertical FOV = 71.5915°
```

The final values differ slightly because the computer-vision solver refined
focal scale.

### Final verified camera

The public automatic-pilot record contains:

| Variable           |          Verified value |
| ------------------ | ----------------------: |
| Longitude          |   `-122.43087028739133` |
| Latitude           |     `37.79856414277553` |
| Ellipsoid altitude | `-14.975483104586601 m` |
| Heading            |    `40.37278524009985°` |
| Pitch              |    `5.723253862955775°` |
| Roll               |  `-0.8523729627817749°` |
| Horizontal FOV     |   `57.120347581415736°` |
| Vertical FOV       |    `71.94091895111899°` |
| Near plane         |  `0.5024968347032674 m` |
| Far plane          |    `76.1859905006766 m` |
| Pose source        |       `computer-vision` |
| Calibration        |            `calibrated` |
| Confidence         |    `0.7778946682735823` |
| Preferred tier     |        `photorealistic` |

The corrected position is `3.6445026617682137 m` from the prior, comfortably
inside the `56.98381828 m` displacement gate.

### Final pose evidence

| Metric                     |                                 Value |
| -------------------------- | ------------------------------------: |
| Matcher                    |                `lightglue-superpoint` |
| Solution mode              |                       `absolute-pose` |
| Matches                    |                                   119 |
| Inliers                    |                                    58 |
| Inlier ratio               |                 `0.48739495798319327` |
| Reprojection RMS           |                `3.474797885066768 px` |
| Convex-hull image coverage |                 `0.08559244578704088` |
| Position delta             |                `3.6445026617682137 m` |
| Reference stage            | `exact-match-camera-provider-overlay` |

This satisfies the absolute-pose gates: at least 12 inliers, ratio at least
0.35, RMS no more than 6 px, coverage at least 0.06, and acceptable movement
from the GPS prior.

### Final depth evidence and frustum

The full-frame `13 x 9` grid produced 70 valid depths from 117 samples:

| Depth metric |                  Value |
| ------------ | ---------------------: |
| Valid ratio  |   `0.5982905982905983` |
| `p02`        |  `2.512484173516337 m` |
| `p05`        | `2.5339435819046328 m` |
| `p50`        |  `5.639436957943689 m` |
| `p95`        |   `36.9118259344176 m` |
| `p98`        |   `66.2486873918927 m` |

The frustum follows directly:

```text
nearM = 0.20 * 2.512484173516337
      = 0.5024968347032674 m

farM = 1.15 * 66.2486873918927
     = 76.1859905006766 m
```

### Final exact-render audit

| Overlay metric    |                  Value |
| ----------------- | ---------------------: |
| Matcher           | `lightglue-superpoint` |
| Geometric inliers |                    335 |
| Image coverage    |   `0.2648124684194725` |
| Median residual   | `0.006184132979592228` |
| P90 residual      | `0.011658162296212228` |

The residuals are well below the `0.04` median and `0.10` P90 rejection
thresholds. The accepted overlay and accepted depth grid allow the rejection
ledger entry to be removed and the automatic pilot to remain public.

### Cesium frustum geometry

A complete public frustum uses:

```text
origin: longitude, latitude, ellipsoid altitude
orientation: heading, pitch, roll
optics: horizontal FOV, vertical FOV
shape: image aspect ratio
depth: nearM, farM
```

For `IMG_7561`, aspect ratio is `1536 / 2048 = 0.75`. Cesium therefore uses
the vertical FOV as its primary `PerspectiveFrustum.fov` and reconstructs the
horizontal extent from the aspect ratio.

At distance `d`:

```text
planeWidth = 2 * tan(horizontalFov / 2) * d
planeHeight = 2 * tan(verticalFov / 2) * d
```

The verified frustum planes are approximately:

| Plane              |      Width |      Height |
| ------------------ | ---------: | ----------: |
| Near at `0.5025 m` |  `0.547 m` |   `0.729 m` |
| Far at `76.1860 m` | `82.939 m` | `110.585 m` |

Cesium's `FrustumGeometry` reverses its local X axis while reconstructing the
view. The controller therefore builds the orientation quaternion from
`-camera.right`, `camera.up`, and `camera.direction`. The runtime construction
is in
[`controller.ts`](../../src/lib/photography-map/controller.ts) and
[`cesium-orientation.ts`](../../src/lib/photography-map/cesium-orientation.ts).

The public map enables marker, frustum, and comparison for `img-7561`.
Projection remains off because projective highlighting requires separate
editorial approval even for a calibrated pose.

## What comes from the photograph and what is calculated

### Supplied by photograph metadata

- capture timestamp;
- original width, height, and orientation;
- GPS latitude and longitude, when present;
- GPS altitude and altitude-reference label;
- horizontal GPS error, when present;
- GPS image direction or destination bearing, when present;
- Apple acceleration vector, when present;
- physical focal length;
- 35 mm-equivalent focal length;
- device make and model for private diagnostics.

### Calculated or obtained by the repository

- normalized ID and canonical archive membership;
- configured country, region, city, and provider coverage;
- pitch and roll priors from Apple acceleration;
- EGM96 geoid undulation and ellipsoid altitude;
- initial horizontal and vertical FOV;
- Street View panorama and reference-view sweep;
- provider reference altitude;
- SuperPoint/ALIKED features and LightGlue matches;
- fundamental/homography geometric inliers;
- Cesium depth-backed WGS84 control points;
- absolute or GPS-fixed camera pose;
- refined focal scale and final FOV;
- reprojection RMS, image coverage, inlier ratio, and cheirality;
- position displacement from the GPS prior;
- full-frame provider-depth percentiles;
- near and far frustum planes;
- exact-render overlay residuals;
- repair result and final verification status;
- heuristic confidence;
- public placement kind, capabilities, warning state, and projection policy.

### Not supplied or independently known

The active record does not contain a surveyed lens model, principal point,
distortion coefficients, rolling-shutter model, precise vertical GPS error, or
ground-truth camera survey. The solver's centered, zero-distortion camera model
and the provider's scene geometry are approximations. Exact-render verification
detects many bad combinations, but it cannot turn provider geometry into
surveyed truth.

## Approaches that were tried and removed

The dated evidence is retained in
[Calibration attempts — July 2026](../history/calibration-attempts-2026-07.md).
These methods are historical context, not executable alternatives.

### DISK and SIFT matcher branches

They added additional matching paths but did not produce stronger publishable
evidence than SuperPoint/ALIKED with LightGlue. More matches did not compensate
for weak geometric or exact-render proof.

### RoMa

RoMa increased memory and compute cost and appeared only in experimental
landmark verification. No retained exact-render-verified camera depended on it.

### GeoCLIP and whole-image CLIP

They could suggest a broad city or plausible reference but could not recover a
metric camera center, orientation, focal model, or depth range. Learned
geolocation can be a search prior; it is not publishable pose evidence.

### Archive bootstrap and registered-archive chains

These approaches localized photographs from previously calibrated archive
frames. Small position, orientation, or focal errors could propagate through
the sequence and make later cameras appear mutually consistent while drifting
away from the map.

### PyCOLMAP sequence reconstruction and multiview triangulation

Relative reconstruction added a second camera/point-cloud system without a
trusted georeferenced reference model. It could solve cameras relative to each
other while leaving the whole reconstruction metrically wrong on Earth.

### Open-map landmark extension

Mapped landmark geometry could lengthen a frustum, but landmark identity,
height, and exact image localization were too fragile to override contradictory
provider depth.

### Screen-servo overlay adjustment

Optimizing only screen residuals allowed position, orientation, FOV, and range
to compensate for each other without a sufficiently constrained metric camera.
An overlay could look better while the underlying camera became less truthful.

### Candidate-level matching or PnP success

The most important rejected assumption was that a strong matcher or PnP score
was sufficient. The current pipeline treats every solver acceptance as pending
until the exact camera is rendered, matched, and depth-checked. A repaired
camera must pass a second render before it can replace its rejection.

### Duplicate generated state

The experimental state temporarily contained a byte-identical `img-75619999`
record alongside canonical `img-7561`. This was an integrity problem, not a
calibration method. The rebuild workflow removed the duplicate record, WebPs,
and map membership.

## Interpretation limits

- `exact` means unrounded, complete runtime geometry; it does not mean surveyed.
- EXIF heading and phone attitude are priors and may be wrong.
- EGM96 corrects the altitude datum, not the GPS measurement error.
- Street View and photorealistic tiles may represent different capture dates.
- Provider meshes can contain holes, occluders, simplified surfaces, or local
  coordinate error.
- Sparse features can cluster on one facade; coverage gates reduce but do not
  eliminate that ambiguity.
- Near and far distances are robust rendering bounds, not a semantic inventory
  of every visible object.
- Confidence is a ranking heuristic, not a probability or privacy decision.
- A calibrated pose does not authorize projective texture. Projection remains
  a separate editorial approval.
- Missing models, provider credentials, WebGL, or coverage must never prevent
  the ordinary static gallery from working.

## Implementation map

| Responsibility                            | Source                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Incremental publication                   | [`scripts/photography/import.mjs`](../../scripts/photography/import.mjs)                                       |
| Metadata and responsive records           | [`scripts/photography/lib/photography-records.mjs`](../../scripts/photography/lib/photography-records.mjs)     |
| Apple pose prior                          | [`scripts/photography/lib/apple-camera-pose.mjs`](../../scripts/photography/lib/apple-camera-pose.mjs)         |
| EGM96 interpolation                       | [`scripts/photography/lib/geoid-grid.mjs`](../../scripts/photography/lib/geoid-grid.mjs)                       |
| Automatic orchestration and frustum depth | [`scripts/photography/calibrate-map.mjs`](../../scripts/photography/calibrate-map.mjs)                         |
| Feature matching                          | [`scripts/photography/calibration/match_images.py`](../../scripts/photography/calibration/match_images.py)     |
| Absolute PnP                              | [`scripts/photography/calibration/solve_pose.py`](../../scripts/photography/calibration/solve_pose.py)         |
| GPS-fixed rotation                        | [`scripts/photography/calibration/solve_rotation.py`](../../scripts/photography/calibration/solve_rotation.py) |
| Exact-render audit and repair             | [`scripts/photography/verify-map.mjs`](../../scripts/photography/verify-map.mjs)                               |
| Overlay metrics                           | [`scripts/photography/lib/overlay-residual.mjs`](../../scripts/photography/lib/overlay-residual.mjs)           |
| Public record schema                      | [`src/lib/photography-map/schema.ts`](../../src/lib/photography-map/schema.ts)                                 |
| Public record adapter                     | [`src/lib/photography-map/data.ts`](../../src/lib/photography-map/data.ts)                                     |
| Cesium camera and frustum rendering       | [`src/lib/photography-map/controller.ts`](../../src/lib/photography-map/controller.ts)                         |
| Historical experiments                    | [`docs/history/calibration-attempts-2026-07.md`](../history/calibration-attempts-2026-07.md)                   |
