**What**

Extend the existing plan-directory format to store followups alongside original changes. Every change has one `implemented` boolean in `change_metadata.json`. It records whether an implementer believes the change is done; it is not a review verdict or proof that every requirement was met.

Keep `working-plan/`, `plan-versions/vN/`, `latest-plan`, and prepare/edit/finalize. Add schema version 2 support in `src/planned-changes.ts` and `src/plan-storage.ts`, without a separate followup tool, task store, implementation file, or evidence format.

**Why**

Followups are planned changes, and implementation status is a small piece of change metadata. Both belong in the existing files and version history.

**Pseudocode**

`PlannedChange` and `PlanVersion` already exist. These shared types define the additions; JSON uses explicit tags for alternatives.

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

type ChangeDefinition =
    Original { change: PlannedChange }
    | Followup { definition: FollowupDefinition }

type SavedChange:
    definition: ChangeDefinition
    implemented: boolean               # implementer's assessment only
```

Schema version 2 keeps `plan.json` limited to `schemaVersion` and `readingOrder`. Every change directory has `change_metadata.json` and `change.md`. Original metadata contains exactly `title`, `dependsOn`, and `implemented`:

```json
{
  "title": "Implement queue redrive",
  "dependsOn": [],
  "implemented": false
}
```

Followup metadata adds `followup`, containing `origin`, `decision`, and `effect`. Followups also have `testing.md` for their acceptance criteria. Do not add `implementation.json`, completion hashes, evidence records, or more progress states.

New workflows use version 2 and new changes start with `implemented: false`. Update the skeleton generator, planning prompt, and fixtures to emit this field. Initial planning cannot mark changes implemented. Continue reading version 1 snapshots and workflow metadata version 6 without rewriting historical files: a version 1 change has an effective value of false. Preparing an older workflow upgrades the editable manifest and adds explicit false fields; the implementer can then mark already completed work without changing code. False means no current claim of completion, not proof the code is absent. Missing or non-boolean values in version 2 metadata are validation errors.

`readingOrder` includes all directories once, including proposed and dismissed followups. Active scope filters by decision, not by `implemented`. Preserve IDs after dismissal instead of deleting directories or reusing IDs. A followup label comes from metadata, not a title prefix or Markdown heading.

```text
procedure ValidateSnapshotEvolution(approved, previous, candidate):
    validate schema, boolean fields, prose, safe paths, and complete reading order
    require original goal, intro, testing, and change.md files remain byte-identical
    require original change metadata excluding implemented
            equals the approved metadata excluding implemented
    require original IDs remain the original prefix of readingOrder
    require every new requirement definition has Followup metadata
    require previously published followup IDs and origins are retained

    validate dependencies across originals and followups, and amendment references
    reject accepted work requiring proposed or dismissed prerequisites
    reject unknown targets, self-links, and dependency/amendment cycles
    return Valid
```

Complexity: O(b + n + e + a) validation time and space for `b` source bytes, `n` changes, `e` dependency edges, and `a` amendment links. Existing sorted snapshot capture/digest work adds O(f log f) time for `f` files, plus filesystem I/O.

The original approved version stays immutable. Later snapshots may change originals' `implemented` fields, but not their titles, dependencies, or explanations. Compare parsed original metadata without the flag instead of requiring that entire JSON file to remain byte-identical. Original changes cannot be reclassified as followups. Post-approval versions advance `latest-plan`, not `approvedPlanVersion`.

Retain the existing publication lock, isolated snapshot, expected-base check, link protection, snapshot integrity digest, and atomic pointer publication. These protect saved files; they do not certify implementation. Publishing still creates no Git commit. Existing handoff, review, and cleanup paths commit finalized history through `commitWorkflowArtifacts`, preserving unrelated staged files.
