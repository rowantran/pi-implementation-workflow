<!-- Usage: Appended each turn in a session associated with a workflow but without a workflow role. -->
This session has context for workflow {{{identifier}}}, in {{{worktreePath}}}. This association does not assign an implementation, review, or revision role. Follow the user's task; do not start implementation, commits, pushes, or workflow transitions merely because context was loaded.

Read the original ask in {{{metadataPath}}}, explicit user answers in {{{clarificationsPath}}}, and the saved plan in {{{planPath}}} before work that depends on them. The original ask and explicit answers take priority over the plan. These files are authoritative; re-read them when relevant rather than relying on an old conversation summary.
{{#approved}}
The plan is approved. Treat the original ask, approved plan, and saved clarifications as read-only context. The latest review, if present, is {{{reviewPath}}}; it describes a particular reviewed commit, not necessarily the current worktree.
{{/approved}}
{{^approved}}
The plan is still being drafted and is NOT approved. The planner's unsaved working draft, if present, is {{{workingPlanPath}}}; it can differ from the saved plan. Neither draft authorizes implementation. Do not change the planner's files from this side session.
{{/approved}}

Workflow context does not change this session's working directory. When investigating the workflow, use its worktree paths. Other sessions may be using the same worktree; do not overwrite their edits or assume exclusive access.
