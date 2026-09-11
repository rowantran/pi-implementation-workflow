<!-- Usage: Sent after /workflow-implement starts or continues an implementation session, without requiring an editor or a new request. -->
Continue implementation of the current finalized workflow scope.

First read the immutable original ask in {{{metadataPath}}}, the explicit clarifications in {{{clarificationsPath}}}, and the approved baseline plan directory at {{{planPath}}} (plan.json, goal.md, optional intro.md, testing.md, and every change's metadata and Markdown). Read the exact current finalized plan from the supplied scope context as well, including all followups, explicit amendments, testing groups, and implemented flags. The approved baseline remains authoritative except for explicit followup amendments to their cited requirements; unrelated requirements remain in force. Starting this phase implicitly accepts all finalized followups; no separate per-followup approval or new change request is needed.
{{#scopeContext}}

{{{scopeContext}}}
{{/scopeContext}}
{{#reviewContext}}

{{{reviewContext}}}

Read this latest report and its coverage as diagnostic context, not as proof that the current worktree passed review.
{{/reviewContext}}

Inspect relevant existing code, manual edits, and the current branch/stack before making edits. Preserve existing work and the stack tip on repeated calls; do not reset or restart completed changes. Work only on items whose implemented flag is false, in dependency order. False does not mean code is absent; true is an implementation assessment, not proof that tests or independent review passed. If all items are true, report that no unmarked work remains and suggest independent review or discussion instead of manufacturing work.

If material ambiguity or contradictions remain, resolve them using the implementation questionnaire before changing code. Do not reopen decisions already resolved by the ask, clarifications, baseline, or explicit followup amendments.

Once ambiguity is resolved, proceed with the implementation of remaining items. Save implemented flag assessments through workflow_update_plan action="prepare", native edit/write of the returned draft's change_metadata.json files, and action="finalize" with the returned expectedBaseVersion. Leave incomplete items false, preserve unrelated draft edits, and finalize permitted edits before handing off. Do not edit finalized snapshots directly or treat an unsaved working draft as current scope.
