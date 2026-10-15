import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const IMAGE_ONLY_STAGES = [
  "intake",
  "pixel-sanitization",
  "geoclip-search",
  "panorama-discovery",
  "reference-rendering",
  "clip-ranking",
  "lightglue",
  "depth-picks",
  "pnp-fov-solving",
  "frustum-checks",
  "overlay-audit",
  "sealing",
  "metadata-evaluation",
  "publication-refresh",
];

const secretName = /(key|token|secret|credential|authorization|exif|gps)/i;
const urlPattern = /https?:\/\/\S+/gi;
const windowsPath = /[A-Za-z]:\\[^\s"']+/g;
const slashPath = /(?:file:\/\/\/)?[A-Za-z]:\/[^\s"'<>]+/g;

export function redactRunValue(value, key = "") {
  if (secretName.test(key)) return "[redacted]";
  if (Array.isArray(value))
    return value.map((item) => redactRunValue(item, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactRunValue(childValue, childKey),
      ]),
    );
  if (typeof value === "string")
    return value
      .replace(urlPattern, "[provider-url-redacted]")
      .replace(windowsPath, "[private-path-redacted]")
      .replace(slashPath, "[private-path-redacted]");
  return value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function createStructuredRunLogger({ root, experimentId }) {
  const startedAtMs = Date.now();
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const runId = `${experimentId}-${timestamp}-${process.pid}`;
  const directory = path.join(root, ".private", "photo-image-only-runs", runId);
  const eventsPath = path.join(directory, "events.jsonl");
  await mkdir(directory, { recursive: true });
  const events = [];
  const stageIndexByPhoto = new Map();

  async function event(stage, detail = {}) {
    const index = IMAGE_ONLY_STAGES.indexOf(stage);
    if (index < 0) throw new Error(`Unknown image-only stage: ${stage}`);
    const photoId = detail.photoId ?? "run";
    const previous = stageIndexByPhoto.get(photoId) ?? -1;
    if (index < previous)
      throw new Error(`Out-of-order image-only event for ${photoId}: ${stage}`);
    stageIndexByPhoto.set(photoId, index);
    const record = redactRunValue({
      sequence: events.length + 1,
      at: new Date().toISOString(),
      experimentId,
      runId,
      stage,
      ...detail,
    });
    events.push(record);
    await appendFile(eventsPath, `${JSON.stringify(record)}\n`);
    const status = record.status ? ` / ${record.status}` : "";
    console.log(
      `[event ${record.sequence}] ${stage}${record.photoId ? ` / ${record.photoId}` : ""}${status}`,
    );
    return record;
  }

  async function finish(summary) {
    const stageTimingsMs = {};
    for (const item of events) {
      const elapsed = Math.max(0, new Date(item.at).getTime() - startedAtMs);
      stageTimingsMs[item.stage] = Math.max(
        stageTimingsMs[item.stage] ?? 0,
        elapsed,
      );
    }
    const sanitizedSummary = redactRunValue({
      runId,
      experimentId,
      durationMs: Date.now() - startedAtMs,
      stageElapsedMs: stageTimingsMs,
      ...summary,
    });
    await writeFile(
      path.join(directory, "summary.json"),
      `${JSON.stringify(sanitizedSummary, null, 2)}\n`,
    );
    await writeFile(
      path.join(directory, "sanitized-evidence.json"),
      `${JSON.stringify(events, null, 2)}\n`,
    );
    const rows = events
      .map(
        (item) =>
          `<tr><td>${item.sequence}</td><td>${escapeHtml(item.at)}</td><th>${escapeHtml(item.stage)}</th><td>${escapeHtml(item.photoId ?? "run")}</td><td><pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre></td></tr>`,
      )
      .join("\n");
    await writeFile(
      path.join(directory, "timeline.html"),
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(runId)}</title><style>body{font:14px system-ui;margin:2rem;color:#172018;background:#f4f2e9}table{border-collapse:collapse;width:100%}th,td{border:1px solid #aeb5a8;padding:.6rem;vertical-align:top;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:12px ui-monospace}</style><h1>Metadata-free pose run</h1><p>${escapeHtml(runId)}</p><table><thead><tr><th>#</th><th>Time</th><th>Stage</th><th>Photo</th><th>Sanitized evidence</th></tr></thead><tbody>${rows}</tbody></table></html>`,
    );
    return {
      runId,
      directory,
      reportPath: path.join(directory, "timeline.html"),
    };
  }

  return { runId, directory, eventsPath, event, finish };
}
