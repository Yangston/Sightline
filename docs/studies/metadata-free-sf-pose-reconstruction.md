# Metadata-free San Francisco pose reconstruction

`sf-north-v1` is Sightline's first image-only location-and-pose experiment. It asks a deliberately narrow question: can the system reconstruct a camera from pixels when every embedded device field is unavailable to localization?

The experiment is versioned because its authored bounds, cohort, model versions, search lattice, selection policy, and acceptance gates are part of the result. Changing any of them creates a new experiment ID; post-hoc error measurements never tune an existing version.

## Frozen study area and cohort

The only geographic prior available to the image-only worker is this authored rectangle:

| Edge  | Coordinate |
| ----- | ---------- |
| West  | -122.442   |
| South | 37.787     |
| East  | -122.4115  |
| North | 37.808     |

The frozen cohort is `img-7492`, `img-7498`, `img-7526`, `img-7532`, `img-7536`, `img-7561`, `img-7563`, `img-7574`, `img-7577`, `img-7578`, and `img-7600`. `img-7540`, `img-7542`, `img-7544`, and `img-7608` remain in the San Francisco archive but are explicitly outside the image-only pilot. They are never assigned an image-only marker.

The source of truth is `src/config/photography.json`. The configuration fixes a 50 m coordinate lattice, 12 primary coordinates, 12 fallback coordinates, 150 m spatial suppression, an 80 m outdoor-panorama search radius, and a 250 m maximum solved-camera distance from the matched panorama.

## Metadata firewall

The coordinator needs the manifest only to find the canonical archive file and confirm exact publication approval. It decodes that file into an opaque PNG without auto-orienting it or copying metadata. A SHA-256 digest is computed from decoded pixels, not the JPEG container.

The localization subprocess receives only:

- the opaque photo ID;
- the metadata-free PNG;
- decoded pixel dimensions;
- the fixed experiment configuration and bounds.

It never receives the source filename, manifest source path, capture time, device make/model, EXIF orientation, GPS, heading, acceleration vector, pitch, roll, focal length, or private metadata object. It tests 0°, 90°, 180°, and 270° rotations as visual hypotheses. Dimensions and focal hypotheses come from the selected pixel array.

The prediction is canonicalized and SHA-256 sealed after accepted/rejected/no-solution status is final. Only then does `evaluate-image-only.mjs` open `.private/photography-metadata.json`. The evaluator writes differences only: horizontal and altitude error, circular heading and roll error, pitch error, and horizontal-FOV error. It never writes the reference position or orientation. Rejected results can record that a reference exists but have no fabricated numeric pose error.

Unit coverage constructs identical decoded pixels with different filenames, descriptive metadata, and EXIF orientation tags, then proves their pixel digests and sealed visual predictions are identical.

## Visual search and pose stages

The worker runs these stages in order:

1. Score the authored 50 m lattice with pinned GeoCLIP 1.2.0 for each of four pixel rotations. GeoCLIP is a coordinate prior only.
2. Apply 150 m non-maximum suppression and retain 12 primary plus 12 fallback coordinates.
3. Query official outdoor Street View metadata within 80 m of those coordinates, using fallback coordinates only when the primary set produces no panorama. Panorama IDs are deduplicated.
4. Render six 90° headings per transient panorama. Provider images stay inside the run's private worker directory.
5. Rank transient references with GeoCLIP's pinned CLIP-L/14 image encoder and pass the best 24 to SuperPoint/LightGlue.
6. If no solution survives, refine the best six ranked views at ±20° heading and ±15° pitch and retry with ALIKED/LightGlue.
7. Depth-pick matched reference pixels through the Cesium provider harness.
8. Run absolute PnP for 35°, 55°, and 80° initial horizontal-FOV hypotheses. Focal refinement is bounded to 20°–110°. The metadata-assisted GPS-fixed rotation fallback is unavailable in this branch.
9. Require existing inlier, ratio, reprojection, coverage, and cheirality gates, plus an in-bounds center, no more than 250 m displacement from the matched panorama, and no geographically distant near-tie.
10. Refine the full-frame frustum from provider depth, render the selected metadata-free rotation at the solved camera, and require the exact-overlay audit.
11. Seal the prediction, then evaluate it against embedded metadata in a separate process.

No acceptance-rate target exists. Missing models, credentials, panoramas, WebGL, depth, or useful matches produce a logged, sealed rejection or no-solution result without failing gallery publication.

## Commands

Install, preload, and offline-verify LightGlue, GeoCLIP 1.2.0, and `openai/clip-vit-large-patch14` once per calibration environment:

```sh
npm run photos:setup
```

Publish new inbox photos through the normal metadata-assisted path and request the image-only experiment for eligible IDs:

