import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "../server/plugin.js";

const RUN_ID = "20260102T000000Z-abcdef";
const JOBS = [{
  name: "alpha",
  schedule: "daily 02:00",
  locks: ["alpha"],
  enabled: true,
  status: "running",
  startedAt: "2026-01-02T00:00:00Z",
  durationSeconds: null,
  nextAt: "2026-01-03T02:00:00Z",
}];

async function sandbox(t, { jobs = JOBS, receipt = true, old = false, missingBinary = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-jobs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const bin = join(root, "bin");
  await mkdir(workspace, { recursive: true });
  await mkdir(state, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(workspace, "jobs.toml"), "[jobs.alpha]\ncommand = \"true\"\nschedule = \"daily 02:00\"\n");

  if (receipt) {
    const dir = join(state, "runs", "alpha", RUN_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "meta.json"), JSON.stringify({
      version: 1,
      job: "alpha",
      runId: RUN_ID,
      trigger: "schedule",
      status: "running",
      command: "true",
      cwd: workspace,
      schedule: "daily 02:00",
      startedAt: "2026-01-02T00:00:00Z",
      endedAt: null,
      durationSeconds: 0,
      exitCode: null,
      signal: null,
      waitedSeconds: 0,
      log: "output.log",
    }));
    await writeFile(join(dir, "output.log"), "line one\nline two\n");
  }

  const script = join(bin, "jobctl");
  await writeFile(script, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FAKE_CALLS) fs.appendFileSync(process.env.FAKE_CALLS, args.join(" ") + "\\n");
if (args[0] === "list") {
  if (process.env.FAKE_LIST_FAIL) { process.stderr.write("boom from jobctl"); process.exit(78); }
  process.stdout.write(process.env.FAKE_JOBS || "[]");
} else if (args[0] === "run") {
  if (process.env.FAKE_RUN_FAIL) { process.stderr.write("lock busy or wait timeout exceeded"); process.exit(126); }
  if (process.env.FAKE_RUN_SLEEP) setTimeout(() => process.exit(0), Number(process.env.FAKE_RUN_SLEEP));
  else process.exit(0);
} else if (args[0] === "stop") {
  if (process.env.FAKE_OLD) { process.stderr.write("unknown command \\"stop\\""); process.exit(2); }
  process.stderr.write("stopped job \\"" + args[1] + "\\" (interrupted)\\n");
} else {
  process.stderr.write("unknown command");
  process.exit(2);
}
`, { mode: 0o755 });

  const calls = join(root, "calls");
  const settings = {
    binary: missingBinary ? join(root, "missing-jobctl") : script,
    stateDir: state,
  };
  const context = {
    settings,
    dataDirectory: root,
    logger: { error() {} },
  };
  const peer = plugin.activate(context).peer;
  const scope = { kind: "workspace", workspace: { path: workspace, id: "workspace", label: "workspace" } };
  const request = (operation, input = {}, signal = new AbortController().signal) =>
    peer.request({ scope, operation, input, signal });

  const set = (name, value) => {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    return () => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    };
  };
  const restore = [
    set("FAKE_CALLS", calls),
    set("FAKE_JOBS", JSON.stringify(jobs)),
    set("FAKE_LIST_FAIL", undefined),
    set("FAKE_RUN_FAIL", undefined),
    set("FAKE_RUN_SLEEP", undefined),
    set("FAKE_OLD", old ? "1" : undefined),
    set("JOBCTL_STATE_DIR", undefined),
    set("JOBCTL_BIN", undefined),
  ];
  t.after(() => restore.forEach((fn) => fn()));
  return { root, workspace, state, calls, request, set };
}

test("overview merges jobctl jobs with the latest receipt", async (t) => {
  const s = await sandbox(t);
  const result = await s.request("overview");
  assert.equal(result.version, 1);
  assert.equal(result.config.exists, true);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].name, "alpha");
  assert.equal(result.jobs[0].running, true);
  assert.equal(result.jobs[0].status, "running");
  assert.equal(result.jobs[0].runId, RUN_ID);
  assert.equal(result.jobs[0].nextAt, "2026-01-03T02:00:00Z");
  assert.deepEqual(result.jobs[0].locks, ["alpha"]);
});

test("a workspace without jobs.toml is an empty overview", async (t) => {
  const s = await sandbox(t);
  await rm(join(s.workspace, "jobs.toml"));
  const result = await s.request("overview");
  assert.equal(result.config.exists, false);
  assert.deepEqual(result.jobs, []);
});

test("a missing jobctl binary is reported as such", async (t) => {
  const s = await sandbox(t, { missingBinary: true });
  await assert.rejects(s.request("overview"), /jobctl was not found/);
});

test("a failing jobctl list keeps its diagnostic", async (t) => {
  const s = await sandbox(t);
  s.set("FAKE_LIST_FAIL", "1");
  await assert.rejects(s.request("overview"), /boom from jobctl/);
});

test("run validates the job and starts jobctl", async (t) => {
  const s = await sandbox(t, { jobs: [{ ...JOBS[0], status: "never", startedAt: null }] });
  s.set("FAKE_RUN_SLEEP", "1500");
  const result = await s.request("run", { name: "alpha" });
  assert.equal(result.started, true);
  const calls = await readFile(s.calls, "utf8");
  assert.match(calls, /run alpha --config .*jobs\.toml --state-dir .*state --trigger manual/);
});

test("run rejects an unknown job", async (t) => {
  const s = await sandbox(t);
  await assert.rejects(s.request("run", { name: "missing" }), /Unknown job/);
});

test("run returns a quick jobctl failure", async (t) => {
  const s = await sandbox(t);
  s.set("FAKE_RUN_FAIL", "1");
  await assert.rejects(s.request("run", { name: "alpha" }), /lock busy/);
});

test("stop calls jobctl stop", async (t) => {
  const s = await sandbox(t);
  const result = await s.request("stop", { name: "alpha" });
  assert.equal(result.stopped, true);
  assert.match(result.message, /stopped job "alpha"/);
});

test("an old jobctl reports the missing stop command", async (t) => {
  const s = await sandbox(t, { old: true });
  await assert.rejects(s.request("stop", { name: "alpha" }), (error) => error.code === "stop-unsupported");
});

test("stop reports a job that is not running", async (t) => {
  const s = await sandbox(t, { receipt: false });
  await assert.rejects(s.request("stop", { name: "alpha" }), /not running/);
});

test("logs returns the tail of the latest run", async (t) => {
  const s = await sandbox(t);
  const result = await s.request("logs", { name: "alpha" });
  assert.equal(result.runId, RUN_ID);
  assert.equal(result.log, "line one\nline two\n");
});

test("logs caps a large file at the last 64 KiB", async (t) => {
  const s = await sandbox(t);
  const path = join(s.state, "runs", "alpha", RUN_ID, "output.log");
  await writeFile(path, "x".repeat(70 * 1024) + "end");
  const result = await s.request("logs", { name: "alpha" });
  assert.equal(result.log.length, 64 * 1024);
  assert.ok(result.log.endsWith("end"));
});

test("invalid input and unknown operations are refused", async (t) => {
  const s = await sandbox(t);
  await assert.rejects(s.request("run", { name: "Bad_Name" }), /Invalid job name/);
  await assert.rejects(s.request("overview", {}, AbortSignal.abort()), /cancelled/);
  await assert.rejects(s.request("nope"), /Unknown Jobs operation/);
});
