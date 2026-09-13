**What**

Remove `/workflow-revise` entirely: command registration, completion, request editor, dedicated phase, session naming, prompt templates, and advertised actions. Do not retain an alias or replacement revision command. `/workflow-implement` is the sole entry point for initial implementation and later followup work.

Keep first approval behavior unchanged. Every implementation session receives the current original changes and accepted followups, grouped by their implemented flags. The explicit task is to work on items marked false, while respecting the existing implementation and the latest review context.

**Why**

Review discussion already establishes the work. The user should not repeat it in a request editor or choose between two implementation phases.

**Pseudocode**

Use `WorkflowScope` from `combine-original-and-followup-scope` and `ImplementationWork` from `track-followup-implementation`.

```text
procedure StartImplementation(context, workflow):
    validate approved plan and existing worktree using current command rules
    require no unsaved differences in working-plan
    retry committing finalized workflow artifacts
    files = workflowFiles(workflow.identifier)
    scope = ReadWorkflowScope(files, workflow)
    work = SelectImplementationWork(scope)
    report = read latest review, warning explicitly if unreadable
    determine report coverage using existing code/scope checks, separately from flags

    create and switch to a fresh implementation session in the same worktree
    send kickoff through replacement-session context:
        exact approved-baseline and current-plan paths, plus clarification path
        remaining and reported-implemented change IDs
        latest report path and its coverage
        proposed items not selected and unresolved review/testing concerns
        instruction to implement false items and preserve existing work
```

Complexity: O(b + n + e + a + r) local time and space for `b` source bytes, `n` changes, `e` dependency edges, `a` amendment links, and `r` report data. Selecting work itself is O(n); existing Git, snapshot-integrity, session, and filesystem costs are additional.

Resolve draft status, the exact latest snapshot, and its artifact commit under the publication lock at handoff, then release the lock before switching sessions. Update `src/index.ts`, `src/prompts.ts`, and the implementation templates, removing revision templates. Refresh paths and flags on later turns and resume instead of relying only on kickoff context. Avoid captured retired Pi/context objects after session replacement.

The implementer follows this policy:

- Apply the same boolean to originals and accepted followups from the first implementation onward. Do not assume originals are done because an earlier session or pull request exists.
- For each false item, inspect what is already implemented before editing. Work on what remains in dependency order and set true when the agent believes it is done. Older workflows may need only flag updates for existing code.
- Do not restart true items merely because a new session started, code changed, or a followup was added. The flag is not proof of correctness; if the agent discovers more work, it may explicitly set false or raise the finding rather than pretending the earlier assessment was verified.
- Preserve original requirements except for accepted amendments. Inspect affected integration and use ordinary implementation judgment; no progress hash or automated recheck stage is required.
- Do not implement proposed or dismissed suggestions. Unaccepted findings can be discussed and recorded as followups with the review assistant. They do not silently become tasks or reset flags.
- Save flag updates through prepare/edit/finalize before handing off. Mark only changes the agent considers done; leave incomplete work false. Partial runs can save a partial set of true flags.
- When every active item is marked true, report that there are no unmarked items and suggest review or discussion of remaining findings. Do not claim that tests or review passed merely because the flags are true. Avoid artificial edits and commits.

Keep existing testing and delivery instructions independent of the flag. Preserve the current stack tip on later implementation calls, update affected branches, commit/restack/push the delivery, and leave a clean worktree when finishing. Starting implementation may still preserve manual uncommitted code; the unsaved-plan check is separate. Use `workflow_questions` for material ambiguity rather than changing requirements.

Read legacy serialized `phase: revision` entries as implementation without exposing a current revision mode or rewriting transcripts. Remove `revising` from supported model phases in `src/config.ts`; a legacy models.revising table should produce a migration message directing the user to models.implementing instead of silently selecting another model. New sessions use the Implement name and implementing configuration only.
