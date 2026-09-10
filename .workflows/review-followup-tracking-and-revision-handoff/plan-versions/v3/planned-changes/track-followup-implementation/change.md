**What**

Track implementation progress for every original planned change and every accepted followup in `planned-changes/<slug>/implementation.json`. Use one format and one work-selection procedure; being an original change does not imply completion. After checking committed code, the implementer prepares the plan draft, edits these files, and finalizes through `workflow_update_plan`.

Give the next session a complete list of unassessed, pending, completed, and stale changes. Preserve independent review verdicts separately from implementation evidence. The directory slug of this planned change stays `track-followup-implementation` for stable references; its behavior applies to all changes.

**Why**

A fresh implementer otherwise cannot tell whether the original plan was completed or interrupted. Shared progress records let the agent continue missing work without rebuilding completed changes or inferring completion from a phase name or the existence of a pull request.

**Pseudocode**

Use `SavedChange`, `ImplementationRecord`, and `ImplementationEvidence` from `store-review-followups`, with `WorkflowScope` from `combine-original-and-followup-scope`. Unassessed means no completion decision has been recorded; Pending means work is known to remain.

```text
type ChangeWork =
    AssessWork { change: SavedChange }
    | PendingWork { change: SavedChange, reason }
    | RecheckWork { change: SavedChange, reason }
    | RecordedComplete { change: SavedChange, evidence: ImplementationEvidence }

procedure ChangeRequirementsDigest(scope, changeId):
    shared = original ask, original goal/intro/testing, and saved clarifications
    required = { changeId }
    include accepted amendments to shared requirements in required

    traverse with a visited set until required stops growing:
        include declared prerequisites of every required change
        include accepted amendments that target any required change

    definitions = required changes' behavioral definitions and criteria,
                  in current readingOrder, excluding decisions/provenance/progress
    return hash(shared, definitions)
```

Complexity: O(b + n + e + a) time and space for `b` bytes examined/hashed, `n` active changes, `e` dependency edges, and `a` indexed amendment links. Use a queue and reverse amendment index to avoid repeatedly scanning the whole plan. The visited set handles repeated context links without changing the execution dependency graph.

The digest includes applicable amendments and prerequisites, not unrelated followup additions. Accepting an unrelated followup at the same code HEAD must not reset completed original work. Keep the whole-scope fingerprint in evidence as provenance and for validation when writing a record, but do not require it to remain equal for an unrelated change's completion to stay usable.

```text
procedure ClassifyChangeWork(scope, contentHead, applicableReport):
    index applicable report results by stable change ID
    results = []
    for each change in scope.changes:       # originals AND accepted followups
        id = underlying PlannedChange.id from change.definition
        record = change.implementation
        if record is Unassessed:
            append AssessWork(change)
        else if record is Pending:
            append PendingWork(change, record.reason)
        else if record.evidence.definitionDigest != ChangeRequirementsDigest(scope, id)
             or record.evidence.contentCommit != contentHead:
            append RecheckWork(change, "Requirements or code changed")
        else if applicableReport has an unresolved result associated with id:
            append RecheckWork(change, "Review needs attention")
        else:
            append RecordedComplete(change, record.evidence)
    return results
```

Complexity: O(n × (b + n + e + a) + r) worst-case time when computing each digest separately, and O(b + n + e + a + r) space when hashing one change at a time; `r` is indexed report data. Git and snapshot reads are additional. Plans are small; more complex shared digest caching is not required.

An applicable report covers the current code and requirement fingerprint. A change's non-yes necessity/sufficiency result, associated non-yes testing result, or blocking/warning concern requires attention; informational notes alone do not. Preserve unassigned holistic and original plan-wide testing concerns as separate handoff obligations instead of pretending they identify a specific unfinished change. A stale report can guide inspection but is not current proof of completion or failure.

```text
procedure ValidateImplementationDraft(context, previous, candidate):
    require bound implementation session
    allow only the initial format-1-to-2 manifest conversion, if needed,
               plus implementation.json changes for active changes
    require all original and followup requirement files remain unchanged
    scope = requirement-only scope of candidate
    currentHead = workflowContentHead(context.exec, context.metadata)
    require no uncommitted code changes outside workflow artifacts

    for each (id, record) from a changed planned-changes/<id>/implementation.json:
        if record is Implemented:
            require contentCommit equals currentHead
            require definitionDigest equals ChangeRequirementsDigest(scope, id)
            require scopeFingerprint equals hash(whole requirement-only scope)
            require code locations and observed verification results are nonempty
        else if record is Pending:
            require a nonempty reason identifying remaining work
        else:
            reject removing an existing assessment; reopen with Pending and a reason

    recheck code content and requirement sources immediately before publication
    allow existing finalize procedure to publish the progress snapshot
```

Complexity: O(k × (b + n + e + a) + b + f log f) worst-case local time and O(b + f + n + e + a) space for `k` updated completion records and `f` snapshot files, plus Git, locking, and filesystem costs. Other variables are defined above.

Enable prepare/finalize from the very first implementation session, even before any followup exists. Preparing from version 1 upgrades only the editable manifest to version 2. Its result supplies the whole-scope fingerprint, current content head, and each active change's effective requirement digest. Preserve unsaved edits, but reject requirement edits or unrelated unfinished review work at implementation finalization. The existing expectedBaseVersion check prevents attaching evidence to a newer saved plan.

The normal implementer checks every active change. For AssessWork, inspect current code and use relevant saved review/test evidence; then record Implemented or Pending. This also fills missing records in older workflows without rewriting the approved snapshot or automatically trusting that an earlier implementation session finished. For PendingWork and RecheckWork, verify what is already present before making edits. An already satisfied original or followup can be recorded without a new code commit.

Before handing off a finished implementation, refresh completed records against the final delivered code and write an explicit pending reason for every assessed unfinished change. A partial run records verified completions and remaining work; interruption before an assessment is saved leaves Unassessed work rather than a false completion. There is no mandatory in-progress marker or separate phase state machine.

Any changed code content requires checking old evidence, even when its commit is ancestral: a later commit could have reverted the change. This changes the next action to recheck, not to reimplement. Artifact-only commits leave the content head unchanged. The validator checks evidence shape and repository state, not the truth of an agent's explanation; prompts still require actual inspection and execution of relevant checks. Finalization creates no Git commit, so the implementer commits and pushes progress snapshots with the normal delivery.
