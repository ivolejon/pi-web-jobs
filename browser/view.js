/** Pure view helpers, kept free of the DOM so they can be tested with node --test. */

export function groupJobs(jobs) {
  const running = [];
  const scheduled = [];
  const manual = [];
  for (const job of jobs) {
    if (job.running) running.push(job);
    else if (job.schedule !== "") scheduled.push(job);
    else manual.push(job);
  }
  const byName = (left, right) => left.name.localeCompare(right.name);
  return {
    running: running.sort(byName),
    scheduled: scheduled.sort(byName),
    manual: manual.sort(byName),
  };
}

export function formatTimestamp(value, locale) {
  if (typeof value !== "string") return "-";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "-";
  return new Date(time).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

export function formatElapsed(startedAt, now = Date.now()) {
  if (typeof startedAt !== "string") return "-";
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return "-";
  let seconds = Math.max(0, Math.floor((now - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  let minutes = Math.floor(seconds / 60);
  seconds %= 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  minutes %= 60;
  return `${hours}h ${minutes}m`;
}

export function formatDuration(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "-";
  if (value < 60) return `${value.toFixed(1)}s`;
  let seconds = Math.round(value);
  let minutes = Math.floor(seconds / 60);
  seconds %= 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  minutes %= 60;
  return `${hours}h ${minutes}m`;
}

export function statusText(job) {
  if (job.running) return "running";
  if (job.durationSeconds !== null && job.durationSeconds !== undefined) {
    return `${job.status} · ${formatDuration(job.durationSeconds)}`;
  }
  return job.status;
}

export function isOverview(value) {
  return value !== null
    && typeof value === "object"
    && value.version === 1
    && value.config !== null
    && typeof value.config === "object"
    && typeof value.config.path === "string"
    && typeof value.config.exists === "boolean"
    && Array.isArray(value.jobs)
    && value.jobs.every((job) => job !== null
      && typeof job === "object"
      && typeof job.name === "string"
      && typeof job.schedule === "string"
      && typeof job.running === "boolean");
}
