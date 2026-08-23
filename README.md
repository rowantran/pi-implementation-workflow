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

Each completed plan has a unique identifier, a complete numbered version history, a static web dashboard, and structured implementation clarifications.

## Normal workflow

Start planning inside the repository:

```text
/workflow-plan describe the issue
```

The extension opens `dashboard.html` in the default browser. The dashboard is a self-contained file styled with the Isara design system, so it does not need a web server. It has:

- a concise plain-English plan description as the main document title, beside its prominent current version number;
- a **Plan** view for the latest plan and user clarifications;
- a **Compare versions** view with two version selectors and a GitHub-style colored line diff;
- light and dark themes;
- automatic refresh when the browser regains focus.

Press `Ctrl+Alt+D` or run `/workflow-dashboard` to open the dashboard again.

During planning, the agent uses `workflow_update_plan` instead of direct `edit` or `write` calls. Each tool call stores the complete plan as the next numbered Markdown file under `versions/` and updates its one-sentence-or-less English description, including calls whose plan content matches the prior version. Manual changes to `plan.md` are also detected and stored as new versions.

Advance from planning to implementation explicitly:

```text
/workflow-next
```

Planning completion:

1. warns before excluding uncommitted files from the original checkout;
2. shows a live progress checklist while it generates the final plan slug, finalizes the separate English description, and creates the worktree;
3. freezes the plan and its version history under `~/.pi/agent/workflows/<identifier>/`;
4. preserves the planning dashboard URL as a redirect to the completed workflow dashboard;
5. creates branch `workflow/<identifier>`;
6. creates `<repository>/.worktrees/<identifier>`;
7. copies `/workflow-implement <identifier>` to the clipboard;
8. shows a high-contrast completion card with the copied command.

Paste the copied command directly into the planning session. The command creates and switches to a separate worktree-bound implementation session, so the planning conversation remains saved and does not enter implementation context. Starting with `/new` first is still supported but is not necessary.

If the approved plan has material ambiguity, the agent asks through `workflow_questions`. Submitted answers are appended verbatim to `clarifications.json` and shown in the dashboard. Selected answers retain the exact option label; custom answers retain the exact submitted text. Cancelled questionnaires are not stored.

Implementation completes automatically when the agent settles and all gates pass:

- the expected worktree and branch exist;
- the worktree is clean;
- an open pull request exists from the workflow branch to the recorded base branch.

The extension shows progress while checking the worktree and finding the pull request. It then records the pull request, copies `/workflow-review <identifier>` to the clipboard, and shows a high-contrast completion card. `/workflow-next` remains available to manually retry advancing when a completion gate fails.

Paste the review command directly into the implementation session. It creates and switches to a separate review session in the same worktree, so the implementation conversation remains saved and does not enter review context. Starting with `/new` first is still supported but is not necessary. Review opens the frozen-plan dashboard and reviews the recorded pull request. Advance from review to cleanup explicitly:

```text
/workflow-next
```

Review completion shows progress while checking and removing the worktree. It switches Pi back to the original repository and removes the worktree directory and Git worktree registration. A high-contrast completion card confirms the result. It keeps the local branch, remote branch, pull request, and saved workflow state.

## Commands

- `/workflow-plan [issue]` — start or resume planning and open the dashboard.
- `/workflow-dashboard` — regenerate and open the active workflow dashboard.
- `/workflow-implement <identifier>` — enter a fresh implementation session in the stored worktree.
- `/workflow-review <identifier>` — enter a fresh read-only review session in the stored worktree.
- `/workflow-next` — advance planning or review to the next phase, or manually retry advancing from implementation.

## Session names

Planning, implementation, and review session names put the English description next to the stable slug:

```text
Planning: <identifier> · <description>
Implement: <identifier> · <description>
Review: <identifier> · <description>
```

Before planning has a final slug, the unavailable slug and separator are omitted:

```text
Planning: <description>
```

Workflows created before descriptions were introduced keep the shorter title without the description. Cleanup and completion do not add session names or footer status because they are short, non-agentic transitions.

## State

Planning drafts are session-specific:

```text
~/.pi/agent/workflows/.drafts/<session-id>/
├── plan.md
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
└── metadata.json
```

`metadata.json` exists from the start of planning. It contains `DraftWorkflowMetadata` while planning and is replaced by `CompletedWorkflowMetadata` when planning completes. Both types store the plain-English description. The completed type also stores the final identifier and workflow lifecycle state. Existing `description.txt` files are migrated into metadata and removed when the workflow next loads. The identifier remains the source of the plan-directory, branch, and worktree names.

On first load, old workflow directories that contain `plan.previous.md` are migrated into the numbered history. The legacy file is left in place but is no longer updated.

Only planning activates `workflow_update_plan`. Only implementation activates `workflow_questions`. The plan is referenced by path rather than injected into every model request.

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
