**What**

Make `ensureWorkflowReview` and `generateWorkflowReview` consume `WorkflowScope` from `combine-original-and-followup-scope`, not only `approvedPlan.document.changes`. Run one focused review for each original change and each accepted followup, including those already marked implemented. Give every reviewer the accepted amendments so intentional design changes are not reported as failures to follow the old plan.

Extend the report and agent-output contracts in `src/review-report.ts` and `src/review-agent-output.ts`, prompt templates, source fingerprints, and review cache manifests. Keep completed reports immutable and self-contained so later edits to followups do not relabel an older review.

**Why**

Followup implementation must receive the same independent scrutiny as the original plan. Reusing an old review after scope changed would miss those requirements, even when no code commit changed.

**Pseudocode**

Use the existing `ReviewInputsSnapshot`, `reviewIsCurrent`, `reviewCanSeedIncremental`, and `generateWorkflowReview` entry points, extended to carry the shared scope.

```text
procedure ReviewCurrentDelivery(workflow, files):
    reject unsaved draft differences with instructions to finalize or discard them
    retry pending durable artifact commits
    delivery = existing checkDelivery(workflow)
    scope = ReadWorkflowScope(files, workflow)
    fingerprint = hash canonical requirement-only scope
    inputs = current delivery + scope + fingerprint

    if latest report has current report format and exactly matches inputs:
        return latest report

    seed = newest current-format report with the same requirement fingerprint,
           same base, and an earlier content head ancestral to current content head
    if seed exists:
        use existing incremental scope agent over ALL scoped change IDs
        rerun affected focused reviews; carry forward unaffected focused reviews
    else:
        run focused reviews for ALL scoped changes

    always rerun holistic review, all testing groups, and synthesis for a new report
    require no Git content, dirty files, or requirement fingerprint changed during review
    append self-contained report and commit it with existing recovery behavior
    return report
```

Complexity: preparing inputs takes O(b + n + e) time and space for `b` source bytes, `n` scoped changes, and `e` dependency edges. A full review launches `n + 3` agents; an incremental review launches `a + 4`, where `a` changes are affected. Preserve the existing maximum concurrency of four. Git, model execution, cache reads, and report I/O are additional costs.

Any accepted-definition change forces a full review initially. This includes accepting followups at the same code HEAD. Do not expand this change into cross-scope incremental reuse: after a full review of the expanded scope, ordinary same-scope incremental reviews work again. A new snapshot that changes only implementation evidence must neither invalidate completed reviews nor change the review-run cache key. Keep the existing retry reuse of valid individual agent outputs.

Write new reports and cache manifests with bumped format versions. Reports must snapshot each change's Original or Followup identity, definition, amendment references, and the exact testing groups used. Record the baseline and current plan version numbers as provenance, but do not make a progress-only new version invalidate a report. Pass reviewers the resolved immutable current-plan path as well as the baseline path, never a changing latest-plan alias. The testing reviewer covers original criteria plus each accepted followup's criteria, identifies each result's source, and explains any explicitly amended original criterion. Validate recognized source IDs and require coverage for every testing group. The holistic reviewer and synthesizer assess the complete aggregate delivery, not just the latest patch.

Continue reading version 3 reports for history, dashboards, and resumed-session context without rewriting them. Do not use them as version 4 cache seeds; generate one full current-format report when next requested. Workflows with no followups retain their original plan behavior.

Update all `reviewSourceFingerprint` and `readReviewSourceFingerprint` callers together: review selection, post-generation checks, readiness notices, dashboard staleness, and cleanup confirmation. Proposed or dismissed suggestions are conversational context, not review requirements. Dismissing a previously accepted change does change scope. The report does not automatically accept new concerns or edit implementation files; the next implementation session compares saved evidence with review results through `track-followup-implementation`.
