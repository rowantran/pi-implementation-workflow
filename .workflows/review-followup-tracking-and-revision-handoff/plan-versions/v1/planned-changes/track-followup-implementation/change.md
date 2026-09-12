**What**

Add implementation-only `RecordImplementation` and `Reopen` operations to `workflow_followups`. Store evidence only after the requested behavior and its acceptance criteria have been checked against committed code. Compute the commit, definition digest, and requirement fingerprint in the extension rather than accepting an arbitrary “done” flag from the model.

Derive the next session's work from accepted definitions, implementation evidence, current Git content, and the latest applicable report. Distinguish pending changes from completed changes that need another check; never equate an old completion record with proof that a requirement still holds.

**Why**

A fresh session must skip work that is genuinely finished, resume a partial implementation, and detect edits or rebases that make previous evidence unreliable. Progress must remain separate from independent review approval.

**Pseudocode**

Use `ImplementationEvidence` and `ImplementationProgress` from `store-review-followups`, the requirement fingerprint from `combine-original-and-followup-scope`, and report coverage from `review-original-and-followup-changes`.

```text
type FollowupWork =
    PendingWork { followup }
    | RecheckWork { followup, priorEvidence, reason }
    | RecordedComplete { followup, evidence }

procedure ClassifyFollowupWork(scope, store, contentHead, applicableReport):
    fingerprint = hash canonical requirement-only scope
    index applicableReport's focused results and testing groups by followup ID
    results = []
    for each accepted followup in store:
        if progress is Pending:
            append PendingWork(followup)
        else if evidence.definitionDigest != digest(followup.definition)
             or evidence.scopeFingerprint != fingerprint
             or evidence.contentCommit != contentHead:
            append RecheckWork(followup, evidence, "Requirements or code changed")
        else if applicableReport has an unresolved verdict/concern for this followup
             or its testing group:
            append RecheckWork(followup, evidence, "Review needs attention")
        else:
            append RecordedComplete(followup, evidence)
    return results
```

Complexity: O(b + n + r) time and O(n + r) space for `b` definition bytes hashed, `n` followups, and `r` indexed report results/concerns. This excludes reading Git and stored artifacts.

An applicable report must cover the current content head and exact requirement fingerprint. Treat non-yes sufficiency or testing results, non-yes necessity results, and blocking/warning concerns for the followup as requiring attention; informational notes alone do not reopen work. A stale report remains useful context but is not evidence of current completion or failure.

```text
procedure RecordImplementation(context, id, expectedRevision,
                               expectedContentHead, expectedScopeFingerprint,
                               evidenceInput):
    require bound implementation session
    require accepted followup exists
    require worktree is clean after any pending artifact commit retry
    scope = ReadWorkflowScope(context.files, context.metadata)
    head = workflowContentHead(context.exec, context.metadata)
    require head is available and equals expectedContentHead
    require hash(scope requirements) equals expectedScopeFingerprint
    require evidenceInput contains code locations and observed verification results

    evidence = ImplementationEvidence(
        digest(current definition), hash(scope requirements), head,
        evidenceInput.sourceEvidence, evidenceInput.verification)
    recheck clean code state and unchanged requirement fingerprint before publication
    publish Implemented(evidence) using expectedRevision
    commit workflow artifacts and refresh dashboard
```

Complexity: O(b + n + e) local time and space for `b` source bytes, `n` original and followup changes, and `e` dependency edges, plus Git, lock, and filesystem costs.

The list/read operation supplies the revision, content head, and requirement fingerprint that the agent uses while verifying a change and then passes back as expected values. The tool validates evidence shape and repository state, not whether the agent's explanation proves correctness. Prompts require actually checking the code and running the stated checks before calling it. Accept already-implemented work without a new code commit when the current behavior and criteria are verified. Record only completed followups after a partial run; failed tests and interrupted tasks remain pending. Reopen preserves the reason and prior evidence in Git history and does not alter the requirement.

Any changed code content requires rechecking an old implementation record, even when its commit is an ancestor of HEAD: a later commit may have reverted the change. Do not automatically reimplement such work. The agent first verifies whether it remains satisfied, then refreshes the evidence or makes the missing change. Artifact-only commits do not trigger a recheck because they leave `workflowContentHead` unchanged. If an agent or side session changes the scope during verification, the expected revision check must reject publication so evidence is not attached to a different requirement.
