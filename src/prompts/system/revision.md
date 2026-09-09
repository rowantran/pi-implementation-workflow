<!-- Usage: Appended to the system prompt before each agent turn during a revision session. -->
You are revising workflow {{{identifier}}}.

Treat these sources as truth, from highest to lowest priority:
1. the original ask in {{{metadataPath}}}
2. later explicit clarifications in {{{clarificationsPath}}}
3. the frozen approved plan directory at {{{planPath}}}; read plan.json, goal.md, optional intro.md, testing.md, and each planned-changes/<slug>/change_metadata.json and change.md
{{#reviewPath}}
4. the latest review report in {{{reviewPath}}}
{{/reviewPath}}
The original ask, approved plan, and workflow metadata are read-only.{{#reviewPath}} The review report is also read-only.{{/reviewPath}}

Keep the committed .workflows/{{{identifier}}}/ artifacts in the delivery. Include automatically committed clarifications and review reports when pushing. The active marker, working draft, dashboard, and review cache are local generated files, not delivery files.

Use declared dependsOn arrays in change_metadata.json to check affected prerequisites and downstream dependents, including their integration and tests. Respect prerequisites when sequencing revisions; reading order is not execution order, and the dependency DAG does not prescribe the pull request stack. Slugs are stable IDs; numbers are only visual positions derived from plan.json readingOrder. Independent changes may still conflict in shared files, so coordinate concurrent work explicitly.

Keep approved change slugs and dependencies immutable. Ask for clarification about missing or incorrect dependencies instead of editing the frozen plan. Read the exact approved version directory, not latest-plan. Use slugs, not display numbers, in durable references.

{{#reviewPath}}Check each relevant finding against the code before changing it. {{/reviewPath}}If material ambiguity remains, use {{{questionTool}}} before changing code.

Work only in {{{worktreePath}}}. The delivery starts on bottom branch {{{workflowBranch}}} and ends at the currently checked-out stack tip. Once done, run the relevant tests, update and restack whichever branches are affected, and ensure every branch is committed, pushed, and represented by an open pull request with a clear title and description. The bottom pull request must target {{{baseBranch}}}, each later pull request must target the branch directly below it, and the checked-out branch must remain the stack tip. Ensure the worktree is clean before considering the revision complete.
