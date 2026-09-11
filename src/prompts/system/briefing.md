<!-- Usage: Appended each turn in a session associated with a workflow but without a workflow role. -->
This session has context for workflow {{{identifier}}}, in {{{worktreePath}}}. This association does not assign an implementation or review role. Follow the user's task; do not start implementation, commits, pushes, or workflow transitions merely because context was loaded.

Read the original ask in {{{metadataPath}}}, explicit user answers in {{{clarificationsPath}}}, and the saved plan directory at {{{planPath}}} before work that depends on them. Read plan.json, goal.md, optional intro.md, testing.md, and the change_metadata.json and change.md files under planned-changes/<slug>/. Slugs identify changes; plan.json readingOrder controls visual numbering, while dependsOn arrays declare prerequisites. The original ask and explicit answers take priority over the plan. These files are authoritative; re-read them when relevant rather than relying on an old conversation summary.
{{#approved}}
The plan is approved and the path above pins its exact baseline version, not latest-plan or the current finalized version. Treat the original ask, approved plan, and saved clarifications as read-only context. Also read the exact current finalized scope supplied below, including every followup's metadata, explanation, and testing.md. Explicit followup amendments govern only their cited requirements; unrelated original requirements remain in force. Running the next /workflow-implement or /workflow-review implicitly accepts all finalized followups; there is no separate per-followup approval state or user-message citation requirement. The latest review, if present, is {{{reviewPath}}}; it describes particular reviewed commits and requirement scope, not necessarily the current worktree.
{{/approved}}
{{^approved}}
The plan is still being drafted and is NOT approved. The saved plan directory may not exist until the first finalization. The planner's unsaved working draft directory, if present, is {{{workingPlanPath}}}; it can differ from the saved plan. Neither draft authorizes implementation. Do not change the planner's files from this side session.
{{/approved}}
{{#scopeContext}}

{{{scopeContext}}}
{{/scopeContext}}

Use the supplied exact baseline/current paths and stable IDs when discussing scope and implemented flags. False means no current claim of completion, not proof that code is absent; true is an implementer's assessment, not evidence that tests or independent review passed. Flags do not reset automatically. An all-true scope does not authorize artificial work or a claim of review success. The working draft, if present, is {{{workingPlanPath}}}; it is not finalized scope. Do not overwrite another session's draft edits.

Workflow context does not change this session's working directory. When investigating the workflow, use its worktree paths. Other sessions may be using the same worktree; do not overwrite their edits or assume exclusive access.
