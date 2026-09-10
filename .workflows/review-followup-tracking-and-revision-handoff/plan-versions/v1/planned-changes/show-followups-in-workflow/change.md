**What**

Update `src/dashboard.ts`, `src/dashboard.html`, and the workflow Markdown exports to show accepted followups alongside original planned changes with a visible Followup label. Show proposed and dismissed items separately so they cannot be mistaken for approved implementation scope. Include the source review, user decision, acceptance criteria, and recorded implementation evidence.

Update `/workflow-brief`, per-turn source references, review transcript cards, footer guidance, and README documentation to describe the same followup-aware flow. The next action after agreeing to followups is `/workflow-implement`; `/workflow-revise` is described only as the optional manual-request shortcut under the recommended unified-phase design.

**Why**

The user and every agent need to see the same accepted work and understand whether it is pending, implemented, or independently reviewed. The original plan version must not appear to have silently changed.

Show the approved original version explicitly in the default Plan view, followed by its accepted followups. Preserve original version selection and comparison as historical snapshots without injecting today's followups into old versions. Label this distinction in Guided view and Full document view. Use the existing outline, stable slug links, Markdown rendering, and dependency graph for the combined current scope; dependency numbers remain visual positions, not identities.

Derive progress labels from `track-followup-implementation`: Pending, Implementation recorded, or Needs recheck. A record must never appear as Review passed merely because the implementer marked it complete. Show independent review verdicts and their covered code/scope separately. Current saved reports remain visible as historical evidence when accepted scope changes; explain that a new review is required. Completion-only updates refresh the dashboard without making the report stale.

Add followups to briefing paths and explain their acceptance status and amendment rules. Keep the existing path-based context approach instead of injecting an entire history on every turn. Give implementers both the current requirements and dismissed proposals that explain a keep-as-is decision. Do not include irrelevant transcript history.

Change the review card wording from absolute read-only to code-read-only with followup recording allowed. For new and resumed implementation sessions, derive the review-ready reminder from content and source coverage rather than only checking whether HEAD differs from the base commit. Do not let completed followup bookkeeping repeatedly suggest a new review of unchanged requirements and code.

Document the repeated-implementation behavior, conversation examples, proposed versus accepted decisions, amendments, completion evidence, artifact commits, command compatibility, and legacy model-setting behavior in `README.md`. Keep historical report/version format support and the absence of automatic conversation import explicit. Update existing dashboard and test fixtures to cover one original change, one pending followup, one implemented followup, and one dismissed proposal.
