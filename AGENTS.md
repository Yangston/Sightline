# Sightline repository guide

Sightline is a static Astro 7 research showcase and an offline camera-pose
reconstruction toolkit. Public pages may display only sanitized, reviewed
records. Raw photographs, EXIF, provider renders, credentials, model caches,
and detailed run evidence remain ignored.

- Keep Astro responsible for routes and durable HTML; use React only for the
  opt-in viewer and dialogs.
- Keep Cesium behind an explicit 3D action and destroy every controller on
  unmount or failure.
- Never proxy, persist, or cache provider imagery. Keep attribution visible.
- Accepted, rejected, approximate, and missing results must remain visibly
  distinct. A solved pose is not automatically verified or approved.
- Preserve keyboard access, focus restoration, reduced motion, no-JavaScript
  content, and 320 px layouts.
- Treat `src/data`, `src/config/photography-publication.json`, and
  `public/media/photography` as a reviewed snapshot. Use `npm run data:import`
  and `npm run data:check`; do not patch generated records to hide failures.
- Before publishing, run `npm run release:check` and inspect the built artifact
  boundary for private paths, exact timestamps, and development harness code.
