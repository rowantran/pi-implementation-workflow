**What**

Extend the existing plan-directory format so later snapshots can contain followups under `planned-changes/<slug>/`, alongside unchanged original requirements. Every change, original or followup, uses the same implementation progress file. Keep `working-plan/`, `plan-versions/vN/`, `latest-plan`, and the existing prepare/finalize tool; do not introduce `followups.json` or a dedicated mutation tool.

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
    definitionDigest                  # effective requirements for this change
    scopeFingerprint                  # whole-scope provenance, not a completion gate
    contentCommit
    sourceEvidence: SourceEvidence[]
    verification: nonempty text

type ImplementationRecord =
    Unassessed
    | Pending { reason: nonempty text }
    | Implemented { evidence: ImplementationEvidence }

type ChangeDefinition =
    Original { change: PlannedChange }
    | Followup { definition: FollowupDefinition }

type SavedChange:
    definition: ChangeDefinition
    implementation: ImplementationRecord
```

Schema version 2 keeps `plan.json` limited to `schemaVersion` and `readingOrder`. Every change directory has `change_metadata.json` and `change.md`, and supports `implementation.json` using the same `ImplementationRecord` format. Original metadata remains exactly `title` and `dependsOn`. Followup metadata adds `followup`, containing `origin`, `decision`, and `effect`; followups also have `testing.md` for their executable acceptance criteria.

Only the implementation phase may save assessments or completion evidence; before approval, progress is absent or Unassessed. An absent `implementation.json` means Unassessed, not completed and not proof that the code is missing. Absence supports new changes and older snapshots; after assessing an active change, the implementer records Pending or Implemented explicitly. Proposed and dismissed followups are outside active implementation work. All progress files live in the editable draft and new snapshots, never inside a modified historical approval.

`readingOrder` includes every directory once, including proposed and dismissed followups, so their identity and history remain visible. Active scope filters by decision. A followup label comes from metadata, not a title prefix or Markdown heading. Reuse existing slug/path checks and reject unexpected files and metadata fields.

```text
procedure ValidateSnapshotEvolution(approved, previous, candidate):
    validate schema, required prose, safe paths, and complete reading order
    require candidate's original goal, intro, testing, change_metadata.json,
            and change.md files are byte-for-byte equal to the approved snapshot
    validate original and followup implementation.json files as progress data,
             separately from frozen requirements
    require original IDs remain the original prefix of readingOrder
    require all newly added requirement definitions have Followup metadata
    require previously published followup IDs and origins are retained

    validate dependencies across originals and followups, and amendment references
    reject accepted work requiring a proposed or dismissed prerequisite
    reject dismissal that leaves accepted work with a missing prerequisite
    reject unknown targets, self-links, and dependency/amendment cycles
    return Valid
```

Complexity: O(b + n + e + a) validation time and space for `b` source bytes, `n` changes, `e` dependency edges, and `a` amendment links, using indexed references and iterative graph traversal. Existing sorted snapshot capture/digest work adds O(f log f) time for `f` files, plus filesystem I/O.

Keep `approvedPlanVersion` fixed as the original approval baseline. New post-approval snapshots advance `latest-plan`; they do not replace that approval or mutate earlier snapshots. Retain followup IDs after dismissal instead of deleting directories or reusing IDs. Original directories cannot be reclassified as followups. Adding or updating their implementation.json in a new snapshot is a permitted progress update, not a rewrite of the approved requirements. Followup order after the original prefix remains controlled by readingOrder.

Use the existing publication lock, isolated snapshot, draft-base check, link protection, digest verification, and atomic pointer publication. The draft remains editable on failure. Validate the baseline inside the publication lock, not only in the tool callback. Publishing still creates no Git commit; the existing command handoff, review, and cleanup paths commit finalized history through `commitWorkflowArtifacts`. Extend artifact validation to understand version 2 while preserving its allowlist and unrelated staged files.
