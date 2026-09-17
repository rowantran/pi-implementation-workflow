# pi-implementation-workflow

A [Pi](https://github.com/earendil-works/pi) extension that separates **planning**, **implementation**, and **review**. The three phases share one plan directory on disk — JSON and Markdown that agents edit and humans can read — plus a browser dashboard for the plan and the review.

```bash
pi install git:github.com/rowantran/pi-implementation-workflow
```

Requires Pi 0.84.2+, Node.js 22.19+, and Git. Run `/reload` in an open session after installing.

## Where to look first

**Everything the model reads lives in [`src/prompts/`](src/prompts/).** Phase prompts and kickoff messages are Markdown files; every shorter string — tool descriptions, parameter descriptions, tool results and errors, blocked-tool reasons — is in [`strings.toml`](src/prompts/strings.toml). A test ([`test/prompt-strings.test.ts`](test/prompt-strings.test.ts)) walks the TypeScript AST and fails the build if any model-facing sink is fed an inline string, following calls across files. The only exemption is named in that test: `plan.ts` and `review.ts` may build validation messages.

So when reviewing changes to this repository, concentrate on `src/prompts/`: that directory is the behaviour of the agents. The TypeScript is plumbing.

## The flow

```text
/workflow-plan       plan-only session   →  writes plan/
/workflow-implement  full tools          →  writes code, flips implemented flags
/workflow-review     code-read-only      →  writes review/, adds followups to plan/
/workflow-implement  …                   →  implements the followups, and so on
/workflow-cleanup                        →  removes the worktree; branches stay
```

Each command opens a fresh Pi session in the workflow's own worktree (`<repo>/.worktrees/<id>`, branch `workflow/<id>`), so earlier conversations never enter later contexts. Every phase gets the same description of the files below and reads them from disk.

- **Plan.** `/workflow-plan` opens an editor for your ask, names the workflow with a model-generated slug, creates the worktree, and starts planning. The planner edits `plan/` directly and calls `workflow_plan_save`, which validates the directory and refreshes the dashboard. It asks material questions with `workflow_questions`; answers are stored verbatim in `clarifications.json`. Planning sessions can only write inside `plan/`.
- **Implement.** `/workflow-implement [id]` needs a valid plan. The implementer works in dependency order, sets `implemented: true` per change, and delivers one PR or a linear stack (Graphite if available, else `gh`).
- **Review.** `/workflow-review [id]` may read code and run commands but write only under `plan/` and `review/`. The reviewer walks `baseCommit..HEAD` change by change, writes the review directory, and calls `workflow_review_save`. Agreed fixes become followup changes (`"followup": true`) for the next `/workflow-implement`.
- **Anytime.** `/workflow-dashboard` or `Ctrl+Alt+D` prints the dashboard link.

An `[id]` argument is optional: commands fall back to the session's workflow, then the single workflow in the current checkout, then a picker.

## Files on disk

```text
<worktree>/.workflows/<id>/
├── workflow.json          # id, verbatim ask, base branch/commit, workflow branch
├── clarifications.json    # [{ question, answer, custom, answeredAt }]
├── plan/
│   ├── plan.json          # title, readingOrder, changes.<slug>: { title, dependsOn, implemented, followup? }
│   ├── goal.md            # brief statement of intent
│   ├── intro.md           # optional background
│   ├── testing.md         # brief end-to-end user stories for the whole goal
│   └── changes/<slug>.md  # What / Why / optional Pseudocode / required "## Testing"
├── review/
│   ├── review.json        # overall + per-slug { necessary, sufficient, testing } verdicts
│   ├── summary.md         # cross-cutting findings
│   └── changes/<slug>.md  # literate walkthrough of what was implemented
└── dashboard.html
```

Sources of truth, highest first: the ask in `workflow.json`, `clarifications.json`, `goal.md`, the rest of the plan. Slugs are stable kebab-case ids; `readingOrder` controls numbering only; `dependsOn` must be a DAG.

`workflow_plan_save` rejects unknown fields, bad or duplicate slugs, reading-order mismatches, unknown or cyclic dependencies, empty Markdown, change files without a nonempty `## Testing` section, and orphan change files. `workflow_review_save` requires valid verdict statuses (`yes | partial | no | needs-human-review`), nonempty explanations and walkthroughs, and coverage of every change except followups still marked unimplemented; it stamps the reviewed commit range.

There is no version history, draft copy, or lock. The plan is a directory you can also edit by hand. `.workflows/` and `.worktrees/` are added to `.git/info/exclude`.

## Dashboard

Served by each Pi process at `http://127.0.0.1:43121/w/<id>`; if another Pi process already holds the port, the same URL keeps working. The **Plan** tab shows goal, intro, a clickable Mermaid dependency graph, each change with its status and requires/enables links, and the testing stories, with the ask and clarifications in a sidebar. Select **Fullscreen** above the dependency graph to fill the viewport; **Exit fullscreen** or `Esc` returns to the plan, and selecting a node opens its change. The **Review** tab shows overall verdicts and summary, then each change's verdicts, planned text, and walkthrough. Markdown supports tables, highlighted code, and `mermaid` blocks; `[`/`]` step between sections; the page reloads itself when the file changes. The only global state is `~/.pi/agent/workflows/index.json`, mapping ids to directories.

## Configuration

Optional `~/.pi/agent/implementation-workflow/config.toml`:

```toml
[models.planning]          # also [models.implementing], [models.reviewing]
provider = "anthropic"
model = "claude-opus-4"
thinking_level = "high"    # off | minimal | low | medium | high | xhigh | max

[dashboard]
listen_host = "0.0.0.0"    # default 127.0.0.1; 0.0.0.0 exposes the dashboard to your network
listen_port = 43121
public_base_url = "http://my-devbox:43121"
```

Overrides apply when a phase session starts and can be changed afterwards.

## Development

```bash
npm install
npm test      # typecheck + node --test (includes the prompt-string lint)
```

Pi loads `src/index.ts` directly; there is no build step. Module map: `index.ts` commands, session binding, tool gating · `plan.ts` / `review.ts` directory validation · `workflow.ts` worktrees and files · `dashboard*.ts` + `dashboard.html` · `questions.ts` · `config.ts` · `prompts.ts` template loading.

## License

MIT
