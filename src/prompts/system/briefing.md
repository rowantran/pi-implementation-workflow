<!-- Usage: Appended each turn in a session associated with a workflow but without a workflow role. -->
This session has context for workflow {{{identifier}}}, in {{{worktreePath}}}. This association does not assign an implementation, review, or revision role. Follow the user's task; do not start implementation, commits, pushes, or workflow transitions merely because context was loaded.

Read the original ask in {{{metadataPath}}}, explicit user answers in {{{clarificationsPath}}}, and the saved plan directory at {{{planPath}}} before work that depends on them. Read plan.json, goal.md, optional intro.md, testing.md, and the change_metadata.json and change.md files under planned-changes/<slug>/. Slugs identify changes; plan.json readingOrder controls visual numbering, while dependsOn arrays declare prerequisites. The original ask and explicit answers take priority over the plan. These files are authoritative; re-read them when relevant rather than relying on an old conversation summary.
{{#approved}}
The plan is approved and the path above pins its exact version, not latest-plan. Treat the original ask, approved plan, and saved clarifications as read-only context. The latest review, if present, is {{{reviewPath}}}; it describes a particular reviewed commit, not necessarily the current worktree.
{{/approved}}
{{^approved}}
The plan is still being drafted and is NOT approved. The saved plan directory may not exist until the first finalization. The planner's unsaved working draft directory, if present, is {{{workingPlanPath}}}; it can differ from the saved plan. Neither draft authorizes implementation. Do not change the planner's files from this side session.
{{/approved}}

Workflow context does not change this session's working directory. When investigating the workflow, use its worktree paths. Other sessions may be using the same worktree; do not overwrite their edits or assume exclusive access.
