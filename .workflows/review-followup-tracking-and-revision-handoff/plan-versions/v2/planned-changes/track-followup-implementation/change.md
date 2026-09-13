**What**

Record followup progress in each followup's optional `implementation.json`, not through a dedicated tool or by mixing completion into its requirements. After verifying committed code, the implementer prepares the plan draft, edits those evidence files, and calls the same `workflow_update_plan` finalize operation. Implementation-phase validation permits only those files to change.

Derive pending work from accepted requirements, saved evidence, current Git content, and the latest applicable report. Separate recorded completion from independent review approval.

**Why**

A fresh session needs to skip finished work and resume partial work without trusting a stale “done” flag. Keeping evidence separate also lets progress snapshots leave the requirement fingerprint unchanged.

**Pseudocode**

Use `ImplementationRecord` and `ImplementationEvidence` from `store-review-followups`, the fingerprint from `combine-original-and-followup-scope`, and report coverage from `review-original-and-followup-changes`.

```text
type FollowupWork =
    PendingWork { followup }
    | RecheckWork { followup, priorEvidence, reason }
    | RecordedComplete { followup, evidence }

procedure ClassifyFollowupWork(scope, contentHead, applicableReport):
    fingerprint = hash requirement-only scope
    index report results and testing groups by followup ID
    results = []
    for each accepted followup in scope.currentPlan:
        record = its implementation.json, or Pending("Not yet recorded")
        if record is Pending:
            append PendingWork(followup)
        else if record.evidence.definitionDigest != hash behavioral definition
             or record.evidence.scopeFingerprint != fingerprint
             or record.evidence.contentCommit != contentHead:
            append RecheckWork(followup, record.evidence, "Requirements or code changed")
        else if applicableReport has an unresolved verdict or concern for this followup:
            append RecheckWork(followup, record.evidence, "Review needs attention")
        else:
            append RecordedComplete(followup, record.evidence)
    return results
```

Complexity: O(b + n + r) local time and O(n + r) space for `b` bytes hashed, `n` followups, and `r` indexed review results/concerns, excluding Git and snapshot reads.

An applicable report covers the current content head and exact requirement fingerprint. Non-yes sufficiency, necessity, or testing results and blocking/warning concerns for the followup or its testing group require attention; informational notes alone do not. Stale reports remain useful context, not current completion evidence.

```text
procedure ValidateImplementationDraft(context, previous, candidate):
    require bound implementation session
    require draft changes only implementation.json files of accepted followups
    scope = requirement-only scope of candidate
    currentHead = workflowContentHead(context.exec, context.metadata)
    require no uncommitted code changes outside workflow artifacts

    for each changed implementation record:
        if record is Implemented:
            require contentCommit equals currentHead
            require definitionDigest matches this followup's behavioral definition
            require scopeFingerprint equals hash(scope)
            require code locations and observed verification results are nonempty
        else:
            require a nonempty pending reason

    recheck code content and requirement sources immediately before publication
    allow existing finalize procedure to publish the evidence-only snapshot
```

Complexity: O(b + f log f + n + e + a) local time and O(b + f + n + e + a) space for `b` bytes, `f` files, `n` changes, `e` dependencies, and `a` amendment links, including snapshot validation/digests. Git, lock, and filesystem costs are additional.

Enable prepare/finalize for implementation through the same phase-policy mechanism as `capture-review-decisions`. Its prepare result supplies the exact source fingerprint, content head, and per-followup behavioral digests for the evidence files. The implementer checks the code at those inputs before finalizing. If code changes after prepare, prepare again without discarding edits, obtain current values, and verify again. Finalization validates the submitted values against authoritative sources; the existing expectedBaseVersion check rejects a newer saved plan. Unrelated unsaved review edits are preserved but cannot be finalized by the implementation role.

A behavioral definition hash covers title, dependencies, explanation, criteria, and amendments, not provenance or completion. Existing stale records remain readable; only changed Implemented records must match current code and scope. Editing requirements naturally makes earlier evidence need rechecking, without asking the reviewer to alter completion files.

The validator checks evidence shape and state, not whether the agent's explanation proves correctness. Require actual code inspection and the stated checks. Already implemented work can be recorded without a new code commit. Record only completed followups after partial implementation; failed tests or interrupted tasks remain pending. To reopen work, write a Pending record with a reason; earlier evidence remains in plan history.

Any changed code content requires rechecking old evidence, even when its commit is an ancestor of HEAD: a later commit could have reverted the change. Recheck first, and only implement what is missing. Artifact-only commits leave `workflowContentHead` unchanged. Finalization is not a Git commit; the implementer commits and pushes the evidence snapshot with the normal delivery and leaves the worktree clean.
