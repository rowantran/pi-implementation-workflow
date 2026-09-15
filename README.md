# pi-implementation-workflow

A [Pi](https://github.com/earendil-works/pi) extension that separates planning, implementation, and review. All three phases share one plan directory on disk, written in JSON and Markdown that both agents and humans can read and edit, plus a browser dashboard that shows the plan and the review.

## Install

```bash
pi install git:github.com/rowantran/pi-implementation-workflow
```

Run `/reload` in an existing Pi session after installation. Requires Node.js 22.19+, Git, and Pi 0.84.2 or a compatible release.

## The flow

```text
/workflow-plan       plan only        →  plan/ is written and saved
/workflow-implement  full tools       →  code is written; implemented flags flipped
/workflow-review     code read-only   →  review/ is written; followups added to plan/
/workflow-implement  full tools       →  followups are implemented
/workflow-review     …                →  and so on, until you /workflow-cleanup
```

Each command starts a fresh Pi session in the workflow's worktree, so earlier conversations never enter later contexts. Every phase gets the same system-prompt description of the files below and reads them from disk.

### 1. Plan

```text
/workflow-plan
```

An editor opens for your ask. The extension names the workflow with a short model-generated slug, creates branch `workflow/<id>` and worktree `<repo>/.worktrees/<id>` from the current HEAD, writes an empty plan skeleton, and starts a planning session there with the ask as the first message.

The planner edits the plan files directly with `edit`/`write` and calls `workflow_plan_save`, which validates the directory and refreshes the dashboard. Planning sessions can only write inside `plan/`. When a decision materially changes the plan, the planner asks with `workflow_questions`, a multiple-choice prompt whose answers are recorded verbatim in `clarifications.json`.

### 2. Implement

```text
/workflow-implement [id]
```

Requires a valid plan. Starts an implementation session with your normal tools. The implementer works through changes in dependency order, sets `implemented: true` in `plan.json` as it completes them, and delivers a single pull request or a linear stack (Graphite when available, otherwise `gh`). If a review exists, the kickoff points at it, and unimplemented followups are the work to do.

### 3. Review

```text
/workflow-review [id]
```

Starts a session that may read code and run commands but may only write inside `plan/` and `review/`. The reviewer walks `baseCommit..HEAD` change by change and writes a review directory that mirrors the plan (see below), then calls `workflow_review_save`. Discuss the findings; agreed fixes become followup changes in `plan/` (`"followup": true`, `implemented: false`). Run `/workflow-implement` again to act on them.

### Anytime

- `/workflow-dashboard` or `Ctrl+Alt+D` — refresh the dashboard and print its link.
- `/workflow-cleanup [id]` — after confirmation, delete the worktree and the workflow files in it. Branches and pull requests are kept.

Commands that take an `[id]` resolve it in this order: the argument, the workflow bound to the current session, the single workflow in the current checkout, otherwise a picker over every workflow in the repository.

## Files on disk

```text
<worktree>/.workflows/<id>/
├── workflow.json          # id, verbatim ask, base branch/commit, workflow branch, createdAt
├── clarifications.json    # [{ question, answer, custom, answeredAt }], written by workflow_questions
├── plan/
│   ├── plan.json          # title, readingOrder, changes.<slug>: { title, dependsOn, implemented, followup? }
│   ├── goal.md            # brief affirmative statement of intent
│   ├── intro.md           # optional background and design context
│   ├── testing.md         # brief end-to-end user stories for the whole goal
│   └── changes/<slug>.md  # What / Why / optional Pseudocode / required "## Testing"
├── review/
│   ├── review.json        # overall + per-slug { necessary, sufficient, testing } verdicts; commit range stamped on save
│   ├── summary.md         # cross-cutting findings and verification of testing.md
│   └── changes/<slug>.md  # literate walkthrough of what was implemented for that change
└── dashboard.html         # generated
```

`plan.json`:

```json
{
  "title": "Queue redrive with retry policy",
  "readingOrder": ["define-redrive-policy", "implement-redrive"],
  "changes": {
    "define-redrive-policy": { "title": "Define the redrive policy", "dependsOn": [], "implemented": false },
    "implement-redrive": { "title": "Implement queue redrive", "dependsOn": ["define-redrive-policy"], "implemented": false, "followup": true }
  }
}
```

Slugs are stable lowercase kebab-case identifiers. `readingOrder` controls display numbering only; `dependsOn` must form a DAG. Sources of truth, from highest to lowest: the ask in `workflow.json`, `clarifications.json`, `goal.md`, then the rest of the plan.

`workflow_plan_save` rejects: unknown JSON fields, invalid or duplicate slugs, reading-order mismatches, unknown or cyclic dependencies, empty Markdown, a change file without a nonempty `## Testing` section, and change files with no `plan.json` entry. `workflow_review_save` rejects unknown slugs, bad verdict statuses, empty explanations or walkthroughs, and missing coverage; every change must be reviewed except followups still marked unimplemented.

There is no version history, draft copy, or lock: the plan is a directory you can also edit by hand, and the extension re-reads it whenever it needs it. `.workflows/` and `.worktrees/` are added to the repository's `.git/info/exclude` so they never show up in `git status`.

## Dashboard

Each pi process serves dashboards on `http://127.0.0.1:43121/w/<id>` (configurable below). If the port is already taken by another pi process, the same URL keeps working because both serve the same file from disk. The page reloads itself when it regains focus and the file has changed.

- **Plan**: goal, introduction, a Mermaid dependency graph (click a node to open the change), each change with its implemented/followup status and requires/enables links, and the end-to-end testing stories. The sidebar shows the verbatim ask and clarifications.
- **Review**: overall verdicts and summary, then each change with its verdict pills, the planned text in a collapsible block, and the implementation walkthrough.

Markdown supports tables, syntax-highlighted code blocks, and `mermaid` diagrams. Use `[`/`]` to move between sections. The only global state is `~/.pi/agent/workflows/index.json`, which maps ids to their directories so any process can serve any dashboard.

## Configuration

Optional TOML at `~/.pi/agent/implementation-workflow/config.toml` (under `PI_CODING_AGENT_DIR` if set):

```toml
[models.planning]          # also [models.implementing] and [models.reviewing]
provider = "anthropic"
model = "claude-opus-4"
thinking_level = "high"    # off | minimal | low | medium | high | xhigh | max

[dashboard]
listen_host = "0.0.0.0"    # default 127.0.0.1; 0.0.0.0 exposes the dashboard to your network
listen_port = 43121
public_base_url = "http://my-devbox:43121"   # what to print; defaults to the listen address
```

A phase override is applied when its session starts; you can still change model or thinking level afterwards. Each `[models.*]` table needs a model (provider and model together), a thinking level, or both.

## Development

```bash
npm install
npm test      # typecheck + node --test
```

Pi loads `src/index.ts` directly; there is no build step.

Everything the model reads is defined under `src/prompts/`: phase prompts and kickoff messages as Markdown, and shorter strings (tool metadata, tool results and errors, blocked-tool reasons) in `strings.toml`, accessed through `text()`. `test/prompt-strings.test.ts` walks the TypeScript AST and fails when a model-facing sink (tool metadata, text content parts, block reasons, `systemPrompt`, `sendUserMessage`, or a `throw` reachable from a tool's `execute`) is fed an inline string. Validation messages built by `plan.ts`/`review.ts` are the deliberate exception; they reach the model only inside `workflow_*_save` errors.

## License

MIT
