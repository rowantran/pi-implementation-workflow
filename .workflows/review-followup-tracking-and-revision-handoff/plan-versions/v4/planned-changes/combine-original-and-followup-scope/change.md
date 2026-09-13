**What**

Introduce one shared scope reader for implementation, briefing, review, and the dashboard. Read both the pinned original approval and the latest finalized snapshot, then select original changes plus accepted followups from that snapshot. Original changes and accepted followups remain review requirements regardless of implemented. Load that boolean from the current snapshot as the implementer's assessment, never as proof of correctness or completion inferred from membership in the baseline.

Distinguish added requirements from explicit amendments. An accepted amendment changes only the cited requirement; it does not erase the original change or authorize unrelated departures. Proposed and dismissed items remain discussion context, not implementation requirements.

**Why**

The FRED decisions changed the approved repository layout and registration ordering. Merely adding tasks while retaining the prompt's absolute original-plan precedence would cause the implementer or next reviewer to reject the agreed design.

**Pseudocode**

Use `FollowupDefinition` and `SavedChange` from `store-review-followups`, with existing `PlanVersion` and `WorkflowClarifications` types.

```text
type WorkflowScope:
    originalAsk
    approvedPlan: PlanVersion
    currentPlan: PlanVersion
    clarifications: WorkflowClarifications
    changes: SavedChange[]             # originals plus accepted followups
    amendments: accepted followup definitions with Amendment effect
    followupTesting: [{ followupId, criteria }]

procedure ReadWorkflowScope(files, metadata):
    approved = readPlanVersion(files, metadata.approvedPlanVersion)
    current = read latest finalized plan version
    require approved and current exist
    validate current snapshot against its approval and published history
    clarifications = readClarifications(files)

    changes = current changes in readingOrder,
              retaining originals and accepted followups only
    normalize version 1 changes without an implemented field to implemented: false
    return WorkflowScope(metadata.ask, approved, current, clarifications,
                         changes, accepted amendments, accepted followup criteria)
```

Complexity: O(b + n + e + a) local scope construction and validation time/space for `b` source bytes, `n` changes, `e` dependencies, and `a` amendment links. Snapshot integrity reads and any history validation are additional existing storage costs.

Expose original prose and amendments together rather than mechanically replacing text inside the baseline. Prompts explain that explicit accepted amendments govern the cited requirements, while unrelated original requirements remain in force. Use saved clarification answers when interpreting decisions. Conflicting instructions without a clear explicit replacement require a user question, not an assumption that the newest item silently wins. Testing amendments also reach the testing reviewer.

An amendment reference is not a dependency. Keep `dependsOn` only for actual prerequisites, preserve original edges, and reject accepted amendments targeting proposed or dismissed followups. If followup B amends accepted followup A, A remains visible and is reviewed under that amendment, just like an original change.

Build one fixed-order, requirement-only value for hashing: original ask, normalized original plan, clarifications, and accepted followup requirements with their amendments in reading order. Its fingerprint is a hash used to detect changed requirements. Exclude plan version numbers, the manifest's format version, titles describing the whole snapshot, origins, decision provenance, proposed/dismissed discussions, and every implemented field, including those in the baseline. Format conversion or toggling the flag must not invalidate an unchanged review. Accepting, changing, reordering accepted work, or dismissing accepted work does change the fingerprint.

Resolve `latest-plan` once per operation to an exact version path, and send that path together with the exact baseline path to agents. Never let the baseline-only helper `planPathForWorkflow` silently remain the implementation scope source. Later turns may refresh to a newer finalized snapshot; changes during a review are handled by the existing source-change checks. Unsaved draft edits are never active requirements.
