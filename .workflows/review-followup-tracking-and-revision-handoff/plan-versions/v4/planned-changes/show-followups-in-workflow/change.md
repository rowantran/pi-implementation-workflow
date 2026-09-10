**What**

Show the same implemented flag for every original change and accepted followup in the existing Plan view. Update `src/dashboard.ts`, `src/dashboard.html`, Markdown exports, and version comparisons, retaining Followup labels, decisions, criteria, and source review where applicable.

Update briefing, review transcript cards, footer guidance, and README documentation for the shared file-editing interface and review → implement → review loop. Remove every advertised `/workflow-revise` action and request-editor flow.

**Why**

The user should see one plan history and a simple implementation checklist. That checklist must not look like independent verification of the code.

Use labels such as **Marked implemented** and **Not marked implemented**, with a brief explanation that true is the implementer's assessment. Show marked/unmarked counts across originals and accepted followups. Proposed and dismissed items remain outside the active counts. Do not add Unassessed, Needs recheck, evidence panels, commit-qualified completion, or extra progress states.

Display independent review verdicts separately. It must be valid to show a change as marked implemented while its review says it is incomplete or incorrect. Never turn the flag into a Review passed badge or hide marked changes from review. Code and requirement changes affect review staleness through the existing checks; toggling implemented alone does not.

Default to the latest finalized snapshot and identify the original approved baseline. Historical selection and comparison use only those snapshots' definitions, decisions, and flag values. Distinguish requirement edits from flag-only edits. Keep Guided view, Full document, stable slug links, and dependency graphs working across original and followup changes; numbers are presentation positions, not identities.

Briefing and per-turn prompts reference both exact snapshot paths, accepted amendments, the working draft when present, and the same implemented values. Keep path-based context rather than injecting an entire history. Describe the review session as code-read-only with followup draft editing allowed, and suggest `/workflow-implement` after followups are finalized. Status reminders continue to use delivery/review coverage, not the assumption that all-true flags mean delivery is verified.

Document the version 2 change_metadata.json layout, default false value, implementer-assessment semantics, field-level edit permissions, original-requirement protection, proposal/acceptance recommendation, legacy false defaults, no-Git-commit finalization, artifact commits, and command/configuration removal in `README.md`. Add fixtures with true and false originals/followups and a true item whose independent review fails.
