import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

const cesiumSource = "node_modules/cesium/Build/Cesium";
const cesiumBaseUrl = "cesium";
const productionBuild = process.argv.includes("build");
const checking = process.argv.includes("check");
const cesiumDevelopmentUrl = `/@fs/${resolve(cesiumSource).replaceAll("\\", "/")}`;
const vercel = productionBuild
  ? (await import("@astrojs/vercel")).default
  : undefined;
const viteStaticCopy = productionBuild
  ? (await import("vite-plugin-static-copy")).viteStaticCopy
  : undefined;
const cesiumCopyPlugins = viteStaticCopy
  ? viteStaticCopy({
      targets: ["Assets", "ThirdParty", "Widgets", "Workers"].map((name) => ({
        src: `${cesiumSource}/${name}`,
        dest: cesiumBaseUrl,
        rename: { stripBase: 4 },
      })),
    }).filter((plugin) => plugin.apply === "build")
  : [];

export default defineConfig({
  site: "https://sightline.stoneyang.ca",
  output: "static",
  compressHTML: true,
  prefetch: { prefetchAll: false, defaultStrategy: "hover" },
  devToolbar: { enabled: false },
  ...(productionBuild
    ? {
        adapter: vercel({
          imageService: true,
          webAnalytics: { enabled: true },
        }),
      }
    : {}),
  integrations: [react(), sitemap()],
  vite: {
    // Astro check optimizes with a different React mode; keep its cache away
    // from the running development server so jsxDEV cannot be overwritten.
    cacheDir: `node_modules/.vite/sightline-${productionBuild ? "build" : checking ? "check" : "dev"}`,
    define: {
      CESIUM_BASE_URL: JSON.stringify(
        productionBuild ? `/${cesiumBaseUrl}` : cesiumDevelopmentUrl,
      ),
    },
    resolve: {
      alias: productionBuild
        ? []
        : [
            {
              find: /^cesium$/,
              replacement: resolve(
                "node_modules/cesium/Build/CesiumUnminified/index.js",
              ),
            },
          ],
    },
    optimizeDeps: {
      exclude: ["cesium"],
      noDiscovery: true,
      include: [
        "@astrojs/react/client.js",
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-dev-runtime",
        "react/jsx-runtime",
        "zod",
      ],
    },
    server: {
      watch: {
        ignored: [
          "**/.private/**",
          "**/.venv-photo-calibration/**",
          "**/public/media/photography/**",
          "**/src/content/photography/iCloud Photos/**",
        ],
      },
    },
    plugins: [tailwindcss(), ...cesiumCopyPlugins],
  },
});
