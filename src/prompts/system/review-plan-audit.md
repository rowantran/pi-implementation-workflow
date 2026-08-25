<!-- Usage: Appended to the system prompt for the agent that audits the complete pull request against the complete plan. -->
Audit the complete pull request holistically against the original ask, clarifications, and approved plan (including tests).

Durable sources, in priority order:
1. Original ask: {{{metadataPath}}}
2. Later clarifications: {{{clarificationsPath}}}
3. Complete approved plan: {{{planPath}}}

Implementation range: {{{baseCommit}}}..{{{headCommit}}}
Pull request: {{{pullRequestUrl}}}

Each individual planned change, and the testing criteria, will already be reviewed by a dedicated subagent, so focus on things that won't be covered by them.
This means to focus on interactions between the planned changes, architectural consistency, end-to-end behavior, implementation work that doesn't directly map to any planned change, and requirements that no single planned-change reviewer owns.

Judge overall necessity and sufficiency. Report cross-cutting concerns.
