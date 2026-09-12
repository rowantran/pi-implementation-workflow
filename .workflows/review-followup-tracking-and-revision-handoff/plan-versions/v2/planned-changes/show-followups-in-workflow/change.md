**What**

Show followups as planned changes within the existing versioned Plan view. Update `src/dashboard.ts`, `src/dashboard.html`, Markdown exports, and version comparisons to display a Followup label, decision, criteria, source review, and separate implementation evidence. Distinguish the latest plan version from the original approved baseline.

Update briefing, review transcript cards, footer guidance, and README documentation to describe the single plan-editing interface and the review → implement → review loop. Remove every advertised `/workflow-revise` action and manual-request editor flow.

**Why**

The user should see one evolving plan history, not a second task store. All agents need the same current accepted work without mistaking implementation evidence for a passed independent review.

Default to the latest finalized snapshot and identify its baseline approval. Historical version selection and comparison use only files from those snapshots; never inject current followups or progress into an older version. Version comparison should distinguish changes to requirements, decisions, and implementation evidence. Guided view, Full document, stable slug links, and the dependency graph all support followups through the existing structured plan model.

Show proposed and dismissed items separately from active requirements, but retain their plan identities and explanations. The active dependency graph contains originals plus accepted followups. Preserve readingOrder-based presentation and stable slug links across versions; displayed numbers are never durable IDs.

Derive progress labels from `track-followup-implementation`: Pending, Implementation recorded, or Needs recheck. Show independent review verdicts separately with the reviewed scope and code. Accepted requirement changes make a saved report stale; evidence-only snapshots update the visible plan history without falsely invalidating the report. Historical progress is shown as recorded at that version, not reassessed against today's HEAD.

Briefing and per-turn prompts reference both the baseline and exact current snapshot, explain accepted amendments, and identify the working draft when present. Continue using paths instead of injecting an entire history. Relevant dismissed proposals explain keep-as-is decisions without making the old conversation mandatory context.

Describe the review session as code-read-only with plan-draft editing allowed. Tell the user to discuss and finalize followups, then run `/workflow-implement`. Use `/workflow-review` after implementation, including in resumed legacy sessions. Derive readiness from current content and requirement coverage so evidence-only snapshots do not repeatedly suggest an unnecessary review.

Document the version 2 followup file layout, prepare/edit/finalize permissions, original-baseline protection, proposal/acceptance recommendation, evidence files, no-Git-commit finalization, existing artifact commit flow, and command/configuration removal in `README.md`. Keep legacy snapshot/report support and the absence of automatic conversation import explicit. Update local fixtures to include original, proposed, accepted pending, implemented, and dismissed changes across multiple snapshots.
