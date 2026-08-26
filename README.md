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

## Normal workflow

Start planning inside the repository:

```text
/workflow-plan
```

The command opens a required multiline editor. Submit a non-empty ask to start planning. Press Escape to cancel without changing the session or workflow storage. You can provide optional inline text as an editor prefill, but you must still review and submit it:

```text
/workflow-plan describe the issue
```

If planning is already active, continue through normal conversation instead of running `/workflow-plan` again.

The extension saves the submitted ask verbatim as immutable workflow metadata, starts `plan.md` and `working-plan.md` with only the implementation-plan title, sends the ask as the planning kickoff message, and announces an HTTP dashboard link in the notification panel. It never opens the browser automatically. The dashboard is a self-contained file styled with the Isara design system and served by the extension. It has:

- a concise plain-English plan description as the main document title, beside its prominent current version number;
- a **Plan** view with a guided, change-by-change reader, a full-document fallback, the immutable original ask, and structured user clarifications;
- an automatically generated plan outline, top-anchored previous/next navigation, `[`/`]` section shortcuts, `S`/`C` controls for the navigation and workflow-context sidebars, and direct links to individual planned changes;
- a **Compare versions** view with two version selectors, `[`/`]` diff-block navigation, and a rich, formatted plan diff with green additions and red deletions; nearby changes use Git's default three-line context rule, so changes separated by up to six unchanged lines form one block;
- light and dark themes;
- automatic change detection when the browser regains focus, with a reload only when dashboard content changed.

Press `Ctrl+Alt+D` or run `/workflow-dashboard` to regenerate the dashboard and show its link again.

The plan has **Goal**, **Planned Changes**, and **Testing** sections. Every planned change uses a stable consecutive identifier (`PC-01`, `PC-02`, and so on) with explicit **What** and **Why** fields. A change includes **Pseudocode** only when it clarifies meaningful behavior, state, interfaces, or data flow; mechanical documentation, testing, configuration, data, migration, and wiring changes can omit it. The Testing section contains explicit verification criteria. Planned changes and testing criteria become separate units of the final implementation review. Planning cannot advance if the required structure is missing, empty, or ambiguous.

During planning, the agent uses native `edit` or `write` calls only on `working-plan.md`. It then calls `workflow_update_plan` with a one-sentence-or-less English description. The tool is the only way to commit a plan change: it stores the complete working plan as the next numbered Markdown file under `versions/`, copies the same content to `plan.md`, and updates the description. Calls whose working-plan content matches the prior version still create a new version. `/workflow-next` refuses to advance while `working-plan.md` differs from the committed `plan.md`.

Advance from planning to implementation explicitly:

```text
/workflow-next
```

Planning completion:

1. requires the plan's separate English description to have been saved;
2. warns before excluding uncommitted files from the original checkout;
3. shows a live progress checklist while it generates the final plan slug and creates the worktree;
4. freezes the plan and its version history under `~/.pi/agent/workflows/<identifier>/`;
5. preserves the planning dashboard URL as a redirect to the completed workflow dashboard;
6. creates branch `workflow/<identifier>`;
7. creates `<repository>/.worktrees/<identifier>`;
8. creates and switches to a separate worktree-bound implementation session.

The planning conversation remains saved and does not enter implementation context. If another extension cancels the session switch, run `/workflow-next` again in the completed planning session.

Implementation inspects three durable sources before it acts: the immutable original ask in `metadata.json`, the frozen approved scope in `plan.md`, and later explicit answers in `clarifications.json`. If the approved plan has material ambiguity, the agent asks through `workflow_questions`. Submitted answers are appended verbatim to `clarifications.json` and shown in the dashboard. Selected answers retain the exact option label; custom answers retain the exact submitted text. Cancelled questionnaires are not stored.

After the agent settles, the extension automatically completes implementation when:

- the expected worktree and branch exist;
- the worktree is clean;
- an open pull request exists from the workflow branch to the recorded base branch;
- the pull request branch contains the local `HEAD` commit.

The extension shows progress while checking the worktree and finding the pull request. When the gates pass, it records the pull request and shows a high-contrast completion card. It does not modify the clipboard.

Send `/workflow-next` in the implementation session. A persistent reminder below the editor keeps the command visible until the workflow advances, even if later background output pushes the completion card out of view. If automatic completion checks fail, `/workflow-next` retries them. When the implementation is ready, the workflow deterministically generates the initial review before entering a separate review session:

1. one isolated, read-only agent reviews each `PC-*` planned change against its What, Why, and optional Pseudocode, mapping core contracts or other implementation evidence as appropriate;
2. one read-only holistic reviewer checks cross-cutting architecture, missing behavior, and implementation outside the plan;
3. one read-only testing-criteria reviewer verifies every material requirement in the approved Testing section with repository and execution evidence;
4. one synthesizer receives paths to all three forms of analysis and produces only the overall result and deduplicated overall concerns.

