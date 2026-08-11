# Calibration attempts — July 2026

## Snapshot

The experimental registry accumulated 42 automatic candidates and 31 rejection-ledger entries while pose, localization, and frustum strategies were explored. Generated gallery state also contained a byte-identical temporary copy, `img-75619999`, alongside canonical `img-7561`; the archive actually contained 147 sources. The cleanup rebuild removes the duplicate record, WebPs, and map state.

Only exact-render-audited records are now retained as automatic pilots. Candidate-level success from matching or PnP is insufficient without the final overlay and frustum verification.

## Removed attempts

- DISK and SIFT added matcher branches without producing stronger publishable evidence than the retained LightGlue paths.
- RoMa increased memory/cost and appeared only in experimental landmark verification; no retained exact-render record depended on it.
- GeoCLIP and whole-image CLIP could propose a broad place or reference but could not establish metric pose. They also complicated GPS-less failure states.
- Archive bootstrap and registered-archive chains risked propagating calibration error between frames.
- PyCOLMAP sequence reconstruction and multiview triangulation added a second reconstruction system without a trusted georeferenced reference model.
- Open-map landmark extension could lengthen a frustum from mapped geometry, but identity, height, and image localization evidence remained too fragile for active publication.
- Screen-servo overlay adjustment optimized image residuals without a sufficiently constrained metric camera model.

## Retained lessons

- Gallery publication and map proof are separate outcomes.
- Exact GPS plus EGM96 is a reliable positional prior; a learned city prior is not a publishable location.
- Sparse learned features need geometric verification and provider depth before pose estimation.
- Full-frame provider depth must be checked against feature-derived range instead of blindly replacing it.
- The final rendered overlay is the authoritative pose check. A repair is accepted only after a second render and strict verification.
- Rejections are useful durable evidence; unverified candidate records are not runtime map data.
