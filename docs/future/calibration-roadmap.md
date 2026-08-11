# Calibration roadmap

Potential work should be introduced behind an explicit experiment, evidence threshold, cleanup plan, and documentation update.

## Owned reference set and HLoc/COLMAP

Build a licensed, georeferenced reference collection with known camera models. Only then evaluate HLoc retrieval/matching and COLMAP localization against that owned model. Success means repeatable absolute pose on a held-out set, not merely a plausible reference match.

## GPS-less localization

Treat learned geolocation and temporal neighbors as search priors only. Publication would require independent metric registration, bounded uncertainty, exact-render verification, and a clear privacy policy.

## Landmark range extension

Revisit distant geometry only with owned/licensed identity references, reliable metric height, robust localized correspondences, and projection through the matched image region. It must not override contradictory provider depth.

## Per-record privacy

Add explicit editorial controls for location precision and timestamp granularity before expanding publication beyond the current policy. Manifest serialization and browser props must enforce the selected precision.

## Depth-aware projection

Explore occlusion-aware projective texture using provider depth or a trusted scene mesh. Any implementation must preserve provider terms, avoid tile persistence, handle missing coverage, and keep the standard gallery as the durable fallback.