The review progress display nests a live status row under the active stage for every individual agent. Queued and running reviewers, completed or failed reviewers, and reused cached results remain visible while the workflow advances through analysis and synthesis.

Each generated review stores its manifest and agent results under `review-runs/`, keyed by commit range and a fingerprint of the original ask, approved plan, and clarifications. A retry reuses every valid completed result, so a synthesis failure does not repeat the earlier reviews. A new source fingerprint or commit range starts a separate run and preserves earlier results.

The workflow validates that every planned change has exactly one result, stores the combined structured report in `review.json`, exports it as `review.md`, and renders it as the default **Review** tab in the browser dashboard. Review uses the same Guided view and Full document modes as Plan. Guided view shares the one-section-at-a-time outline, previous/next controls, and `[`/`]` shortcuts. Each planned-change section has separate necessary and sufficient verdicts and its own concerns. A dedicated Testing criteria section shows the original criteria, the testing review's verdict, and source evidence for each criterion. Repeating `/workflow-next` after a cancelled session switch reuses the report when the plan and head commit still match.

The review session keeps the implementation conversation out of review context and announces the completed report through the dashboard link. If another extension cancels the review session switch, run `/workflow-next` again.

To revise the implementation after review, run:

```text
/workflow-revise describe the changes to make
```

When `/workflow-revise` detects that `HEAD` changed since the current review, it first asks whether those commits are an already-completed revision. If confirmed, the workflow requires a clean worktree and verifies that the pull request contains the new `HEAD`; it then records the revision transition and immediately generates the next review without starting a revision agent session.

Otherwise, the command opens a required multiline editor and creates a separate revision session in the same worktree. The worktree can already contain manual, uncommitted changes. The revision agent receives the original ask, frozen plan, clarifications, current review, and submitted change request. After the agent commits and pushes at least one new commit and leaves the worktree clean, `/workflow-next` generates the next review round in a new review session.

Each re-review is incremental. First, a read-only scope agent compares the previous reviewed commit with the revised commit and identifies the `PC-*` planned changes whose prior reviews could be affected. The workflow shows that scope agent and each subsequent rerun as nested live progress. It reruns only the affected planned-change reviewers and carries the unaffected planned-change results forward. It always reruns the holistic reviewer, testing-criteria reviewer, and synthesizer against the revised pull request. A retry reuses any valid scope and reviewer results already completed for that re-review.

An older review session cannot clean up or advance a newer revision round. If the branch changes outside the revision flow, the dashboard marks the review stale and cleanup directs the user to `/workflow-revise`.

Advance from an accepted review to cleanup explicitly:

```text
/workflow-next
```

Review completion shows progress while checking and removing the worktree. It switches Pi back to the original repository and removes the worktree directory and Git worktree registration. A high-contrast completion card confirms the result. It keeps the local branch, remote branch, pull request, and saved workflow state.

## Dashboard delivery

The extension serves dashboards over HTTP in local and remote environments. Dashboard addresses are deterministic:

```text
/implementation-workflow/drafts/<draft-id>
/implementation-workflow/workflows/<workflow-id>
```

A planning link redirects to the completed workflow address after promotion. The server reads the current `dashboard.html` from workflow storage for every request, so new plans and updated dashboards do not require registration or a server restart.

### Local mode

With no configuration file, the dashboard uses `http://127.0.0.1:43121` and listens only on loopback. All Pi processes using the same workflow directory share that fixed address. If port `43121` conflicts with another service, create `~/.pi/agent/implementation-workflow.json` with a different local port:

```json
{
  "dashboard": {
    "mode": "local",
    "listenPort": 43122
  }
}
```

Local mode always binds to `127.0.0.1`; the public base URL is derived from `listenPort`.

### Remote devbox mode

Remote mode is an explicit persistent setting because the extension cannot reliably infer the laptop-facing DNS name. On the devbox, create `~/.pi/agent/implementation-workflow.json`:

```json
{
  "dashboard": {
    "mode": "remote",
    "publicBaseUrl": "http://rowan-v2-devbox:43121",
    "listenPort": 43121,
    "listenHost": "0.0.0.0"
  }
}
```

- `publicBaseUrl` is the absolute HTTP or HTTPS base URL that the laptop can reach. It can include a path prefix, but it must not contain credentials, query parameters, or a fragment.
- `listenPort` is the devbox TCP port used by the temporary server.
- `listenHost` is optional and defaults to `0.0.0.0`. Set it to a specific Tailscale or other interface address to narrow exposure.

