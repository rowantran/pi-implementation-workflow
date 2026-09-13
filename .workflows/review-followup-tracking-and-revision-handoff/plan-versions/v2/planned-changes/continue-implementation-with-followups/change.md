**What**

Remove `/workflow-revise` entirely: its registration, identifier completion, request editor, dedicated phase, session naming, prompt templates, and advertised actions. Do not keep an alias, manual-request shortcut, or replacement revision command. `/workflow-implement` is the only command for starting or continuing implementation.

Keep first approval behavior unchanged. Later calls open a fresh implementation session in the existing worktree, carrying the latest finalized followups and explicit instructions to implement accepted pending work, check uncertain completion evidence, and leave satisfied work unchanged.

**Why**

Review discussion already establishes the work. The user should neither repeat it in a request editor nor choose between two implementation phases.

**Pseudocode**

Use `WorkflowScope` from `combine-original-and-followup-scope` and `FollowupWork` from `track-followup-implementation`.

```text
procedure StartImplementation(context, workflow):
    validate approved plan and existing worktree using current command rules
    require no unsaved differences in working-plan
    retry committing finalized workflow artifacts
    files = workflowFiles(workflow.identifier)
    scope = ReadWorkflowScope(files, workflow)
    head = workflowContentHead(exec, workflow)
    report = read latest saved review, warning explicitly if unreadable
    work = ClassifyFollowupWork(scope, head, applicable part of report)

    create and switch to a fresh implementation session in workflow.worktreePath
    send kickoff through replacement-session context:
        exact approved-baseline and current-plan paths, plus clarification path
        latest report path and whether it covers the current scope and code
        pending/recheck IDs and proposed items that are not selected
        instruction to reread these files before acting
```

Complexity: O(b + n + e + a + r) local work and space for `b` source bytes, `n` changes, `e` dependency edges, `a` amendment links, and `r` report results. Existing Git, snapshot-integrity, session, and filesystem costs are additional.

Resolve draft status, the exact latest snapshot, and its artifact commit under the publication lock at handoff, then release the lock before switching sessions. Implement these command and prompt changes in `src/index.ts` and `src/prompts.ts`, removing the revision templates. Use one implementation system prompt on every turn so resume and compaction preserve followup instructions. Refresh the exact current snapshot and its scope as the existing `before_agent_start` handler refreshes approval metadata. Avoid using captured retired Pi/context objects after session replacement.

The implementer follows this policy:

- On an initial or interrupted original implementation, inspect the delivery and complete missing original requirements. A second invocation is not permission to rebuild satisfactory code.
- With accepted followups, implement pending work in dependency order. For RecheckWork, inspect code and relevant tests before deciding whether edits are needed. A pending task may already have been implemented manually; record verified completion without duplicating it.
- Preserve original behavior except for accepted amendments. Inspect affected prerequisites and integration; appearing in the baseline is not proof that a prerequisite was implemented.
- Do not implement proposed suggestions or dismissed work. If only unaccepted concerns remain, report them or ask a focused question. New planned followups are recorded through normal discussion with the review assistant, not a revision editor.
- If nothing remains and the current delivery satisfies the scope, say so without artificial edits or commits. Starting a fresh implementation session remains allowed.
- Use the same prepare/edit/finalize flow for completion evidence, with implementation restricted to its permitted draft files. Resolve material ambiguity with the existing `workflow_questions` tool rather than rewriting requirements.

Do not restart a later implementation on the bottom branch. Preserve the current stack tip, inspect the delivery, update affected branches, and follow existing commit, restack, push, and clean-worktree requirements. Starting implementation can still preserve manual uncommitted code; the unsaved-plan check is separate from that permission.

Recognize legacy serialized `phase: revision` entries only at the session-read boundary and normalize them to implementation. Keep existing transcripts readable without exposing a current revision mode. Remove `revising` from supported model phases in `src/config.ts`; if an old `models.revising` table is present, give a specific migration error directing the user to `models.implementing`, rather than silently choosing a different model. New sessions use the Implement name and implementing configuration only.
