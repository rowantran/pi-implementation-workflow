**What**

Introduce one shared scope reader used by implementation, briefing, review, and the dashboard. It reads the exact approved plan and all accepted followup definitions, including implemented followups. Original changes retain their IDs and reading order; accepted followups appear afterward in creation order and use the same dependency graph.

Distinguish added requirements from explicit amendments. An accepted amendment changes only the cited requirement; it does not erase the original change or authorize unrelated departures. Pass proposed and dismissed items as discussion context, not implementation requirements.

**Why**

The FRED decisions changed the originally approved repository layout and registration ordering. Simply adding tasks while retaining the existing prompt's absolute original-plan precedence would cause the implementer or next reviewer to reject those agreed changes.

**Pseudocode**

`FollowupDefinition`, `FollowupOrigin`, and `ScopeEffect` come from `store-review-followups`. `PlanVersion` and `WorkflowClarifications` are existing repository types.

```text
type ScopedChange =
    Original { change: PlannedChange, approvedVersion }
    | FollowupChange { definition: FollowupDefinition, origin: FollowupOrigin }

type WorkflowScope:
    originalAsk
    approvedPlan: PlanVersion
    clarifications: WorkflowClarifications
    changes: ScopedChange[]
    amendments: accepted followup definitions whose effect is Amendment
    followupTesting: [{ followupId, criteria }]

procedure ReadWorkflowScope(files, metadata):
    approved = readPlanVersion(files, metadata.approvedPlanVersion)
    clarifications = readClarifications(files)
    followups = readFollowups(files)
    require approved exists and followup references/dependencies are valid

    accepted = followups.items whose decision is Accepted
    changes = approved.document.changes mapped to Original
    append accepted definitions mapped to FollowupChange
    testing = accepted definitions mapped to their testing criteria and IDs
    return WorkflowScope(metadata.ask, approved, clarifications,
                         changes, accepted amendments, testing)
```

Complexity: O(b + n + e) time and space for `b` source bytes, `n` original and followup changes, and `e` dependency edges, including validation and excluding file I/O latency.

Expose original prose and amendments together; do not mechanically replace text inside the original snapshot. Prompts must explain that an explicit accepted amendment governs the cited requirement and that unchanged original requirements still apply. Use clarification answers and their recorded dates when interpreting decisions. If two accepted instructions conflict without a clear explicit replacement, ask the user rather than assuming the newest task silently wins. Amendments to Testing must also be visible to the testing reviewer.

An amendment reference is not a dependency. Record `dependsOn` only when the work actually needs another change's result. Validate cycles across the combined graph, and preserve original edges. Where followup B amends followup A, A remains visible and is reviewed under that amendment, just like an original planned change.

Keep a canonical requirement-only representation for hashing: original ask, approved plan, clarifications, and accepted followup definitions in their stable order. Here, canonical means fixed field order and saved list order, including dependency lists. Its fingerprint is a hash used to detect changed requirements. Exclude proposal/dismissal discussions, completion evidence, timestamps, and the store's revision counter. Accepting, editing, or dismissing an accepted followup changes the requirements; recording its implementation does not. Reuse this same representation everywhere staleness is computed rather than letting dashboard, cleanup, and review disagree.
