import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

const exec = promisify(execFile);

const JOB_NAME = /^[a-z0-9-]+$/;
const RUN_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/;
const LIST_TIMEOUT_MS = 10_000;
const RUN_PROBE_MS = 400;
const MAX_LOG_BYTES = 64 * 1024;

const plugin = {
  apiVersion: 5,
  name: "Jobs",
  activate(context) {
    const settings = readSettings(context.settings);
    return {
      peer: {
        async request({ scope, operation, input, signal }) {
          if (!scope || scope.kind !== "workspace" || typeof scope.workspace?.path !== "string") {
            throw new Error("Jobs requires a workspace");
          }
          try {
            switch (operation) {
              case "overview":
                return await overview(scope.workspace.path, settings, signal);
              case "run":
                return await runJob(scope.workspace.path, settings, input, signal);
              case "stop":
                return await stopJob(settings, input);
              case "logs":
                return await readLog(settings, input, signal);
              default:
                throw new Error(`Unknown Jobs operation: ${String(operation)}`);
            }
          } catch (error) {
            context.logger?.error?.("Jobs request failed", {
              operation,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
      },
    };
  },
};

export default plugin;

function readSettings(value) {
  const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  const binary = typeof source.binary === "string" && source.binary.trim() !== ""
    ? resolveBinary(source.binary.trim())
    : resolveBinary((process.env.JOBCTL_BIN || "jobctl").trim());
  return {
    binary,
    stateDir: typeof source.stateDir === "string" && source.stateDir.trim() !== "" ? source.stateDir.trim() : undefined,
    config: typeof source.config === "string" && source.config.trim() !== "" ? source.config.trim() : undefined,
  };
}

function resolveBinary(value) {
  if (value === "~" || value.startsWith("~/") || value.includes("/")) {
    return resolvePath(value, process.cwd());
  }
  return value;
}

async function overview(workspacePath, settings, signal) {
  const config = configPath(workspacePath, settings);
  const stateDir = stateDirectory(settings);
  if (!(await exists(config))) {
    return { version: 1, config: { path: config, exists: false }, stateDir, jobs: [] };
  }
  const listed = await listJobs(config, stateDir, settings, signal);
  const jobs = await Promise.all(listed.map(async (job) => {
    const receipt = await latestReceipt(stateDir, job.name);
    const status = receipt?.status ?? job.status ?? "never";
    return {
      name: job.name,
      schedule: typeof job.schedule === "string" ? job.schedule : "",
      enabled: job.enabled !== false,
      locks: Array.isArray(job.locks) ? job.locks.filter((lock) => typeof lock === "string") : [],
      status,
      startedAt: receipt?.startedAt ?? job.startedAt ?? null,
      durationSeconds: numeric(receipt?.durationSeconds ?? job.durationSeconds),
      nextAt: typeof job.nextAt === "string" ? job.nextAt : null,
      runId: receipt?.runId ?? null,
      running: status === "running",
    };
  }));
  jobs.sort((left, right) => left.name.localeCompare(right.name));
  return { version: 1, config: { path: config, exists: true }, stateDir, jobs };
}

async function listJobs(config, stateDir, settings, signal) {
  const { stdout } = await jobctl(settings, ["list", "--json", "--config", config, "--state-dir", stateDir], signal);
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("jobctl list returned invalid JSON");
  }
  if (!Array.isArray(value)) throw new Error("jobctl list returned an unexpected response");
  return value.filter((job) => job !== null && typeof job === "object" && typeof job.name === "string");
}

async function runJob(workspacePath, settings, input, signal) {
  const name = jobName(input);
  const config = configPath(workspacePath, settings);
  const stateDir = stateDirectory(settings);
  if (!(await exists(config))) throw new Error("jobs.toml was not found in this workspace");
  const listed = await listJobs(config, stateDir, settings, signal);
  if (!listed.some((job) => job.name === name)) throw new Error(`Unknown job: ${name}`);
  const child = spawn(settings.binary, [
    "run", name, "--config", config, "--state-dir", stateDir, "--trigger", "manual",
  ], {
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  let stderr = "";
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
  }
  const early = await probe(child);
  if (early.running) {
    child.removeAllListeners("error");
    child.unref();
    return { started: true, name };
  }
  if (early.error) throw new Error(early.error.message);
  if (early.code !== 0) {
    throw new Error(stderr.trim() || `jobctl run exited with ${early.code ?? early.signal}`);
  }
  return { started: true, name, finished: true };
}

async function stopJob(settings, input) {
  const name = jobName(input);
  const stateDir = stateDirectory(settings);
  const receipt = await latestReceipt(stateDir, name);
  if (receipt === null || receipt.status !== "running") {
    throw new Error(`Job ${name} is not running`);
  }
  const child = spawn(settings.binary, ["stop", name, "--state-dir", stateDir], {
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  let stderr = "";
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
  }
  const early = await probe(child);
  if (early.running) {
    child.removeAllListeners("error");
    child.unref();
    return { stopped: true, name, message: `Stop requested for ${name}.` };
  }
  if (early.error) throw new Error(early.error.message);
  if (early.code !== 0) {
    if (/unknown command|unknown flag|unexpected argument/i.test(stderr)) {
      const unsupported = new Error("This jobctl version has no stop command. Update jobctl to a version that includes it.");
      unsupported.code = "stop-unsupported";
      throw unsupported;
    }
    throw new Error(stderr.trim() || `jobctl stop exited with ${early.code ?? early.signal}`);
  }
  return { stopped: true, name, message: stderr.trim() || `Stopped ${name}.` };
}

function probe(child) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ running: true }), RUN_PROBE_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ error });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function readLog(settings, input, signal) {
  const name = jobName(input);
  const stateDir = stateDirectory(settings);
  const receipt = await latestReceipt(stateDir, name);
  if (receipt === null) throw new Error(`No run recorded for ${name}`);
  const path = join(stateDir, "runs", name, receipt.runId, basename(receipt.log || "output.log"));
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`No log for the latest run of ${name}`);
  }
  const start = Math.max(0, info.size - MAX_LOG_BYTES);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(info.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    if (signal?.aborted) throw new Error("Request cancelled");
    return { name, runId: receipt.runId, status: receipt.status, log: buffer.toString("utf8") };
  } finally {
    await handle.close();
  }
}

