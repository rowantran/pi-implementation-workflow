**What**

Extend the existing plan-directory format so later snapshots can contain followups under `planned-changes/<slug>/`, alongside unchanged original changes. Keep `working-plan/`, `plan-versions/vN/`, `latest-plan`, and the existing prepare/finalize tool; do not introduce `followups.json` or a dedicated mutation tool.

Add schema version 2 readers and validators in `src/planned-changes.ts` and `src/plan-storage.ts`. Continue reading schema version 1 snapshots and workflow metadata version 6 without rewriting them. Initial planning can retain schema version 1; the first post-approval prepare upgrades the editable manifest, not the approved snapshot.

**Why**

Followups are planned changes, so they should use the same Markdown files, stable IDs, snapshots, and editing flow. Validation can protect the approved baseline without making the agent use a second interface.

**Pseudocode**

`PlannedChange`, `PlanVersion`, and `SourceEvidence` already exist. These shared types define the additions; JSON uses explicit tags for alternatives.

```text
type DecisionSource:
    sessionId
    userEntryId
    verbatimUserText

type FollowupOrigin:
    reviewNumber
    sessionId
    entryId

type FollowupDecision =
    Proposed
    | Accepted { source: DecisionSource }
    | Dismissed { source: DecisionSource, reason: nonempty text }

type RequirementSource =
    OriginalAsk
    | PlanSection { name: goal | intro | testing }
    | Change { id }

type ScopeEffect =
    Addition
    | Amendment { requirements: [{ source: RequirementSource, quotedRequirement }] }

type FollowupDefinition:
    change: PlannedChange
    testing: Markdown
    origin: FollowupOrigin
    decision: FollowupDecision
    effect: ScopeEffect

type ImplementationEvidence:
    definitionDigest
    scopeFingerprint
    contentCommit
    sourceEvidence: SourceEvidence[]
    verification: nonempty text

type ImplementationRecord =
    Pending { reason: nonempty text }
    | Implemented { evidence: ImplementationEvidence }

type SavedChange =
    Original { change: PlannedChange }
    | Followup { definition: FollowupDefinition,
                 implementation: ImplementationRecord }
```

Schema version 2 keeps `plan.json` limited to `schemaVersion` and `readingOrder`. Original directories keep exactly `change_metadata.json` and `change.md`; their metadata remains exactly `title` and `dependsOn`. A followup directory has:

- `change_metadata.json`: exactly `title`, `dependsOn`, and `followup`; the latter holds `origin`, `decision`, and `effect` from the types above.
- `change.md`: the full explanation of the change.
- `testing.md`: its executable acceptance criteria.
- Optional `implementation.json`: an `ImplementationRecord`; absence means Pending, not completed.

`readingOrder` includes every directory once, including proposed and dismissed followups, so their identity and history remain visible. Active scope filters by decision. A followup label comes from metadata, not a title prefix or Markdown heading. Reuse existing slug/path checks and reject unexpected files and metadata fields.

```text
procedure ValidateSnapshotEvolution(approved, previous, candidate):
    validate schema, required prose, safe paths, and complete reading order
    require candidate's original goal, intro, testing, and change files
            are byte-for-byte equal to the approved snapshot
    require original IDs remain the original prefix of readingOrder
    require all post-approval changes have Followup metadata
    require previously published followup IDs and origins are retained

    validate combined dependency graph and amendment references
    reject accepted work requiring a proposed or dismissed prerequisite
    reject dismissal that leaves accepted work with a missing prerequisite
    reject unknown targets, self-links, and dependency/amendment cycles
    return Valid
```

Complexity: O(b + n + e + a) validation time and space for `b` source bytes, `n` changes, `e` dependency edges, and `a` amendment links, using indexed references and iterative graph traversal. Existing sorted snapshot capture/digest work adds O(f log f) time for `f` files, plus filesystem I/O.

Keep `approvedPlanVersion` fixed as the original approval baseline. New post-approval snapshots advance `latest-plan`; they do not replace that approval or mutate earlier snapshots. Retain followup IDs after dismissal instead of deleting directories or reusing IDs. Original directories cannot be reclassified as followups. Followup order after the original prefix remains controlled by readingOrder.

Use the existing publication lock, isolated snapshot, draft-base check, link protection, digest verification, and atomic pointer publication. The draft remains editable on failure. Validate the baseline inside the publication lock, not only in the tool callback. Publishing still creates no Git commit; the existing command handoff, review, and cleanup paths commit finalized history through `commitWorkflowArtifacts`. Extend artifact validation to understand version 2 while preserving its allowlist and unrelated staged files.
