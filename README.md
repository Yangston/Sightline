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