async function latestReceipt(stateDir, name) {
  const base = join(stateDir, "runs", name);
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return null;
  }
  let latest = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
    let receipt;
    try {
      receipt = JSON.parse(await readFile(join(base, entry.name, "meta.json"), "utf8"));
    } catch {
      continue;
    }
    if (receipt === null || typeof receipt !== "object" || receipt.job !== name) continue;
    if (typeof receipt.startedAt !== "string" || !Number.isFinite(Date.parse(receipt.startedAt))) continue;
    if (latest !== null && Date.parse(receipt.startedAt) <= Date.parse(latest.startedAt)) continue;
    latest = {
      ...receipt,
      runId: entry.name,
      log: typeof receipt.log === "string" ? receipt.log : "output.log",
    };
  }
  return latest;
}

async function jobctl(settings, args, signal, timeout = LIST_TIMEOUT_MS) {
  try {
    const result = await exec(settings.binary, args, {
      timeout,
      signal,
      maxBuffer: 1 << 20,
      env: process.env,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error?.code === "ENOENT") {
      const missing = new Error(`jobctl was not found at ${settings.binary}. Set plugins.jobs.settings.binary to its path.`);
      missing.code = "jobctl-missing";
      throw missing;
    }
    if (signal?.aborted) {
      const aborted = new Error("Request cancelled");
      aborted.name = "AbortError";
      throw aborted;
    }
    if (error?.killed || error?.code === "ETIMEDOUT" || error?.signal) {
      throw new Error(`jobctl ${args[0]} did not finish within ${Math.round(timeout / 1000)} s`);
    }
    const detail = String(error?.stderr || error?.message || "").trim();
    const failure = new Error(detail || `jobctl ${args[0]} failed`);
    failure.code = typeof error?.code === "number" ? error.code : "jobctl-failed";
    throw failure;
  }
}

function jobName(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("A job name is required");
  }
  const name = input.name;
  if (typeof name !== "string" || !JOB_NAME.test(name)) throw new Error("Invalid job name");
  return name;
}

function configPath(workspacePath, settings) {
  if (settings.config !== undefined) return resolvePath(settings.config, workspacePath);
  return join(workspacePath, "jobs.toml");
}

function stateDirectory(settings) {
  if (settings.stateDir !== undefined) return resolvePath(settings.stateDir, homedir());
  if (process.env.JOBCTL_STATE_DIR) return resolvePath(process.env.JOBCTL_STATE_DIR, process.cwd());
  if (process.env.XDG_STATE_HOME) return join(resolvePath(process.env.XDG_STATE_HOME, homedir()), "jobctl");
  return join(homedir(), ".local", "state", "jobctl");
}

function resolvePath(value, base) {
  let text = value;
  if (text === "~") text = homedir();
  else if (text.startsWith("~/")) text = join(homedir(), text.slice(2));
  return isAbsolute(text) ? text : join(base, text);
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