```sh
npm run photos -- --experiment=sf-north-v1
```

Backfill or retry cohort records without touching gallery publication or baseline map membership:

```sh
npm run photos:locate -- --ids=img-7492,img-7498 --experiment=sf-north-v1 --replace
npm run photos:locate -- --experiment=sf-north-v1 --replace
```

`--replace` is required to supersede an already sealed result. Omit it to leave existing outcomes untouched. A local prestarted harness can be supplied with `--server-url=http://127.0.0.1:<port>`; otherwise the worker starts a development-only harness on a run-specific loopback port.

After source or processor changes, run the normal rebuild and validation chain. Source-aware checks recompute decoded-pixel digests and reject stale outcomes with an exact retry command.

## Generated and private artifacts

The public parallel registries are:

- `src/data/photography-image-only-pilots.json`: accepted cameras, pixel digest, pipeline version, selected rotation, image-derived FOV, sanitized metrics, frustum, exact-overlay audit, and prediction digest;
- `src/data/photography-image-only-rejections.json`: rejected/no-solution outcomes, sanitized reasons and metrics, selected rotation, pixel digest, pipeline version, and prediction digest;
- `src/data/photography-image-only-evaluations.json`: prediction digest plus post-seal error differences only.

Accepted image-only records always set projective texture to off in the public adapter. None of the three registries contains source GPS, a reference camera, raw EXIF, provider URLs, provider images, private filesystem paths, or credentials.

Each invocation prints a run ID and writes `.private/photo-image-only-runs/<run-id>/`:

| Artifact                  | Purpose                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| `events.jsonl`            | Ordered machine-readable stage events                            |
| `summary.json`            | Final counts and completion/failure state                        |
| `sanitized-evidence.json` | Redacted event evidence for debugging                            |
| `timeline.html`           | Self-contained human-readable trace                              |
| `worker-request[-n].json` | Private metadata-free localization request                       |
| `worker-result[-n].json`  | Private solver output before public filtering                    |
| `sealed-predictions.json` | Sealed outcomes supplied to the evaluator                        |
| `evaluations.json`        | Private evaluator output before registry merge                   |
| `worker-failure[-n].json` | Redacted subprocess failure detail, when a shard cannot complete |

Transient query PNGs and provider references are removed in `finally`. Panorama IDs may remain in private worker evidence, but provider image bytes and derived image indexes do not. Terminal output and the HTML trace redact credentials, provider URLs, absolute private paths, GPS/EXIF-like fields, and raw evaluator reference values.

## Public comparison

Only San Francisco exposes the reconstruction switch. “Metadata-assisted” is the default. “Image-only (no file metadata)” is restorable through `?reconstruction=image-only&photo=<id>` and replaces 2D markers, statuses, camera records, frustums, matching controls, and comparisons without recreating the active 3D provider.

All 15 San Francisco photographs remain in the review index. Out-of-area photographs say “Outside image-only pilot area”; rejected and no-solution photographs have no invented marker and their camera tools are disabled. Accepted records may show post-hoc numeric differences with the explicit label “differences from embedded device metadata, not survey truth.” The same experiment summary remains available in no-JavaScript HTML.

## Troubleshooting by stage

| Last stage            | Likely cause                                  | Action                                                                 |
| --------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| `pixel-sanitization`  | Missing/corrupt archive source                | Restore the canonical source; run source-aware photography checks      |
| `geoclip-search`      | Missing/offline model cache                   | Run `npm run photos:setup`; inspect offline-verification output        |
| `panorama-discovery`  | Key, API, billing, network, or coverage       | Verify the restricted key and Street View Static API access            |
| `reference-rendering` | Provider quota or transient image request     | Retry with `photos:locate -- --replace`; do not cache the failed image |
| `clip-ranking`        | CLIP cache/runtime or memory pressure         | Re-run setup; reduce other local model load, not experiment thresholds |
| `lightglue`           | No stable visual correspondence               | Keep the rejection; inspect sanitized metrics                          |
| `depth-picks`         | Missing WebGL/tiles or invalid provider depth | Use a working harness/provider; never substitute GPS depth             |
| `pnp-fov-solving`     | Weak geometry, cheirality, FOV, or ambiguity  | Keep failure; threshold changes require a new experiment ID            |
| `frustum-checks`      | Inconsistent full-frame provider depth        | Retry transient provider failure; otherwise retain rejection           |
| `overlay-audit`       | Exact render does not align                   | Reject; repair is not metadata-assisted in this experiment             |
| `metadata-evaluation` | Missing private reference metadata            | Prediction stays sealed; evaluation records reference unavailable      |

The timeline is the first diagnostic artifact. Do not copy provider images, credentials, raw metadata, or private paths into issues or committed documentation.
