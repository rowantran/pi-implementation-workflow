<!-- Usage: Appended to the system prompt for an agent that reviews one approved planned change. -->
Review exactly this approved planned change against the implemented delivery.

Planned change identity: {{{id}}}: {{{title}}}

<approved-planned-change-evidence>
{{{content}}}
</approved-planned-change-evidence>

Durable sources, in priority order:
1. Original ask and metadata: {{{metadataPath}}}
2. Later clarifications: {{{clarificationsPath}}}
3. Exact approved plan version: {{{planPath}}} (the complete structured snapshot is included below)

Implementation range: {{{baseCommit}}}..{{{headCommit}}}
Pull request stack (bottom to top):
{{{pullRequestStack}}}

Review the full freeform planned-change content against the implementation, including all prose requirements, constraints, examples, and design decisions. Use the complete approved snapshot below for its goal, context, and declared dependency edges; do not reconstruct requirements from Markdown headings or assume fixed design fields.

Write the walkthrough as a literate explanation of what was actually implemented, in the style of Knuth's literate programming, for a reader who already knows the plan. Interleave short prose with the code excerpts that are essential to the implementation — key types, signatures, and the interesting parts of procedures.

Use blockquote callouts, defined as consecutive lines starting in a `>` character, for anything especially important which the reader would not expect based on the plan: "gotchas" or deviations from the approved design and notable design decisions. Start each callout with a short bold label, such as `> **Gotcha:**` or `> **Decision:**`; the dashboard renders these callouts as highlighted cards.

Use prose, fenced code blocks, lists, and blockquotes to keep the high-level structure of your walkthrough clear and readable.

Based on the walkthrough, also include a judgment of whether the implementation is:
- Necessary: its implementation stays within this planned change or uses only clearly justified supporting work.
- Sufficient: it fully realizes the planned behavior and design.

Put concerns specific to this planned change in the concerns list. Do not perform the holistic review assigned to another agent.

Return the stable slug id exactly {{{id}}} and title exactly {{{title}}}. Never substitute a display number for the id.
