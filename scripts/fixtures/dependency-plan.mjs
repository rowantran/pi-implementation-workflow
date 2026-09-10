import { makePlanDocument } from './plan-document.mjs';

export const dependencyPlan = makePlanDocument({
  goal: 'Show how planned changes depend on one another, from shared foundations to a verified result.',
  intro: 'Reading numbers help navigate this version. The stable slug identifies a change across edits and reordering; dependencies determine execution order.',
  changes: [
    {
      id: 'define-document', title: 'Define the directory document', dependsOn: [],
      content: '**What**\n\nKeep the goal, introduction, testing criteria, and each change in separate Markdown files. Store titles and dependency slugs in JSON metadata.\n\n```ts\ninterface PlannedChange {\n  id: string;\n  title: string;\n  dependsOn: string[];\n  content: string;\n}\n```\n\n**Why**\n\nSeparate metadata from prose so headings cannot change the dependency graph. Required What and Why sections explain each change. Headings and code examples remain ordinary content.',
    },
    {
      id: 'validate-graph', title: 'Reject invalid dependency graphs', dependsOn: ['define-document'],
      content: '**What**\n\nCheck unknown identifiers, duplicate dependencies, self-dependencies, and cycles before publishing a version.\n\n**Why**\n\n> A diagram alone does not establish a usable execution order. A cycle leaves each change waiting for another.',
    },
    {
      id: 'render-graph', title: 'Draw the dependency graph', dependsOn: ['define-document'],
      content: '**What**\n\nGenerate a top-down Mermaid diagram from the document. Include every node, including independent changes.\n\n```mermaid\nflowchart TD\n  Document --> Validation\n  Document --> Diagram\n```\n\n**Why**\n\nRendering is separate from authoring. Agents do not maintain diagram syntax for the authoritative dependency graph.',
    },
    {
      id: 'connect-reader', title: 'Connect the graph to the plan reader', dependsOn: ['render-graph'],
      content: '**What**\n\nSelect a node to highlight prerequisites and downstream changes. Read the prose through the outline; keep Requires and Enables links beside each change.\n\nSee [the graph renderer](#render-graph) for rendering details. This link keeps working when the reading order changes.\n\n**Why**\n\nReaders need to move between dependencies and the full design without losing their place.',
    },
    {
      id: 'guide-implementation', title: 'Guide implementation order', dependsOn: ['validate-graph'],
      content: '**What**\n\nFollow the approved dependencies, not numbered reading order. Independent branches can proceed without an artificial barrier, but overlapping edits still need coordination.\n\nAsk for clarification when a new prerequisite changes the approved plan.\n\n**Why**\n\nExecution must respect prerequisites while allowing independent work to proceed.',
    },
    {
      id: 'document-format', title: 'Document the plan format', dependsOn: [],
      content: '**What**\n\nExplain slug identity, display numbering, arrow direction, and the guided graph section. Documentation can begin from the agreed design without waiting for the implementation branches.\n\n| Identity | Purpose |\n| --- | --- |\n| Slug | Stable links and dependencies |\n| Number | Position in this version |\n\n**Why**\n\nReaders must distinguish stable identity from this version\'s reading order.',
    },
    {
      id: 'verify-workflow', title: 'Verify the complete workflow', dependsOn: ['validate-graph', 'connect-reader', 'guide-implementation', 'document-format'],
      content: '**What**\n\nRun automated tests and inspect the dashboard in a browser. Exercise selection, navigation, themes, rich prose, and version comparison.\n\n### Testing inside a change\n\nThis heading belongs to this change. It must not create another dashboard section or replace the document-level testing criteria.\n\n**Why**\n\nVerify that graph navigation and rich content still work together after all branches land.',
    },
  ],
  testing: '- All seven changes appear in reading order while edges point from prerequisites to dependents.\n- Selecting `connect-reader` highlights its two prerequisites and the final verification change.\n- Reordering preserves slug links and reports moves instead of deleted and added prose.\n- Tables, code, Mermaid, and arbitrary headings render safely in both reading modes.\n- Review context uses the exact approved version, even when a newer plan exists.',
});
