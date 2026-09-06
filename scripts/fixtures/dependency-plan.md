# Implementation plan

## Goal

Make every implementation plan show how its changes depend on one another, so readers can follow the work from its first steps to a verified result.

## Planned Changes

### PC-01: Parse dependency fields

**Depends on**
None

**What**
Add a required Depends on field to each planned change. Read either None or a comma-separated list of planned-change identifiers. Keep the dependencies in the plan Markdown and its existing version history.

**Why**
Agents need one simple format to write. Storing dependencies beside the change keeps the approved plan and its graph together.

**Pseudocode**
```text
type DependencyNode:
    id: PlannedChangeId
    title: Text
    dependsOn: List<PlannedChangeId>

Parse the dependency field into DependencyNode.dependsOn.
Keep an omitted field distinct from an explicit empty list in older plans.
```

### PC-02: Reject invalid dependency graphs

**Depends on**
PC-01

**What**
Check that all referenced changes exist and that there are no duplicate dependencies, self-dependencies, or cycles. Show draft warnings and block implementation until the graph is valid.

**Why**
A diagram alone does not establish a usable order. A cycle would mean that each change waits for another change that cannot proceed.

### PC-03: Draw the dependency graph

**Depends on**
PC-01

**What**
Generate a top-down Mermaid diagram from the parsed dependencies. Show every planned change, including changes with no prerequisites. Keep invalid and older plans readable without inventing a graph.

**Why**
Readers need to see the independent branches and the points where their results come together. Rendering is separate from authoring, so agents do not need to maintain diagram syntax.

### PC-04: Connect the graph to the plan reader

**Depends on**
PC-03

**What**
Let readers select a node to inspect the change and highlight its prerequisites and downstream changes. Provide Requires and Enables links plus a text dependency list.

**Why**
The diagram should explain the plan, not replace its details. Linked navigation keeps a selected change in the context of the complete plan.

### PC-05: Guide implementation order

**Depends on**
PC-02

**What**
Tell the implementer to follow the approved dependencies rather than assume that numbered reading order is execution order. Ask for clarification when a newly discovered prerequisite changes the approved plan.

**Why**
The graph should guide real work. Independent branches can proceed without an artificial barrier, but concurrent edits still need coordination.

### PC-06: Document the plan format

**Depends on**
None

**What**
Explain the Depends on field, arrow direction, draft warnings, and the Dependency graph section in Guided view. Include a small branching example and a local preview command.

**Why**
Users and agents need a clear contract for the new format. Documentation can be prepared from the agreed design without waiting for the implementation branches.

### PC-07: Verify the complete workflow

**Depends on**
PC-02, PC-04, PC-05, PC-06

**What**
Run the automated workflow tests and inspect the generated dashboard in a real browser. Exercise node selection, dependency navigation, themes, version comparison, and invalid-plan fallback.

**Why**
All branches must work together before the feature is ready. Passing parser tests is not enough to establish that the diagram is readable or interactive.

## Testing

- A valid branching plan saves its dependencies in each numbered Markdown version and displays all seven changes in the graph.
- A plan with missing dependency fields, unknown identifiers, or a cycle can be saved as a draft with a warning, but cannot advance to implementation.
- Selecting PC-04 highlights PC-03 and PC-01 as prerequisites and PC-07 as a downstream change. The reader can open each related change without losing its identity.
- The graph remains readable in light and dark themes. Its text dependency list remains usable when Mermaid is unavailable.
- Comparing two versions reports changed dependencies rather than only diagram formatting changes.
- The existing planning, implementation, review, and dashboard tests pass without modifying older approved plans.
