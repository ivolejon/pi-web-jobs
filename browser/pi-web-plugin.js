import { defineJobsPanel } from "./jobs-panel.js";

/**
 * The Jobs tab: the selected workspace's jobctl jobs, their schedules, the runs
 * that are in progress now, logs, and Run and Stop actions.
 *
 * The browser entry renders the panel and calls its paired server entry for the
 * workspace's jobs.toml and the machine's jobctl state.
 */

const stylesheetIntegrationCapability = {
  pluginId: "pi-web",
  id: "stylesheet-integration",
  version: 1,
  parse(value) {
    if (
      typeof value !== "object"
      || value === null
      || typeof value.registerRoot !== "function"
      || typeof value.createController !== "function"
      || typeof value.subscribe !== "function"
    ) {
      throw new Error("Stylesheet integration v1 requires registerRoot, createController and subscribe");
    }
    return value;
  },
};

let stylesheetIntegration;

const plugin = {
  apiVersion: 5,
  name: "Jobs",
  requires: [stylesheetIntegrationCapability],
  activate: ({ html, svg }) => {
    defineJobsPanel();
    return {
      start({ capabilities }) {
        try {
          stylesheetIntegration = capabilities.resolve(stylesheetIntegrationCapability);
        } catch {
          stylesheetIntegration = undefined;
        }
      },
      contributions: {
        workspacePanels: [
          {
            id: "workspace.jobs",
            title: "Jobs",
            icon: svg`
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="5" width="18" height="16" rx="2"></rect>
                <path d="M8 3v4"></path>
                <path d="M16 3v4"></path>
                <path d="M3 10h18"></path>
                <path d="M8 14h3"></path>
                <path d="M8 17h6"></path>
              </svg>
            `,
            order: 46,
            invalidationResources: ["workspace.files"],
            render: (context) =>
              html`<jobs-panel .context=${context} .stylesheetIntegration=${stylesheetIntegration}></jobs-panel>`,
          },
        ],
      },
    };
  },
};

export default plugin;
