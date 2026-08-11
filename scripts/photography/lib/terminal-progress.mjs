import process from "node:process";

const clearTerminalLine = "\r\u001B[2K";
const defaultMilestoneCount = 20;
const defaultInteractiveActivityIntervalMs = 1_000;
const defaultRedirectedActivityIntervalMs = 30_000;

/**
 * @typedef {object} ProgressStream
 * @property {(chunk: string) => unknown} write
 * @property {boolean} [isTTY]
 * @property {number} [columns]
 */

function fitLine(prefix, detail, columns) {
  if (!Number.isInteger(columns) || columns <= 1) return `${prefix}${detail}`;

  const maximumLength = columns - 1;
  if (prefix.length + detail.length <= maximumLength)
    return `${prefix}${detail}`;

  const availableDetailLength = maximumLength - prefix.length;
  if (availableDetailLength <= 3)
    return `${prefix}${detail}`.slice(0, maximumLength);

  return `${prefix}...${detail.slice(-(availableDetailLength - 3))}`;
}

export function formatElapsedTime(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatProgressLine({ current, total, label, detail, columns }) {
  const countWidth = Math.max(1, String(total).length);
  const percentage = total > 0 ? Math.round((current / total) * 100) : 100;
  const prefix = `[${String(current).padStart(countWidth)}/${total} | ${String(percentage).padStart(3)}%] ${label}: `;
  return fitLine(prefix, detail, columns);
}

export function shouldReportProgress(
  current,
  total,
  milestoneCount = defaultMilestoneCount,
) {
  if (total <= 0 || current <= 0) return false;
  if (current === 1 || current === total) return true;

  const interval = Math.max(1, Math.ceil(total / Math.max(1, milestoneCount)));
  return current % interval === 0;
}

/**
 * @param {{
 *   total: number,
 *   label: string,
 *   stream?: ProgressStream,
 *   interactive?: boolean,
 *   milestoneCount?: number,
 * }} options
 */
export function createProgressReporter({
  total,
  label,
  stream = process.stdout,
  interactive = Boolean(stream.isTTY),
  milestoneCount = defaultMilestoneCount,
}) {
  let interactiveLineActive = false;

  return {
    update(current, detail) {
      if (!interactive && !shouldReportProgress(current, total, milestoneCount))
        return;
      if (total <= 0) return;

      const line = formatProgressLine({
        current,
        total,
        label,
        detail,
        columns: interactive ? stream.columns : undefined,
      });

      if (interactive) {
        stream.write(`${clearTerminalLine}${line}`);
        interactiveLineActive = true;
      } else {
        stream.write(`${line}\n`);
      }
    },
    finish() {
      if (!interactive || !interactiveLineActive) return;
      stream.write("\n");
      interactiveLineActive = false;
    },
  };
}

/**
 * @param {{
 *   label: string,
 *   detail: string,
 *   stream?: ProgressStream,
 *   interactive?: boolean,
 *   interactiveIntervalMs?: number,
 *   redirectedIntervalMs?: number,
 * }} options
 */
export function createActivityReporter({
  label,
  detail,
  stream = process.stdout,
  interactive = Boolean(stream.isTTY),
  interactiveIntervalMs = defaultInteractiveActivityIntervalMs,
  redirectedIntervalMs = defaultRedirectedActivityIntervalMs,
}) {
  let active = false;
  let currentDetail = detail;
  let startedAt = 0;
  let timer;
  let interactiveLineActive = false;

  function render() {
    const elapsed = formatElapsedTime(Date.now() - startedAt);
    const prefix = `[${elapsed}] ${label}: `;
    const line = fitLine(
      prefix,
      currentDetail,
      interactive ? stream.columns : undefined,
    );
    if (interactive) {
      stream.write(`${clearTerminalLine}${line}`);
      interactiveLineActive = true;
    } else {
      stream.write(`${line}\n`);
    }
  }

  function finish(status) {
    if (!active) return;
    if (timer !== undefined) clearInterval(timer);
    if (interactive && interactiveLineActive) stream.write("\n");
    const elapsed = formatElapsedTime(Date.now() - startedAt);
    stream.write(`${status} ${label} (${elapsed}).\n`);
    timer = undefined;
    active = false;
    interactiveLineActive = false;
  }

  return {
    start() {
      if (active) return;
      active = true;
      startedAt = Date.now();
      render();
      timer = setInterval(
        render,
        interactive ? interactiveIntervalMs : redirectedIntervalMs,
      );
      timer.unref?.();
    },
    update(nextDetail) {
      currentDetail = nextDetail;
      if (!active) this.start();
      else render();
    },
    succeed() {
      finish("Completed");
    },
    fail() {
      finish("Failed");
    },
  };
}

/**
 * @template Result
 * @param {Parameters<typeof createActivityReporter>[0]} options
 * @param {(update: (detail: string) => void) => Promise<Result>} task
 * @returns {Promise<Result>}
 */
export async function withActivity(options, task) {
  const activity = createActivityReporter(options);
  activity.start();
  try {
    const result = await task((detail) => activity.update(detail));
    activity.succeed();
    return result;
  } catch (error) {
    activity.fail();
    throw error;
  }
}
