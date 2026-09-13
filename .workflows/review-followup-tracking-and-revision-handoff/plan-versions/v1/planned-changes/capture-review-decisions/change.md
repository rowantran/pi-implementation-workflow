**What**

Register a narrow `workflow_followups` tool with read/list and batched mutation operations. In the interactive review session, allow adding, editing, accepting, and dismissing followups. Keep ordinary `edit` and `write` disabled, keep finalized plans and reports protected, and continue prohibiting implementation changes through shell commands or delegated agents.

Update `src/index.ts`, `src/prompts.ts`, and `src/prompts/system/review.md` so the assistant saves actionable decisions during the conversation instead of telling the user to repeat them in `/workflow-revise`. Enable the same decision-recording capability for explicit manual requests in implementation; restrict completion updates to implementation as described in `track-followup-implementation`.

**Why**

The user must be able to ask questions, accept a change, or keep the current design without accidentally authorizing every suggestion. The agreed work should survive session switches and compaction without importing the entire review conversation.

**Pseudocode**

Use the types and persistence operation from `store-review-followups` and the shared context from `combine-original-and-followup-scope`.

```text
type FollowupEdit =
    Add { definition, sourceEntryId }
    | EditDefinition { id, definition, sourceEntryId }
    | Accept { id, userEntryId }
    | Dismiss { id, userEntryId, reason }

procedure RecordReviewDecisions(context, expectedRevision, edits):
    require context is bound to this approved workflow in review or implementation
    current = readFollowups(context.files)
    nextItems = copy current.items

    for each edit:
        resolve cited entries on context.sessionManager.getBranch()
        derive session identity and source text from actual entries
        apply edit using stable followup ID
        for Accept, Dismiss, or editing accepted work:
            require a cited user entry and record its verbatim text
        for Add:
            set origin using this conversation and its actual saved review
            start as Proposed; Accept may follow in the same batch

    save through SaveFollowups with expectedRevision
    commit workflow artifacts and refresh dashboard
    return IDs, decisions, revision, and publication/commit outcome
```

Complexity: O(b + n + e + m + k) time and space for `b` stored/source bytes, `n` changes, `e` dependency edges, `m` current-branch session entries, and `k` edits, using indexed lookups. Git and dashboard costs are additional.

The extension validates the existence, workflow, and role of cited entries; the assistant is responsible for interpreting the user's words accurately. A direct request such as “we should use separate repos” can add and accept the change in one call. A question such as “is this a raw string?” cannot. Ask a focused question when the user's intent is unclear. Batch related decisions without requiring a second approval form after clear conversational agreement.

Give each accepted followup enough detail for an independent implementer: desired behavior, why it changes, affected scope, and executable acceptance criteria. Reuse an existing ID when the discussion refines the same change. Preserve a rejected proposal with its reason when it would otherwise be easy to reintroduce; do not turn every explanatory question into a task. The FRED helper discussion should end with a dismissed rewrite proposal, not pending implementation.

Do not allow the isolated planned-change reviewers, holistic reviewer, testing reviewer, or synthesizer to mutate followups. They produce findings only. The human-facing assistant decides what to propose or record after inspecting those findings and the user's instructions. Clearly describe that session as “read-only for code; can record followups,” not unrestricted read-only.

Register tools using the existing Pi extension patterns, enforce phase permissions inside the callback as well as active-tool selection, and restore them on session resume. Direct writes to the new tool-owned artifact remain blocked by `workflowWriteBlockReason`. This is a workflow permission boundary, not a claim that the existing shell tools constitute an operating-system sandbox.
