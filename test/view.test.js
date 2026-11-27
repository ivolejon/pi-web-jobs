import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  formatElapsed,
  formatTimestamp,
  groupJobs,
  isOverview,
  statusText,
} from "../browser/view.js";

const job = (name, overrides = {}) => ({
  name,
  schedule: "",
  enabled: true,
  locks: [],
  status: "never",
  startedAt: null,
  durationSeconds: null,
  nextAt: null,
  runId: null,
  running: false,
  ...overrides,
});

test("groupJobs separates running, scheduled and manual jobs", () => {
  const groups = groupJobs([
    job("manual-b"),
    job("running-z", { running: true }),
    job("scheduled-a", { schedule: "daily 02:00" }),
    job("running-a", { running: true }),
  ]);
  assert.deepEqual(groups.running.map((entry) => entry.name), ["running-a", "running-z"]);
  assert.deepEqual(groups.scheduled.map((entry) => entry.name), ["scheduled-a"]);
  assert.deepEqual(groups.manual.map((entry) => entry.name), ["manual-b"]);
});

test("format helpers render times, durations and absent values", () => {
  assert.equal(formatTimestamp(null), "-");
  assert.equal(formatTimestamp("not a date"), "-");
  assert.match(formatTimestamp("2026-01-02T00:00:00Z", "en-GB"), /2026/);
  assert.equal(formatElapsed("2026-01-02T00:00:00Z", Date.parse("2026-01-02T00:00:05Z")), "5s");
  assert.equal(formatElapsed("2026-01-02T00:00:00Z", Date.parse("2026-01-02T00:02:05Z")), "2m 5s");
  assert.equal(formatElapsed("2026-01-02T00:00:00Z", Date.parse("2026-01-02T01:02:05Z")), "1h 2m");
  assert.equal(formatDuration(null), "-");
  assert.equal(formatDuration(7.04), "7.0s");
  assert.equal(formatDuration(125), "2m 5s");
  assert.equal(statusText(job("a", { status: "failed", durationSeconds: 1.5 })), "failed · 1.5s");
  assert.equal(statusText(job("a", { running: true })), "running");
});

test("isOverview accepts the server shape and rejects malformed responses", () => {
  const valid = { version: 1, config: { path: "/w/jobs.toml", exists: true }, jobs: [job("a")] };
  assert.equal(isOverview(valid), true);
  assert.equal(isOverview({ ...valid, jobs: [{ name: "a" }] }), false);
  assert.equal(isOverview({ ...valid, version: 2 }), false);
  assert.equal(isOverview(null), false);
});