**Exposure warning:** `0.0.0.0` accepts connections through every network interface permitted by the host firewall. Dashboard contents can therefore be visible to local-network clients and Tailscale peers, not only to your laptop. Use a narrower bind address or firewall rules when that exposure is not acceptable.

### Sharing and lifecycle

One Pi process owns the temporary listener on the configured port. Other Pi processes recognize it through a versioned health endpoint and use the same deterministic routes for every plan. The server does not retain Pi session objects or an in-memory plan registry.

`/new`, `/resume`, `/fork`, and workflow session switches keep the process-level server alive. Quitting Pi or reloading the extension closes a listener owned by that process. If the owner exits while other Pi processes remain, the next dashboard presentation claims the same port and restores the same URLs; no PID file, detached process, or manual cleanup is needed.

### Troubleshooting

- **Invalid configuration:** Read the notification error and fix the named `~/.pi/agent/implementation-workflow.json` field. Invalid JSON, modes, ports, hosts, and public URLs are rejected instead of producing an unreachable link.
- **Occupied port:** Stop the unrelated listener or choose another `listenPort`. In local mode, every Pi process that should share dashboards must use the same override.
- **Bind denied or remote link unreachable:** Confirm that `listenHost` exists on the devbox, the firewall permits `listenPort`, and `publicBaseUrl` uses a DNS name and port reachable from the laptop.
- **Isara:** Start `isara pi run` inside the workflow repository as described below. The HTTP listener is process-level, but Isara still determines repository filesystem permissions at launch.
- **Owner exited:** Run `/workflow-dashboard` or press `Ctrl+Alt+D` in another active workflow session to restart service at the stable URL.

## Commands

- `/workflow-plan [ask]` — open the required multiline ask editor, optionally prefilled with the argument, then start planning and show the dashboard link.
- `/workflow-revise [request]` — open the required multiline revision editor, optionally prefilled with the argument, then start a separate revision session from review.
- `/workflow-next` — advance planning, implementation, revision, or review to the next phase.
- `/workflow-dashboard` — regenerate the active workflow dashboard and show its link.

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

Workflows created before descriptions were introduced keep the shorter title without the description.

After the first planning, implementation, or revision agent turn settles, the footer shows `/workflow-next when ready`. The review session shows the footer reminder immediately because its report is already generated. It also adds a durable transcript card that identifies the session as read-only and explains how to ask about findings, request changes with `/workflow-revise`, or accept the review with `/workflow-next`. The session title identifies the active phase.

The footer reminder and review card stay visible if the session resumes. Implementation and revision completion checks run after each settled turn. After either coding phase completes, a persistent below-editor reminder tells the user to send `/workflow-next`; it stays visible until the workflow enters review. `/workflow-next` enters review after completion or retries failed checks. Cleanup and final completion do not add session names, footer status, or reminders because they are short, non-agentic transitions.

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

`review.json` and `review.md` contain the latest review. Numbered JSON and Markdown reports under `reviews/` preserve every review round. `review-runs/` preserves the reusable agent outputs for each generated review, including the incremental scope for a re-review. Review files do not exist in planning drafts.

`metadata.json` exists from the start of planning. It contains `DraftWorkflowMetadata` while planning and is replaced by `CompletedWorkflowMetadata` when planning completes. Both types store the verbatim, write-once original ask, the plain-English description, and a typed `state` object. `state.phase` is one of `planning`, `implementing`, `reviewing`, `revising`, or `complete`. A step records retry-safe progress inside a phase. Review and revision states also record the review round; revision states record the commit that was reviewed. The declared phase transitions are:

```text
planning → implementing → reviewing → complete
                              ↓     ↑
                           revising
```

The transition API rejects every phase or step change that is not in this state machine. Workflow metadata must contain the typed state directly; legacy lifecycle statuses are not converted. Workflows created before original-ask capture can still load with `ask: null`; new workflows require a non-empty ask. Existing `description.txt` files are migrated into metadata and removed when the workflow next loads. The identifier remains the source of the plan-directory, branch, and worktree names.

On first load, old workflow directories that contain `plan.previous.md` are migrated into the numbered history. The legacy file is left in place but is no longer updated.

Only planning activates `workflow_update_plan`. Implementation and revision activate `workflow_questions`. The plan is referenced by path rather than injected into every model request. Review generation launches isolated read-only Pi processes with a maximum concurrency of four.

## Isara sandbox requirement

Start `isara pi run` somewhere inside the workflow repository. Isara fixes filesystem write permissions when it launches Pi. A later Pi session switch can change Pi's logical working directory but cannot expand those sandbox permissions.

## Development

```bash
npm install
npm test
```

The package loads `src/index.ts` directly through Pi. No build step is required.

## License

MIT. See [LICENSE.md](LICENSE.md).
