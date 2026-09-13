**What**

Remove `/workflow-revise` entirely: its registration, identifier completion, request editor, dedicated phase, session naming, prompt templates, and advertised actions. Do not keep an alias, manual-request shortcut, or replacement revision command. `/workflow-implement` is the only command for starting or continuing implementation.

Keep first approval behavior unchanged. Every implementation session receives the current requirements and progress for all original changes and accepted followups. Later calls use those same records to finish pending work, assess unrecorded work, check stale evidence, and leave satisfied work unchanged.

**Why**

Review discussion already establishes the work. The user should neither repeat it in a request editor nor choose between two implementation phases.

**Pseudocode**

Use `WorkflowScope` from `combine-original-and-followup-scope` and `ChangeWork` from `track-followup-implementation`.

```text
procedure StartImplementation(context, workflow):
    validate approved plan and existing worktree using current command rules
    require no unsaved differences in working-plan
    retry committing finalized workflow artifacts
    files = workflowFiles(workflow.identifier)
    scope = ReadWorkflowScope(files, workflow)
    head = workflowContentHead(exec, workflow)
    report = read latest saved review, warning explicitly if unreadable
    work = ClassifyChangeWork(scope, head, applicable part of report)

    create and switch to a fresh implementation session in workflow.worktreePath
    send kickoff through replacement-session context:
        exact approved-baseline and current-plan paths, plus clarification path
        latest report path and whether it covers the current scope and code
        all active change IDs grouped as assess, pending, recheck, or complete
        proposed items not selected and unresolved plan-wide review/testing obligations
        instruction to reread these files and preserve recorded completed work
```

Complexity: O(n × (b + n + e + a) + r) worst-case local time and O(b + n + e + a + r) space with the per-change digest procedure, for `b` source bytes, `n` changes, `e` dependency edges, `a` amendment links, and `r` report results. Existing Git, snapshot-integrity, session, and filesystem costs are additional.

Resolve draft status, the exact latest snapshot, and its artifact commit under the publication lock at handoff, then release the lock before switching sessions. Implement these command and prompt changes in `src/index.ts` and `src/prompts.ts`, removing the revision templates. Use one implementation system prompt on every turn so resume and compaction preserve followup instructions. Refresh the exact current snapshot and its scope as the existing `before_agent_start` handler refreshes approval metadata. Avoid using captured retired Pi/context objects after session replacement.

The implementer follows this policy:

- Use one work list for original changes and accepted followups, from the first implementation onward. Never infer that originals are complete from the existence of a review, branch, or earlier session.
- For AssessWork, inspect current code and relevant saved evidence, then record completion or what remains. For PendingWork and RecheckWork, verify existing behavior before editing; implement only what is missing in dependency order. This also fills missing original progress in older workflows without duplicate code changes.
- For RecordedComplete, preserve the work and its evidence rather than restarting it. Adding an unrelated followup at unchanged code does not reset it; changed code or effective requirements require a check.
- Preserve original behavior except for accepted amendments. Use prerequisite progress as a starting point and inspect affected integration rather than assuming an original dependency is already satisfied.
- Do not implement proposed suggestions or dismissed work. If only unaccepted concerns remain, report them or ask a focused question. New planned followups are recorded through normal discussion with the review assistant, not a revision editor.
- If no per-change work or plan-wide obligations remain, say so without artificial edits or commits. Starting a fresh implementation session remains allowed; all-complete records do not erase a failed plan-wide test or unresolved holistic finding.
- Before handing off, save progress for every assessed active change, including originals, and refresh completed records against the final delivered code. Use the same prepare/edit/finalize flow for progress, restricted to implementation.json under any original or accepted followup change directory. Resolve material ambiguity with the existing `workflow_questions` tool rather than rewriting requirements.

Do not restart a later implementation on the bottom branch. Preserve the current stack tip, inspect the delivery, update affected branches, and follow existing commit, restack, push, and clean-worktree requirements. Starting implementation can still preserve manual uncommitted code; the unsaved-plan check is separate from that permission.

Recognize legacy serialized `phase: revision` entries only at the session-read boundary and normalize them to implementation. Keep existing transcripts readable without exposing a current revision mode. Remove `revising` from supported model phases in `src/config.ts`; if an old `models.revising` table is present, give a specific migration error directing the user to `models.implementing`, rather than silently choosing a different model. New sessions use the Implement name and implementing configuration only.
