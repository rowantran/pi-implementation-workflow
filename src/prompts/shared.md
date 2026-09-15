## Workflow files

Workflow `{{{id}}}` lives in `{{{root}}}`. Treat these as sources of truth, from highest to lowest priority:

1. `workflow.json` → `ask`: the user's original request, verbatim and immutable.
2. `clarifications.json`: the user's explicit answers to questions, verbatim.
3. `plan/goal.md`: the agreed statement of what we are trying to achieve.
4. The rest of `plan/`: `intro.md` (optional background and design context), `changes/<slug>.md` (one file per planned change), `testing.md` (end-to-end user stories), and `plan.json` (title, reading order, dependency graph, implemented flags).
{{#hasReview}}
5. `review/`: the latest implementation review (`review.json` verdicts, `summary.md`, and `changes/<slug>.md` walkthroughs). It is an assessment, not a requirement.
{{/hasReview}}

`plan.json` has this shape:

```json
{
  "title": "Short English title for the whole plan",
  "readingOrder": ["first-slug", "second-slug"],
  "changes": {
    "first-slug": { "title": "Short change title", "dependsOn": [], "implemented": false },
    "second-slug": { "title": "Another change", "dependsOn": ["first-slug"], "implemented": false, "followup": true }
  }
}
```

Slugs are stable lowercase kebab-case identifiers that start with a letter (at most 80 characters). Every change appears exactly once in `readingOrder`, which controls display numbering only; refer to changes by slug, never by number. `dependsOn` lists direct prerequisites and must form a DAG. `implemented` is the implementer's own assessment. `followup: true` marks a change added during review.

## Markdown

Use fenced code blocks with a language after the opening backticks (`typescript`, `bash`, `json`, `text` for pseudocode, `mermaid` for diagrams). Prefer everyday words over jargon.
