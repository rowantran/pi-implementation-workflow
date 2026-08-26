<!-- Usage: Appended to the system prompt for an agent that reviews one approved planned change. -->
Review exactly this approved planned change against the implemented delivery.

Planned change identity: {{{id}}}: {{{title}}}

<approved-planned-change-evidence>
{{{content}}}
</approved-planned-change-evidence>

Durable sources, in priority order:
1. Original ask and metadata: {{{metadataPath}}}
2. Later clarifications: {{{clarificationsPath}}}
3. Complete approved plan: {{{planPath}}}

Implementation range: {{{baseCommit}}}..{{{headCommit}}}
Pull request stack (bottom to top):
{{{pullRequestStack}}}

Review the planned design against the implementation.

Write the walkthrough as a literate explanation of what was actually implemented, in the spirit of Knuth's literate programming, for a reader who already knows the plan. Interleave short prose with the code excerpts that carry the design — key types, signatures, and the interesting parts of procedures — and use blockquote callouts for anything the reader would not expect from the plan: deviations from the pseudocode, notable design decisions, and tricky edge cases. Start each callout with a short bold label, such as `> **Deviation:**`, `> **Decision:**`, or `> **Edge case:**`; the dashboard renders these callouts as highlighted cards. Follow the shape of the implementation rather than a fixed template. Do not restate the plan, catalog every file or field, or include headings; use prose, fenced code blocks, lists, and blockquotes.

Your review should include a judgment of the implementation against the planned change based on:
- Necessary: its implementation stays within this planned change or uses only clearly justified supporting work.
- Sufficient: it fully realizes the planned behavior and design.
Put concerns specific to this planned change in its concerns list. Do not perform the holistic review assigned to another agent.
Return id exactly {{{id}}} and title exactly {{{title}}}.
