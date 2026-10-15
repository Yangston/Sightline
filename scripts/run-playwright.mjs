import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const production = process.env.PLAYWRIGHT_USE_PREVIEW === "1";
const providerTests = process.env.PLAYWRIGHT_PROVIDER_TESTS === "1";
const port = Number(process.env.PLAYWRIGHT_PORT ?? 4333);
const astroCli = path.join(root, "node_modules/astro/bin/astro.mjs");
const playwrightCli = path.join(root, "node_modules/@playwright/test/cli.js");
const testEnvironment = {
  ...process.env,
  ASTRO_DEV_BACKGROUND: "1",
  NODE_ENV: production ? "production" : "development",
  PUBLIC_GOOGLE_MAP_TILES_API_KEY: providerTests
    ? process.env.PUBLIC_GOOGLE_MAP_TILES_API_KEY
    : "sightline-browser-test-key",
  PUBLIC_CESIUM_ION_TOKEN: providerTests
    ? process.env.PUBLIC_CESIUM_ION_TOKEN
    : "",
};
const serverArguments = [
  astroCli,
  production ? "preview" : "dev",
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
];
const server = spawn(process.execPath, serverArguments, {
  cwd: root,
  env: testEnvironment,
  stdio: "inherit",
});

async function waitForServer() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (server.exitCode !== null)
      throw new Error(
        "The Astro browser-test server exited before it was ready.",
      );
    try {
      const response = await fetch(`http://127.0.0.1:${port}`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for the Astro browser-test server.");
}

function runPlaywright() {
  return new Promise((resolve, reject) => {
    const runner = spawn(
      process.execPath,
      [playwrightCli, "test", ...process.argv.slice(2)],
      {
        cwd: root,
        env: { ...testEnvironment, PLAYWRIGHT_EXTERNAL_SERVER: "1" },
        stdio: "inherit",
      },
    );
    runner.once("error", reject);
    runner.once("exit", (code, signal) =>
      signal
        ? reject(new Error(`Playwright exited after ${signal}.`))
        : resolve(code ?? 1),
    );
  });
}

let exitCode = 1;
try {
  await waitForServer();
  exitCode = await runPlaywright();
} finally {
  if (process.platform === "win32" && server.pid && server.exitCode === null)
    spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  else server.kill();
}
process.exitCode = exitCode;
