import { formatElapsed, formatTimestamp, groupJobs, isOverview, statusText } from "./view.js";

const REFRESH_MS = 2000;

const style = `
  :host { display: block; height: 100%; overflow: auto; }
  .jobs { display: flex; flex-direction: column; gap: 18px; padding: 16px; max-width: 1100px; }
  .toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .toolbar h2 { margin: 0; font-size: 1.1rem; }
  .toolbar .muted { margin-top: 4px; }
  h2, h3, h4 { margin: 0; }
  h3 { font-size: .95rem; margin-bottom: 8px; }
  h4 { font-size: .95rem; }
  .muted { opacity: .65; font-size: .85rem; }
  .empty { margin: 0; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
  .card { display: flex; flex-direction: column; gap: 8px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 8px; padding: 12px; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { padding: 6px 8px; text-align: left; vertical-align: top; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
  th { font-size: .8rem; font-weight: 600; opacity: .7; }
  .notice { margin: 0; }
  .error { border: 1px solid color-mix(in srgb, #c33 45%, transparent); border-radius: 8px; padding: 10px 12px; }
  .error p { margin: 6px 0 0; }
  pre { margin: 0; padding: 10px; border-radius: 8px; background: color-mix(in srgb, currentColor 7%, transparent); max-height: 340px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: .8rem; }
`;

export function defineJobsPanel() {
  if (customElements.get("jobs-panel") !== undefined) return;
  customElements.define("jobs-panel", JobsPanel);
}

class JobsPanel extends HTMLElement {
  #root = this.attachShadow({ mode: "closed" });
  #style = document.createElement("style");
  #integration;
  #releaseStyles;
  #context;
  #timer;
  #controller;
  #sequence = 0;
  #loading = true;
  #data;
  #error;
  #notice;
  #busy = new Set();
  #log;

  constructor() {
    super();
    this.#style.textContent = style;
  }

  set stylesheetIntegration(value) {
    this.#integration = value;
    if (this.isConnected) this.#registerStyles();
  }

  get stylesheetIntegration() {
    return this.#integration;
  }

  set context(value) {
    this.#context = value;
    if (this.isConnected) this.#start();
    else this.#render();
  }

  get context() {
    return this.#context;
  }

  connectedCallback() {
    this.#registerStyles();
    this.#start();
  }

  disconnectedCallback() {
    this.#stop();
    this.#releaseStyles?.();
    this.#releaseStyles = undefined;
  }

