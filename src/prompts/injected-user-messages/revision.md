<!-- Usage: Sent as the initial user message after /workflow-revise switches to a revision session. -->
Revise the implementation based on this request:

{{{request}}}

{{#reviewPath}}First inspect the saved review in {{{reviewPath}}} and verify the relevant findings against the current implementation. {{/reviewPath}}Make the requested changes, run the relevant tests, commit and push the result, and leave the worktree clean.
