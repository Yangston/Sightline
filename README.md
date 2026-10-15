# Sightline

A collection of photographs and the places behind them. Built with Astro,
with opt-in 3D city viewers and an offline camera-pose reconstruction toolkit.

## Development

```sh
npm install
npm run dev
npm run release:check
```

The home page offers San Francisco, Toronto, and Taiwan. Each city opens its
3D map directly. `/explore` redirects home; `/methodology` explains the project.
The site has no separate galleries, AR pages, or upload demos.

Optional map providers use the browser-visible variables in `.env.example`.
Restrict them by hostname and API or asset scope. Cesium loads only after a
3D action. Provider imagery is never cached or stored by Sightline.

## Data

The reviewed snapshot contains responsive public images and sanitized
reconstruction records. Raw originals, EXIF, provider renders, credentials,
model caches, and detailed run evidence stay ignored. A solved pose is not
automatically verified or approved.

```sh
npm run data:check
npm run data:import -- --from=C:\path\to\Personal-Website
npm run sightline:setup
npm run sightline:reconstruct -- --ids=img-7492
npm run sightline:locate -- --experiment=sf-north-v1 --ids=img-7492
npm run sightline:verify -- --ids=img-7492
```

Imports are explicit snapshot releases. Starting photos are selected in
`src/lib/collection.ts` without altering the reviewed data.

## Publication

Run `npm run release:check` and inspect the built artifact before publishing.
The site is deployed to the existing Vercel Sightline project.

## License

All source code, text, datasets, and media are all rights reserved. See
`LICENSE`.
