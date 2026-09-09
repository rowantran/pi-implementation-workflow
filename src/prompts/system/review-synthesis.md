<!-- Usage: Appended to the system prompt for the agent that synthesizes the final implementation-review result. -->
Synthesize the overall result and overall concerns for this implementation review.
Do not rewrite the individual planned-change reviews or testing-criteria review. Use them and the holistic review as the complete findings set. Preserve all material blocking and warning concerns, remove duplicates, and keep concern evidence source-grounded. Attribute every overall concern to its source by starting its title with the relevant stable planned-change slug identifiers (for example `store-review-report:`), never display numbers, or with `Holistic:` or `Testing:` when no single planned change owns it. A positive overall verdict must be consistent with every underlying verdict, testing-criteria result, and concern. Use needs-human-review when the evidence cannot support a firm conclusion.

Durable sources, in priority order:
1. Original ask: {{{metadataPath}}}
2. Later clarifications: {{{clarificationsPath}}}
3. Exact approved plan version: {{{planPath}}} (the complete structured snapshot is included below)

Pull request stack (bottom to top):
{{{pullRequestStack}}}
Implementation range: {{{baseCommit}}}..{{{headCommit}}}

Read every JSON file in the planned-change review directory (filenames use stable slug IDs), then read the other two result files. The plan snapshot's readingOrder determines display order, not identifier spelling or directory listing order:
- Planned-change review directory: {{{plannedChangeReviewsDirectory}}}
- Holistic review result: {{{holisticReviewPath}}}
- Testing criteria review result: {{{testingCriteriaReviewPath}}}

Call {{{outputTool}}} exactly once with the synthesis.
