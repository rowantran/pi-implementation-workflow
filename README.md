# pi-implementation-workflow

A [Pi](https://github.com/earendil-works/pi) extension that separates implementation planning, implementation, and pull request review while keeping plans outside model context.

## Install

Install the latest revision globally:

```bash
pi install git:github.com/rowantran/pi-implementation-workflow
```

For a reproducible install, pin a commit:

```bash
pi install git:github.com/rowantran/pi-implementation-workflow@<commit>
```

Run `/reload` in an existing Pi session after installation.

## Requirements

- Pi 0.84.2 or a compatible later release
- Node.js 22.19 or later
- Git
- GitHub CLI (`gh`) authenticated for pull request detection
- Isara for the sandbox-aware session workflow described below

Each completed plan has a unique identifier, a complete numbered version history, an HTTP dashboard, and structured implementation clarifications.

The workflow is built around two durable objects: the **plan bundle** (the immutable original ask, the frozen plan and its version history, and explicit clarifications) and the **workspace** (a dedicated Git worktree and branch). Everything else — pull requests, reviews, session phases — is discovered live from Git, GitHub, and the saved artifacts, so any command can run from any session at any time.

## The main flow

Start planning inside the repository:

```text
/workflow-plan
```

The command opens a required multiline editor. Submit a non-empty ask to start planning. Press Escape to cancel without changing the session or workflow storage. You can provide optional inline text as an editor prefill, but you must still review and submit it:

```text
/workflow-plan describe the issue
```

If planning is already active, continue through normal conversation instead of running `/workflow-plan` again. A session that already belongs to a frozen workflow refuses `/workflow-plan`; start a fresh session instead.

The extension saves the submitted ask verbatim as immutable workflow metadata, starts `plan.md` and `working-plan.md` with only the implementation-plan title, sends the ask as the planning kickoff message, and announces an HTTP dashboard link in the notification panel. It never opens the browser automatically. The extension serves a single-page dashboard styled with the Isara design system. It has:

- a concise plain-English plan description as the main document title, beside its prominent current version number;
- a **Plan** view with a guided, change-by-change reader, a full-document fallback, the immutable original ask, and structured user clarifications;
- GitHub-style Markdown rendering, including tables and Mermaid diagrams in `mermaid` fenced code blocks;
- an automatically generated plan outline, top-anchored previous/next navigation, `[`/`]` section shortcuts, `S`/`C` controls for the navigation and workflow-context sidebars, and direct links to individual planned changes;
- a **Compare versions** view with two version selectors, `[`/`]` diff-block navigation, and a rich, formatted plan diff with green additions and red deletions; nearby changes use Git's default three-line context rule, so changes separated by up to six unchanged lines form one block;
- light and dark themes;
- automatic change detection when the browser regains focus, with a reload only when dashboard content changed.

Press `Ctrl+Alt+D` or run `/workflow-dashboard` to regenerate the dashboard and show its link again.

The plan has **Goal**, **Planned Changes**, and **Testing** sections. Every planned change uses a stable consecutive identifier (`PC-01`, `PC-02`, and so on) with explicit **What** and **Why** fields. A change includes **Pseudocode** only when it clarifies meaningful behavior, state, interfaces, or data flow; mechanical documentation, testing, configuration, data, migration, and wiring changes can omit it. The Testing section contains explicit verification criteria. Planned changes and testing criteria become separate units of the implementation review. Planning cannot advance if the required structure is missing, empty, or ambiguous.

During planning, the agent uses native `edit` or `write` calls only on `working-plan.md`. It then calls `workflow_update_plan` with a one-sentence-or-less English description. The tool is the only way to commit a plan change: it stores the complete working plan as the next numbered Markdown file under `versions/`, copies the same content to `plan.md`, and updates the description. Calls whose working-plan content matches the prior version still create a new version. `/workflow-implement` refuses to advance while `working-plan.md` differs from the committed `plan.md`.

### Implement

When the plan is ready, run the suggested next command in the planning session:

```text
/workflow-implement
```

From the planning session, this freezes the plan and creates the workspace:

1. requires the plan's separate English description to have been saved;
2. warns before excluding uncommitted files from the original checkout;
3. shows a live progress checklist while it generates the final plan slug and creates the worktree;
4. freezes the plan and its version history under `~/.pi/agent/workflows/<identifier>/`;
5. preserves the planning dashboard URL as a redirect to the completed workflow dashboard;
6. creates branch `workflow/<identifier>`;
7. creates `<repository>/.worktrees/<identifier>`;
8. creates and switches to a separate worktree-bound implementation session.

The planning conversation remains saved and does not enter implementation context. Running `/workflow-implement` again later — from any session — starts a fresh implementation session in the existing worktree.

Implementation inspects three durable sources before it acts: the immutable original ask in `metadata.json`, the frozen approved scope in `plan.md`, and later explicit answers in `clarifications.json`. If the approved plan has material ambiguity, the agent asks through `workflow_questions`. Submitted answers are appended verbatim to `clarifications.json` and shown in the dashboard. Selected answers retain the exact option label; custom answers retain the exact submitted text. Cancelled questionnaires are not stored.

The implementer chooses the lightest reviewable delivery. A small cohesive plan uses one pull request. A larger plan can use a linear stack through Graphite, GitHub's native stack tooling, or ordinary Git branches. The initial `workflow/<identifier>` branch is always the bottom branch. Its pull request targets the recorded base branch; every later pull request targets the branch directly below it; and the checked-out branch remains the stack tip. Planning does not add subplans or pull request boundaries.

After a settled implementation or revision turn leaves the worktree clean with new commits, a persistent reminder below the editor suggests `/workflow-review`. The reminder is a suggestion, not a gate: full delivery validation happens when you run the review.

### Review

```text
/workflow-review
```

The command checks the live delivery — the worktree must be clean, and walking open pull requests backward from the checked-out branch must form a complete linear chain to the recorded base branch, with the bottom pull request on the initial workflow branch, each pull request containing the branch below it, and the stack tip containing the local `HEAD` commit. A normal pull request is a stack with one item. The discovered pull requests are recorded bottom to top as display metadata.

The workflow then deterministically generates the review before entering a separate read-only review session:

1. one isolated, read-only agent reviews each `PC-*` planned change against its What, Why, and optional Pseudocode, producing a literate Markdown walkthrough of what was actually implemented — prose interleaved with key code excerpts and callouts for deviations from the plan;
2. one read-only holistic reviewer checks cross-cutting architecture, missing behavior, and implementation outside the plan;
3. one read-only testing-criteria reviewer verifies every material requirement in the approved Testing section with repository and execution evidence;
4. one synthesizer receives paths to all three forms of analysis and produces only the overall result and deduplicated overall concerns.

The review progress display nests a live status row under the active stage for every individual agent. Queued and running reviewers, completed or failed reviewers, and reused cached results remain visible while the workflow advances through analysis and synthesis.

Reviews are derived artifacts with two storage layers:

- `review-runs/` is the work-in-progress cache of raw per-agent outputs, keyed by commit range and a fingerprint of the original ask, approved plan, and clarifications. A retry reuses every valid completed result, so a synthesis failure does not repeat the earlier reviews. It is safe to delete; deleting it only costs recomputation.
- `reviews/` is the append-only history of finished reports. Each saved report is the synthesized review of one commit range. `review.json` and `review.md` always mirror the newest report and feed the default **Review** tab in the browser dashboard.

Running `/workflow-review` again selects the cheapest correct behavior from the saved artifacts and Git history — never an error:

- if the newest report already covers the current commits, plan, and pull requests, it is reused as-is;
- if a saved report reviewed an earlier state of the same plan and its head commit is a Git ancestor of the current head, the re-review is incremental: a read-only scope agent identifies the `PC-*` planned changes whose prior reviews could be affected, only those are rerun, and unaffected planned-change results carry forward, while the holistic reviewer, testing-criteria reviewer, and synthesizer always rerun against the complete aggregate delivery;
- otherwise — after a rebase, history rewrite, or any other mismatch — the workflow says so and generates a full review.

The report and dashboard list every pull request from bottom to top. Review uses the same Guided view and Full document modes as Plan. Guided view shares the one-section-at-a-time outline, previous/next controls, and `[`/`]` shortcuts. Each planned-change section has its literate implementation walkthrough, separate necessary and sufficient verdicts, and its own concerns. A dedicated Testing criteria section shows the original criteria, the testing review's verdict, and source evidence for each criterion.

The review session keeps the implementation conversation out of review context, disables `edit` and `write`, and announces the completed report through the dashboard link. A durable transcript card explains how to ask about findings, request changes with `/workflow-revise`, or clean up with `/workflow-cleanup`.

## Side flows

### Revise

```text
/workflow-revise
```

Revision requires only the plan and the worktree — it works straight after implementation, after a review, or after manual commits. The command opens a required multiline editor for the change request and creates a separate revision session in the same worktree. The worktree can already contain manual, uncommitted changes. The revision agent receives the original ask, frozen plan, clarifications, the submitted change request, and — when one exists — the latest review. After the agent commits and pushes its changes, run `/workflow-review` for the next (usually incremental) review.

### Clean up

```text
/workflow-cleanup
```

Cleanup removes the worktree directory and its Git worktree registration, keeping the local branches, remote branches, pull requests, and saved workflow state. It asks for confirmation when the worktree has uncommitted changes (they would be discarded) or when no saved review covers the current head commit. When the current session lives inside the worktree, the command switches Pi back to the original repository first and removes the worktree from there; otherwise it removes the worktree in place. A high-contrast completion card confirms the result.

## Targeting a workflow

Every worktree verb — `/workflow-implement`, `/workflow-review`, `/workflow-revise`, and `/workflow-cleanup` — resolves its target workflow in this order:

1. an explicit identifier argument, with autocomplete over known workflows (for example `/workflow-review my-plan-slug`);
2. the workflow already bound to the current session;
3. the workflow whose worktree contains the current directory;
4. otherwise, the workflows recorded for the current repository: a single match is used directly, and multiple matches open an interactive picker sorted by recency.

Because the argument position is reserved for identifiers, only `/workflow-plan` accepts inline prefill text.

## Dashboard delivery

The extension serves dashboards over HTTP in local and remote environments. Dashboard addresses are deterministic:

```text
/implementation-workflow/drafts/<draft-id>
/implementation-workflow/workflows/<workflow-id>
```

A planning link redirects to the completed workflow address after promotion. The server reads the current `dashboard.html` from workflow storage for every request, so new plans and updated dashboards do not require registration or a server restart.

## Configuration

The optional extension configuration is TOML at:

```text
~/.pi/agent/implementation-workflow/config.toml
```

The path is relative to pi's agent directory, so `PI_CODING_AGENT_DIR` overrides the `~/.pi/agent` part. The previous `~/.pi/agent/implementation-workflow.json` file is no longer accepted. Move its dashboard settings into the TOML file before upgrading.

### Phase model and thinking overrides

A workflow uses the session's selected model and thinking level unless its current phase has an override. The four override names are `planning`, `implementing`, `reviewing`, and `revising`:

```toml
[models.planning]
provider = "isara"
model = "anthropic/claude-opus:planning"
thinking_level = "high"

[models.implementing]
provider = "openai-codex"
model = "gpt-5.4"
thinking_level = "medium"

[models.reviewing]
provider = "isara-review"
model = "openai/gpt-5.4:review"
thinking_level = "max"

[models.revising]
thinking_level = "high"
```

Every field is optional, with these constraints:

- `provider` is the model provider registered with pi. If present, `model` is also required.
- `model` is the complete model identifier. It can contain `/`, `:`, or other characters used by custom Isara models because the provider is stored separately. If present, `provider` is also required.
- `thinking_level` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

A phase table must override the model, the thinking level, or both. You can omit the entire phase. An omitted setting keeps the session's current value. Pi clamps a configured thinking level when the selected model does not support it.

The `reviewing` settings apply both to the isolated review agents that generate the report and to the read-only review session. An override is applied when its phase starts or resumes; it does not lock the model or thinking level against a later manual change. Unknown models, unavailable authentication, and invalid thinking levels produce an error notification instead of silently changing the configuration.

### Local dashboard mode

With no dashboard configuration, the dashboard uses `http://127.0.0.1:43121` and listens only on loopback. All Pi processes using the same workflow directory share that fixed address. If port `43121` conflicts with another service, set a different local port:

```toml
[dashboard]
mode = "local"
listen_port = 43122
```

Local mode always binds to `127.0.0.1`; the public base URL is derived from `listen_port`.

### Remote devbox dashboard mode

Remote mode is an explicit persistent setting because the extension cannot reliably infer the laptop-facing DNS name. Configure it on the devbox:

```toml
[dashboard]
mode = "remote"
public_base_url = "http://rowan-v2-devbox:43121"
listen_port = 43121
listen_host = "0.0.0.0"
```

- `public_base_url` is the absolute HTTP or HTTPS base URL that the laptop can reach. It can include a path prefix, but it must not contain credentials, query parameters, or a fragment.
- `listen_port` is the devbox TCP port used by the temporary server.
- `listen_host` is optional and defaults to `0.0.0.0`. Set it to a specific Tailscale or other interface address to narrow exposure.

**Exposure warning:** `0.0.0.0` accepts connections through every network interface permitted by the host firewall. Dashboard contents can therefore be visible to local-network clients and Tailscale peers, not only to your laptop. Use a narrower bind address or firewall rules when that exposure is not acceptable.

### Sharing and lifecycle

One Pi process owns the temporary listener on the configured port. Other Pi processes recognize it through a versioned health endpoint and use the same deterministic routes for every plan. The server does not retain Pi session objects or an in-memory plan registry.

`/new`, `/resume`, `/fork`, and workflow session switches keep the process-level server alive. Quitting Pi or reloading the extension closes a listener owned by that process. If the owner exits while other Pi processes remain, the next dashboard presentation claims the same port and restores the same URLs; no PID file, detached process, or manual cleanup is needed.

### Troubleshooting

- **Invalid configuration:** Read the notification error and fix the named `~/.pi/agent/implementation-workflow/config.toml` field. Invalid TOML, phase names, models, modes, ports, hosts, and public URLs are rejected.
- **Occupied port:** Stop the unrelated listener or choose another `listen_port`. In local mode, every Pi process that should share dashboards must use the same override.
- **Bind denied or remote link unreachable:** Confirm that `listen_host` exists on the devbox, the firewall permits `listen_port`, and `public_base_url` uses a DNS name and port reachable from the laptop.
- **Isara:** Start `isara pi run` inside the workflow repository as described below. The HTTP listener is process-level, but Isara still determines repository filesystem permissions at launch.
- **Owner exited:** Run `/workflow-dashboard` or press `Ctrl+Alt+D` in another active workflow session to restart service at the stable URL.

## Commands

- `/workflow-plan [ask]` — open the required multiline ask editor, optionally prefilled with the argument, then start planning and show the dashboard link.
- `/workflow-implement [identifier]` — from a planning session, freeze the plan, create the worktree, and switch to an implementation session; otherwise start a fresh implementation session for an existing workflow.
- `/workflow-review [identifier]` — validate the live delivery, generate or reuse the deterministic review, and switch to a read-only review session.
- `/workflow-revise [identifier]` — open the required change-request editor and start a separate revision session in the workflow worktree.
- `/workflow-cleanup [identifier]` — remove the workflow worktree, confirming first when work is uncommitted or unreviewed.
- `/workflow-dashboard` — regenerate the active workflow dashboard and show its link.

There is no state machine to advance: each command checks its own preconditions against Git, GitHub, and the saved plan when it runs, and the extension suggests the natural next command instead of enforcing an order.

## Session names

Planning, implementation, revision, and review session names put the English description next to the stable slug:

```text
Planning: <identifier> · <description>
Implement: <identifier> · <description>
Revise: <identifier> · <description>
Review: <identifier> · <description>
```

Before planning has a final slug, the unavailable slug and separator are omitted:

```text
Planning: <description>
```

After the first agent turn settles, the footer shows the suggested next command for the session's phase: `/workflow-implement when the plan is ready` while planning, `/workflow-review when ready` while implementing or revising, and `/workflow-revise to request changes · /workflow-cleanup to finish` while reviewing. Implementation and revision sessions additionally show a persistent below-editor `/workflow-review` reminder whenever the worktree is clean with new commits. The review session shows a durable transcript card that identifies the session as read-only and explains how to ask about findings, request changes with `/workflow-revise`, or clean up with `/workflow-cleanup`. The footer reminder and review card stay visible if the session resumes.

## State

Planning drafts are session-specific:

```text
~/.pi/agent/workflows/.drafts/<session-id>/
├── plan.md
├── working-plan.md
├── versions/
├── clarifications.json
├── dashboard.html
└── metadata.json
```

Completed plans use the same files under their final identifier:

```text
~/.pi/agent/workflows/<identifier>/
├── plan.md
├── versions/
│   ├── 0001.md
│   ├── 0002.md
│   └── ...
├── clarifications.json
├── dashboard.html
├── review.json
├── review.md
├── reviews/
│   ├── 0001.json
│   ├── 0001.md
│   └── ...
├── review-runs/
│   └── <base>..<head>/<source-fingerprint>/
│       ├── manifest.json
│       ├── incremental-review-scope.json  # re-reviews only
│       ├── planned-changes/
│       │   ├── PC-01.json
│       │   └── ...
│       ├── holistic-review.json
│       ├── testing-criteria-review.json
│       └── synthesis.json
└── metadata.json
```

`metadata.json` records facts only: the verbatim, write-once original ask, the plain-English description, the repository root, the base branch and commit, the workflow branch, the worktree path, and — after a review discovers them — the pull requests in bottom-to-top order as a display cache. There is no stored lifecycle state, review round, or reviewed-commit bookkeeping; whether a workflow is implementable, reviewable, or stale is always derived from the worktree, Git history, open pull requests, and the saved review artifacts. Review files do not exist in planning drafts.

The metadata format is version 4. Workflow directories created by earlier releases of this extension are not migrated; they are skipped by workflow listing and rejected with a clear error when targeted directly.

Only planning activates `workflow_update_plan`. Implementation and revision activate `workflow_questions`. Review sessions disable `edit` and `write`. The plan is referenced by path rather than injected into every model request. Review generation launches isolated read-only Pi processes with a maximum concurrency of four. The identifier remains the source of the plan-directory, branch, and worktree names.

## Isara sandbox requirement

Start `isara pi run` somewhere inside the workflow repository. Isara fixes filesystem write permissions when it launches Pi. A later Pi session switch can change Pi's logical working directory but cannot expand those sandbox permissions.

## Development

```bash
npm install
npm test
```

The package loads `src/index.ts` directly through Pi. No build step is required.

## License

