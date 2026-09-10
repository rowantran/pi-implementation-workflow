**What**

Enable `workflow_update_plan` and native `edit`/`write` for the human-facing review assistant, with writes restricted to the prepared plan draft. The assistant adds or revises followup files, updates readingOrder, and finalizes with the same interface used in original planning. Do not register `workflow_followups` or another authoring tool.

Update `src/index.ts`, `src/plan-tool.ts`, `src/prompts.ts`, and the review/update-plan prompt templates. Replace the blanket post-approval finalization refusal with phase-specific validation; adjust prepare results and tool guidance to explain the permitted files for the current phase. Refactor the existing lock-owning publication function to accept that validation policy, rather than nesting calls to the non-reentrant plan lock. Keep code, finalized snapshots, reports, metadata, and the original portion of the draft read-only in review.

**Why**

A separate tool was only one way to limit writes; it was not necessary. Existing draft isolation, path guards, snapshot validation, and optimistic concurrency can provide that protection while keeping a familiar editing flow.

**Pseudocode**

`ValidateSnapshotEvolution` and the version 2 file layout are defined in `store-review-followups`.

```text
procedure PrepareReviewDraft(context):
    require bound review session and approved workflow
    draft = existing preparePlanDraft, preserving unsaved edits
    if draft is an unchanged version 1 copy:
        upgrade its editable manifest to version 2
    return draft.path, draft.baseVersion, baseline path,
           current review reference, and allowed editable paths
```

Complexity: O(b + f log f) local time and O(b + f) space for `b` copied bytes and `f` files, including existing capture/digest work and excluding filesystem latency.

```text
procedure FinalizeReviewDraft(context, expectedBaseVersion, description):
    require bound review session and approved workflow
    inside existing publication lock:
        load approved baseline, previous snapshot, and isolated draft snapshot
        apply existing draft-base and concurrent-edit checks
        ValidateSnapshotEvolution(approved, previous, draft)
        require review changes touch only the allowed followup definition files
                and the followup portion of readingOrder
        require existing implementation records are unchanged
        validate new/changed decision citations against this session's user entries
        publish through the existing immutable snapshot and atomic-pointer procedure
    refresh dashboard and return new version
```

Complexity: O(b + f log f + n + e + a + m) local time and O(b + f + n + e + a + m) space for `b` bytes, `f` files, `n` changes, `e` dependencies, `a` amendment links, and `m` indexed session entries. Storage, lock contention, and dashboard rendering add their own costs.

In review, permit `plan.json` edits only for schema conversion and followup reading order. Permit `change_metadata.json`, `change.md`, and `testing.md` only under new or existing followup directories. The write guard rejects original-file edits, including paths that traverse symbolic/hard links. Because a text edit cannot enforce field-level permissions, finalization also compares the isolated candidate against the original and previous snapshots. Do not trust a model-written origin marker to grant write access to an original change.

Followup origins reference the actual saved review and conversation. For newly accepted/dismissed work, validate the cited user entry and verbatim text; for unchanged saved decisions, trust the already validated immutable snapshot rather than requiring access to an old machine's session files. The assistant interprets whether the user's words express agreement. A direct request can create accepted work immediately; a question cannot. Editing an accepted requirement needs an explicit new decision. Keep the proposed-versus-accepted policy identified as the remaining recommendation in intro.md.

Give each followup an independent explanation and executable acceptance criteria. Preserve a rejected proposal with its reason when it explains a keep-as-is decision, such as the FRED helper discussion. Do not create tasks from every explanatory question or raw report concern. Ordinary conversation is enough; there is no second questionnaire or mutation-specific form after clear agreement.

Only the human-facing review assistant gets these authoring permissions. Isolated reviewers and the synthesizer remain read-only and do not publish followups. Restore permissions on resume and validate phase authorization inside the tool callback, not only through tool visibility. Describe the review session as code-read-only with plan-draft editing allowed, and prohibit shell/delegation paths from bypassing that boundary. This is a workflow restriction, not an operating-system sandbox.

Finalization still publishes a plan version without committing Git. `/workflow-implement`, `/workflow-review`, and cleanup commit saved versions through the existing artifact flow. Preserve failed/unfinished drafts, and block implementation/review handoff while a draft differs from the latest snapshot so a half-written followup is not silently dropped. A stale draft requires reconciliation with the latest version, not overwriting it.
