# Sightline

Sightline locates an archival photograph, reconstructs its camera inside a 3D
city, and returns a viewer to the original line of sight. The public site is a
static, fail-closed showcase of reviewed results; reconstruction runs locally.

## Development

```sh
npm install
npm run dev
npm run release:check
```

Copy `.env.example` to `.env` to test optional providers. Both variables are
browser-visible and must be restricted by hostname and API or asset scope.

## Try a photograph

`/upload` is a separate, browser-local workspace. Choose a JPEG, PNG, or WebP
up to 40 MB. GPS metadata matches the featured city bounds; locations outside
those bounds get a custom scene. Files without GPS offer a city or coordinate
fallback. This local lookup does not reverse-geocode arbitrary city names.

The scene and camera draft are prepared immediately after a usable location
is available. Cesium and map providers load only after **Open 3D preview**.
The preview offers a camera frustum, photo alignment overlay, and direction,
tilt, roll, and field-of-view controls. Without configured or available 3D
providers, it uses a globe with the draft camera geometry. Photo files and
metadata remain in memory and are cleared when removed or when leaving the
page; they are never uploaded, persisted, or added to the reviewed collection.

These are approximate drafts, not automatically solved or verified poses.
Missing camera angles and lens data use visible starting estimates. EXIF
height is not geoid-corrected, and magnetic compass bearings are not treated
as true north. The offline reconstruction and review workflow below remains
the route for publishing a verified result.

## Data

The committed snapshot contains responsive public images and sanitized
reconstruction records. It intentionally excludes raw originals, EXIF,
provider renders, credentials, model caches, and detailed run evidence.

```sh
npm run data:check
npm run data:import -- --from=C:\path\to\Personal-Website
npm run sightline:setup
npm run sightline:reconstruct -- --ids=img-7492
npm run sightline:locate -- --experiment=sf-north-v1 --ids=img-7492
npm run sightline:verify -- --ids=img-7492
```

Snapshot imports are explicit releases; there is no automated dependency on
the portfolio repository.

## License

All source code, text, datasets, and media are all rights reserved. See
`LICENSE`.
