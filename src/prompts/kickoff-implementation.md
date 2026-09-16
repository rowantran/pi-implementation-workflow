{{! Usage: Sent as the initial user message when /workflow-implement starts an implementation session, including later rounds for unfinished changes or review followups. The system prompt includes implementation.md and shared.md. }}
Implement the plan in `{{{root}}}/plan/`.

Read the original ask in `workflow.json`, `clarifications.json`, every plan file{{#hasReview}}, and the latest review in `review/`{{/hasReview}}, then the relevant existing code. If any design choice is still ambiguous or contradictory after that, resolve it with `{{{questionsTool}}}` before changing code; lean towards asking rather than guessing, but do not reopen settled decisions. Then implement.
