**What**

Add a tool-owned `followups.json` to each workflow bundle. Reuse the existing `PlannedChange` shape for each followup's ID, title, direct prerequisites, and full Markdown explanation. Store its acceptance criteria, source, user decision, and implementation evidence separately from that definition.

Extend `WorkflowFiles` in `src/storage.ts` and the durable-file allowlist in `src/git.ts`. Add strict loading and atomic mutation helpers in a focused module such as `src/followups.ts`. Missing files mean an empty followup list; malformed existing files stop the operation rather than silently losing work. Keep workflow metadata version 6 and plan schema version 1 readable without rewriting their artifacts.

**Why**

The next session needs a durable description of the agreed work, not a conversation summary or a list of raw review concerns. Keeping followups outside the frozen snapshot preserves the original approval and avoids changing existing plan-directory rules.

**Pseudocode**

`PlannedChange`, `WorkflowFiles`, and `SourceEvidence` already exist in the repository. These are the shared followup types for the rest of the plan; JSON uses explicit tags for the alternatives below.

```text
type DecisionSource:
    sessionId
    userEntryId
    verbatimUserText
    recordedAt                         # set by extension, not the model

type FollowupOrigin =
    ReviewDiscussion { reportNumber, sessionId, entryId }
    | ManualRequest { sessionId, userEntryId }

type RequirementSource =
    OriginalAsk
    | PlanSection { name: goal | intro | testing }
    | Change { id }                    # original change or an earlier followup

type ScopeEffect =
    Addition
    | Amendment { requirements: [{ source: RequirementSource, quotedRequirement }] }

type FollowupDefinition:
    change: PlannedChange
    testing: Markdown                 # executable acceptance criteria
    effect: ScopeEffect               # body describes the replacement, if any

type ImplementationEvidence:
    definitionDigest                  # computed from the exact definition
    scopeFingerprint                  # requirements used during verification
    contentCommit                     # set using workflowContentHead
    sourceEvidence: SourceEvidence[]  # supplied by implementer
    verification: nonempty text       # commands/checks and observed results

type ImplementationProgress =
    Pending { reason: nonempty text }
    | Implemented { evidence: ImplementationEvidence }

type FollowupDecision =
    Proposed
    | Accepted { source: DecisionSource, progress: ImplementationProgress }
    | Dismissed { source: DecisionSource, reason: nonempty text }

type Followup:
    definition: FollowupDefinition
    origin: FollowupOrigin
    decision: FollowupDecision

type FollowupStore:
    schemaVersion: 1
    revision: nonnegative integer
    items: Followup[]                  # stable order of creation

procedure SaveFollowups(files, approvedPlan, expectedRevision, nextItems):
    acquire cross-process workflow followup lock
    current = read and strictly validate followups.json, or empty revision 0
    if current.revision != expectedRevision:
        return StaleRevision(current.revision), without writing

    validate types, nonempty prose, source references, and safe unique slugs
    reject collisions with original planned-change IDs, including dismissed IDs
    validate dependencies across original changes and non-dismissed followups
    reject accepted work requiring a proposed or dismissed followup
    reject dismissal that would break another accepted change's prerequisite
    validate amendment targets and quoted requirements against saved definitions

    next = FollowupStore(1, current.revision + 1, nextItems)
    atomically replace followups.json with next
    release lock
    return Saved(next.revision)
```

Complexity: with `b` total stored prose bytes, `n` original and followup changes, and `e` dependency edges, validation and serialization take O(b + n + e) time and space, excluding filesystem and lock-wait costs. Use the existing iterative dependency-validation approach.

Serialize same-process tool mutations with Pi's `withFileMutationQueue` as well as the cross-process lock. Add the temporary files and lock to local Git excludes; reject symlinks and unsafe artifact paths. Use the repository's lock timeout/recovery conventions rather than a new indefinite lock.

IDs are never reused, including after dismissal. Editing an accepted definition requires another explicit user decision and resets its progress to Pending. Do not delete records to hide rejected or completed work; Git commits preserve earlier definitions and decisions. Keep meaningful dismissed proposals, such as the rejected FRED helper rewrite, available as context.

Commit successful mutations locally through `commitWorkflowArtifacts`, preserving unrelated staged and uncommitted code. Report publication, commit, and dashboard failures separately: if publication succeeds but Git fails, retain the record and say it was saved but not committed. Retry the artifact commit without duplicating the followup. Commands that hand off, review, or clean up must retry pending artifact commits before proceeding. Never push from the followup tool.