  #registerStyles() {
    this.#releaseStyles?.();
    this.#releaseStyles = this.#integration?.registerRoot(this.#root, { sharedUi: true });
  }

  #start() {
    this.#stop();
    void this.#reload();
    this.#timer = setInterval(() => {
      if (!document.hidden) void this.#reload(true);
    }, REFRESH_MS);
  }

  #stop() {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#controller?.abort();
    this.#controller = undefined;
  }

  #peer() {
    const peer = this.#context?.peer;
    return peer !== null && typeof peer === "object" && typeof peer.request === "function" ? peer : undefined;
  }

  async #reload(silent = false) {
    const peer = this.#peer();
    if (peer === undefined) {
      this.#loading = false;
      this.#data = undefined;
      this.#error = "The Jobs backend is unavailable. Enable the plugin and restart the session daemon.";
      this.#render();
      return;
    }
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    const sequence = ++this.#sequence;
    if (!silent) {
      this.#loading = true;
      this.#error = undefined;
      this.#render();
    }
    try {
      const result = await peer.request("overview", {}, { signal: controller.signal });
      if (sequence !== this.#sequence) return;
      if (!isOverview(result)) throw new Error("The Jobs backend returned an invalid response");
      this.#data = result;
      this.#error = undefined;
      this.#loading = false;
    } catch (error) {
      if (sequence !== this.#sequence || controller.signal.aborted) return;
      this.#error = message(error);
      this.#loading = false;
    }
    this.#render();
  }

  async #run(name) {
    const peer = this.#peer();
    if (peer === undefined) return;
    this.#busy.add(name);
    this.#notice = undefined;
    this.#render();
    try {
      const result = await peer.request("run", { name });
      this.#notice = result?.finished === true ? `Ran ${name}.` : `Started ${name}.`;
      if (this.isConnected) setTimeout(() => void this.#reload(true), 300);
    } catch (error) {
      this.#notice = message(error);
    } finally {
      this.#busy.delete(name);
      this.#render();
    }
  }

  async #stopJob(name) {
    const peer = this.#peer();
    if (peer === undefined) return;
    this.#busy.add(name);
    this.#notice = undefined;
    this.#render();
    try {
      const result = await peer.request("stop", { name });
      this.#notice = result?.message || `Stopped ${name}.`;
      if (this.isConnected) setTimeout(() => void this.#reload(true), 300);
    } catch (error) {
      this.#notice = message(error);
    } finally {
      this.#busy.delete(name);
      this.#render();
    }
  }

  async #showLog(name) {
    const peer = this.#peer();
    if (peer === undefined) return;
    this.#log = { name, loading: true };
    this.#render();
    try {
      const result = await peer.request("logs", { name });
      this.#log = { name, content: typeof result?.log === "string" ? result.log : "", status: result?.status };
    } catch (error) {
      this.#log = { name, error: message(error) };
    }
    this.#render();
  }

  #render() {
    const view = element("div", { class: "jobs" });
    view.append(element("div", { class: "toolbar" },
      element("div", {},
        element("h2", { text: "Jobs" }),
        element("div", { class: "muted", text: this.#data?.config.path ?? this.#context?.workspace?.label ?? "" }),
      ),
      button("Refresh", () => void this.#reload(), { className: "ui-button" }),
    ));
    if (this.#notice !== undefined) {
      view.append(element("p", { class: "notice", role: "status", text: this.#notice }));
    }
    if (this.#error !== undefined) {
      view.append(element("div", { class: "error", role: "alert" },
        element("strong", { text: "Could not load jobs" }),
        element("p", { text: this.#error }),
      ));
    }
    if (this.#loading && this.#data === undefined) {
      view.append(element("p", { class: "muted", text: "Loading jobs…" }));
    } else if (this.#data !== undefined) {
      this.#renderData(view);
    }
    if (this.#log !== undefined) this.#renderLog(view);
    this.#root.replaceChildren(this.#style, view);
  }

  #renderData(view) {
    if (!this.#data.config.exists) {
      view.append(element("p", { class: "empty", text: "No jobs.toml in this workspace." }),
        element("p", { class: "muted", text: `Expected at ${this.#data.config.path}.` }));
      return;
    }
    const groups = groupJobs(this.#data.jobs);
    view.append(element("section", {},
      element("h3", { text: "Running now" }),
      groups.running.length === 0
        ? element("p", { class: "empty muted", text: "Nothing is running." })
        : element("div", { class: "cards" }, ...groups.running.map((job) => this.#runningCard(job))),
    ));
    view.append(element("section", {},
      element("h3", { text: "Scheduled" }),
      groups.scheduled.length === 0
        ? element("p", { class: "empty muted", text: "No scheduled jobs." })
        : this.#jobTable(groups.scheduled, true),
    ));
    view.append(element("section", {},
      element("h3", { text: "Manual" }),
      groups.manual.length === 0
        ? element("p", { class: "empty muted", text: "No manual jobs." })
        : this.#jobTable(groups.manual, false),
    ));
  }

  #runningCard(job) {
    const busy = this.#busy.has(job.name);
    return element("div", { class: "card" },
      element("h4", { text: job.name }),
      element("div", { class: "muted", text: job.schedule === "" ? "Manual runs" : job.schedule }),
      element("div", { class: "muted", text: `Started ${formatTimestamp(job.startedAt)}` }),
      element("div", { class: "muted", text: `Running for ${formatElapsed(job.startedAt)}` }),
      element("div", { class: "row" },
        button(busy ? "Stopping…" : "Stop", () => void this.#stopJob(job.name), {
          className: "ui-button",
          disabled: busy,
          title: `Stop ${job.name}`,
        }),
        button("Log", () => void this.#showLog(job.name), { className: "ui-button", title: `Show the log of ${job.name}` }),
      ),
    );
  }

  #jobTable(jobs, withSchedule) {
    const rows = jobs.map((job) => {
      const busy = this.#busy.has(job.name);
      const cells = [
        element("td", { text: job.name }),
        ...(withSchedule ? [element("td", { text: job.schedule })] : []),
        ...(withSchedule ? [element("td", { text: job.enabled ? (job.nextAt ? formatTimestamp(job.nextAt) : "unknown") : "disabled" })] : []),
        element("td", { text: statusText(job) }),
        element("td", {},
          element("div", { class: "row" },
            button("Run", () => void this.#run(job.name), {
              className: "ui-button",
              disabled: busy,
              title: `Run ${job.name}`,
            }),
            button("Log", () => void this.#showLog(job.name), { className: "ui-button", title: `Show the log of ${job.name}` }),
          ),
        ),
      ];
      return element("tr", {}, ...cells);
    });
    const headers = ["Job", ...(withSchedule ? ["Schedule", "Next"] : []), "Last", "Actions"];
    return element("table", {},
      element("thead", {}, element("tr", {}, ...headers.map((text) => element("th", { text })))),
      element("tbody", {}, ...rows),
    );
  }

  #renderLog(view) {
    const log = this.#log;
    view.append(element("section", {},
      element("div", { class: "toolbar" },
        element("h3", { text: `Log: ${log.name}` }),
        button("Hide", () => { this.#log = undefined; this.#render(); }, { className: "ui-button" }),
      ),
      log.loading === true
        ? element("p", { class: "muted", text: "Loading log…" })
        : log.error !== undefined
          ? element("p", { class: "error", text: log.error })
          : element("pre", { text: log.content === "" ? "(no output)" : log.content }),
    ));
  }
}

function element(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === "text") node.textContent = value;
    else if (key === "className") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function button(label, onClick, { className, disabled, title } = {}) {
  return element("button", {
    type: "button",
    class: className ?? "",
    disabled,
    title,
    text: label,
    onclick: onClick,
  });
}

function message(error) {
  if (error instanceof Error && error.message !== "") return error.message;
  return String(error);
}
