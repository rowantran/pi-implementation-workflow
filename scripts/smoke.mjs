import { createJiti } from "jiti/static";

const registrations = {
  commands: [],
  events: [],
  renderers: [],
  shortcuts: [],
  tools: [],
};

const pi = {
  on(name) {
    registrations.events.push(name);
  },
  registerCommand(name) {
    registrations.commands.push(name);
  },
  registerEntryRenderer(name) {
    registrations.renderers.push(name);
  },
  registerShortcut(name) {
    registrations.shortcuts.push(name);
  },
  registerTool(tool) {
    registrations.tools.push(tool.name);
  },
};

const jiti = createJiti(import.meta.url, { moduleCache: false });
const implementationWorkflow = await jiti.import(
  new URL("../src/index.ts", import.meta.url).pathname,
  { default: true },
);
implementationWorkflow(pi);

const expected = {
  commands: [
    "workflow-plan",
    "workflow-implement",
    "workflow-review",
    "workflow-next",
    "workflow-dashboard",
  ],
  events: ["before_agent_start", "tool_call", "agent_settled", "session_start", "session_shutdown"],
  renderers: ["implementation-workflow-completion"],
  shortcuts: ["ctrl+alt+d"],
  tools: ["workflow_update_plan", "workflow_questions"],
};

for (const [kind, names] of Object.entries(expected)) {
  const actual = registrations[kind];
  for (const name of names) {
    if (!actual.includes(name)) throw new Error(`Missing ${kind} registration: ${name}`);
  }
}

if (registrations.commands.length !== expected.commands.length) {
  throw new Error(`Unexpected command registrations: ${registrations.commands.join(", ")}`);
}

console.log("Smoke test passed: extension loaded and registered its commands, events, renderer, shortcut, and tools.");
