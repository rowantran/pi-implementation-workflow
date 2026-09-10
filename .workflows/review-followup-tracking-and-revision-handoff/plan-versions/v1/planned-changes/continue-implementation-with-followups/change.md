**What**

Make `/workflow-implement` the normal entry point for both initial implementation and followup work. Keep its first approval behavior unchanged. Later calls open a fresh implementation session in the existing worktree with explicit instructions to implement accepted pending followups, check uncertain completion evidence, and leave satisfied work unchanged.

Under this draft's recommended command design, retain `/workflow-revise` only as a manual-request shortcut. It keeps the required request editor and cancellation behavior, then starts the same implementation phase rather than a separate revision phase. The ordinary followup path uses `/workflow-implement` and never opens that editor.

**Why**

The user should not need to summarize a review discussion again. One implementation phase also avoids maintaining two divergent system prompts, tool sets, and delivery rules for effectively the same work.

**Pseudocode**

Use `WorkflowScope` from `combine-original-and-followup-scope`, `FollowupWork` from `track-followup-implementation`, and the existing session replacement API.

```text
type ImplementationRequest = ContinueSavedWork | ManualChanges { verbatimText }

procedure StartImplementation(context, workflow, request):
    validate approved plan and existing worktree with current command rules
    retry committing durable workflow artifacts
    files = workflowFiles(workflow.identifier)
    scope = ReadWorkflowScope(files, workflow)
    store = readFollowups(files)
    head = workflowContentHead(exec, workflow)
    report = read latest saved review, with explicit warning if unreadable
    work = ClassifyFollowupWork(scope, store, head, applicable part of report)

    create and switch to a fresh implementation session in workflow.worktreePath
    send kickoff through the replacement-session context:
        exact original/approved plan paths, followup path, clarification path
        latest report path and whether it covers the current scope and code
        pending/recheck IDs and count of proposed items not selected
        request, if ManualChanges
        instructions to reread authoritative files before acting
```

Complexity: O(b + n + e + r) local time and space for `b` source bytes, `n` changes, `e` dependency edges, and `r` report results, plus existing Git, session, and filesystem costs.

Implement these entry and prompt changes in `src/index.ts`, `src/prompts.ts`, and the implementation/revision templates. Use one shared implementation system prompt on every turn, not just the kickoff, so resume and compaction preserve followup instructions. Refresh source paths and current records as the existing `before_agent_start` handler does for approval metadata. Avoid stale captured Pi/context objects after session replacement.

The implementer follows this task policy:

- On an initial or interrupted original implementation, inspect the current delivery and complete the remaining original requirements. A second invocation is not permission to rebuild an already satisfactory implementation.
- When accepted followups exist, implement pending work in dependency order. For RecheckWork, inspect the current code and relevant tests before deciding whether code changes are needed. A pending task may already have been implemented manually; record verified completion without duplicating it.
- Preserve original behavior except for explicit accepted amendments. Inspect affected prerequisites and integration points; do not assume that an original dependency was implemented merely because it appears in the approved plan.
- Treat proposed followups as unapproved and dismissed ones as decisions to preserve. If only proposals or unaccepted review concerns remain, report them or ask a focused question rather than silently implementing them.
- When no accepted work remains and the current delivery satisfies the approved scope, say so without manufacturing edits or commits. A fresh session is still allowed.
- For ManualChanges, record the explicit request as one or more accepted followups before changing code, using the tool from `capture-review-decisions`. Resolve ambiguity with `workflow_questions`; do not force the user to retype the request. Then use the same work policy as `/workflow-implement`.

Do not restart a later implementation on the bottom branch. Preserve the current stack tip, inspect the existing delivery, update affected branches, and apply the existing commit, restack, push, and clean-worktree requirements. Starting implementation may still preserve manual uncommitted changes; completion evidence and review retain their stricter clean-state checks.

For compatibility, recognize saved `phase: revision` session entries on resume and give them the unified implementation behavior. New sessions use `implementation` and the Implement session-name prefix. Update `src/config.ts` so a legacy `models.revising` setting is accepted as a deprecated fallback for `models.implementing` when that setting is absent, with a clear warning; an explicit implementing override wins. Document that the unified phase no longer has independent revision model selection. Preserve existing session transcripts and do not rewrite them.
