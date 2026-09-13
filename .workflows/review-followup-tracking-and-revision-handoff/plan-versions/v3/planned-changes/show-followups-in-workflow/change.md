**What**

Show followups and shared progress for all planned changes within the existing versioned Plan view. Update `src/dashboard.ts`, `src/dashboard.html`, Markdown exports, and version comparisons to display progress and evidence on every original change and followup, with a Followup label, decision, criteria, and source review where applicable. Distinguish the latest plan version from the original approved baseline.

Update briefing, review transcript cards, footer guidance, and README documentation to describe the single plan-editing interface and the review → implement → review loop. Remove every advertised `/workflow-revise` action and manual-request editor flow.

**Why**

The user should see one evolving plan history, not a second task store. All agents need the same current accepted work without mistaking implementation evidence for a passed independent review.

Default to the latest finalized snapshot and identify its baseline approval. Historical version selection and comparison use only files from those snapshots; never inject current followups or progress into an older version. Version comparison should distinguish changes to requirements, decisions, and implementation evidence. Guided view, Full document, stable slug links, and the dependency graph all support followups through the existing structured plan model.

Show proposed and dismissed items separately from active requirements, but retain their plan identities and explanations. The active dependency graph contains originals plus accepted followups. Preserve readingOrder-based presentation and stable slug links across versions; displayed numbers are never durable IDs.

Derive progress labels for every active change from `track-followup-implementation`: Unassessed, Pending, Implementation recorded, or Needs recheck. Show total counts across original changes and accepted followups so neither group silently disappears from the remaining-work list. Proposed and dismissed followups are outside those totals. Show independent review verdicts separately with the reviewed scope and code. Accepted requirement changes make a saved report stale; evidence-only snapshots update the visible plan history without falsely invalidating the report. Historical progress is shown as recorded at that version, not reassessed against today's HEAD. A newly accepted unrelated followup does not reset unchanged original progress, even though the expanded overall scope needs a new review.

Briefing and per-turn prompts reference both the baseline and exact current snapshot, explain accepted amendments, and identify the working draft when present. Continue using paths instead of injecting an entire history. Relevant dismissed proposals explain keep-as-is decisions without making the old conversation mandatory context.

Describe the review session as code-read-only with plan-draft editing allowed. Tell the user to discuss and finalize followups, then run `/workflow-implement`. Use `/workflow-review` after implementation, including in resumed legacy sessions. Derive readiness from current content and requirement coverage so evidence-only snapshots do not repeatedly suggest an unnecessary review.

Document the version 2 change/progress file layout, prepare/edit/finalize permissions, original-requirement protection, proposal/acceptance recommendation, shared implementation.json files, filling missing progress in older workflows, no-Git-commit finalization, existing artifact commit flow, and command/configuration removal in `README.md`. Keep legacy snapshot/report support and the absence of automatic conversation import explicit. Update local fixtures to include unassessed, pending, and completed original changes alongside proposed, accepted, implemented, and dismissed followups across multiple snapshots.
