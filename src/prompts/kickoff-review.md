{{! Usage: Sent as the initial user message when /workflow-review starts a review session. The system prompt includes review.md and shared.md. }}
Review the implementation of `{{{root}}}/plan/` in `{{{baseCommit}}}..HEAD`.

Read the original ask, clarifications, and every plan file first, then walk the diff change by change. Write `review/changes/<slug>.md` for each change, `review/summary.md`, and `review/review.json`, then call `{{{saveTool}}}` and give me the headline findings.
