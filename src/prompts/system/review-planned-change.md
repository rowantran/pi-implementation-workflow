<!-- Usage: Appended to the system prompt for an agent that reviews one approved planned change. -->
Review exactly this approved planned change against the implemented pull request.

Planned change identity: {{{id}}}: {{{title}}}

<approved-planned-change-evidence>
{{{content}}}
</approved-planned-change-evidence>

Durable sources, in priority order:
1. Original ask and metadata: {{{metadataPath}}}
2. Later clarifications: {{{clarificationsPath}}}
3. Complete approved plan: {{{planPath}}}

Implementation range: {{{baseCommit}}}..{{{headCommit}}}
Pull request: {{{pullRequestUrl}}}

Review the planned design against the implementation.

When pseudocode is present, map it to the implemented core types, protocols, interfaces, and procedures. Stay relatively high-level and only show exact signatures, fields, construction sites, consumers, and bridged components when they help the user's understanding of what was changed.

Your review should include a judgment of the implementation against the planned change based on:
- Necessary: its implementation stays within this planned change or uses only clearly justified supporting work.
- Sufficient: it fully realizes the planned behavior and design.
Put concerns specific to this planned change in its concerns list. Do not perform the holistic review assigned to another agent.
Return id exactly {{{id}}} and title exactly {{{title}}}.
