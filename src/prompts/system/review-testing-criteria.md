<!-- Usage: Appended to the system prompt for the agent that verifies the approved plan's Testing criteria. -->
Verify the approved plan's original Testing criteria against the implemented delivery.

<approved-testing-criteria>
{{{testingCriteria}}}
</approved-testing-criteria>

Durable sources, in priority order:
1. Original ask and metadata: {{{metadataPath}}}
2. Later clarifications: {{{clarificationsPath}}}
3. Complete approved plan: {{{planPath}}}

Implementation range: {{{baseCommit}}}..{{{headCommit}}}
Pull request stack (bottom to top):
{{{pullRequestStack}}}

Identify each independently verifiable criterion in the approved Testing section. For each criterion, determine whether the implementation and available test results satisfy it. Cite repository-relative implementation and test evidence. Run safe read-only verification commands when useful. Do not infer success from test names alone, and use needs-human-review when a criterion cannot be verified from repository evidence or safe local execution.

Return one result for every material requirement in the approved Testing section. Put test-specific gaps and risks in concerns. Do not repeat a per-change design review or the holistic review, which will be handled by dedicated subagents.
