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
/workflow-plan
```

The command opens a required multiline editor. Submit a non-empty ask to start planning. Press Escape to cancel without changing the session or workflow storage. You can provide optional inline text as an editor prefill, but you must still review and submit it:

```text
/workflow-plan describe the issue
```

If planning is already active, continue through normal conversation instead of running `/workflow-plan` again.

The extension saves the submitted ask verbatim as immutable workflow metadata, starts `plan.md` with only the implementation-plan title, sends the ask as the planning kickoff message, and opens `dashboard.html` in the default browser. The dashboard is a self-contained file styled with the Isara design system, so it does not need a web server. It has:

- a concise plain-English plan description as the main document title, beside its prominent current version number;
- a **Plan** view for the latest plan, the immutable original ask, and structured user clarifications;
- a **Compare versions** view with two version selectors and a rich, formatted plan diff with green additions and red deletions;
- light and dark themes;
- automatic refresh when the browser regains focus.

Press `Ctrl+Alt+D` or run `/workflow-dashboard` to open the dashboard again.

During planning, the agent uses `workflow_update_plan` instead of direct `edit` or `write` calls. Each tool call stores the complete plan as the next numbered Markdown file under `versions/` and updates its one-sentence-or-less English description, including calls whose plan content matches the prior version. Manual changes to `plan.md` are also detected and stored as new versions.

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
- an open pull request exists from the workflow branch to the recorded base branch.

The extension shows progress while checking the worktree and finding the pull request. When the gates pass, it records the pull request, copies `/workflow-next` to the clipboard, and shows a high-contrast completion card.

Paste `/workflow-next` directly into the implementation session. It creates and switches to a separate review session in the same worktree, so the implementation conversation remains saved and does not enter review context. If automatic completion checks fail, `/workflow-next` retries them and enters review immediately when they pass. If another extension cancels the review session switch, run `/workflow-next` again. Review opens the frozen-plan dashboard and compares the recorded pull request with the same three durable sources: `metadata.json`, `plan.md`, and `clarifications.json`. Advance from review to cleanup explicitly:

```text
/workflow-next
```

Review completion shows progress while checking and removing the worktree. It switches Pi back to the original repository and removes the worktree directory and Git worktree registration. A high-contrast completion card confirms the result. It keeps the local branch, remote branch, pull request, and saved workflow state.

## Commands

- `/workflow-plan [ask]` — open the required multiline ask editor, optionally prefilled with the argument, then start planning and open the dashboard.
- `/workflow-next` — advance planning, implementation, or review to the next phase.
- `/workflow-dashboard` — regenerate and open the active workflow dashboard.

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

Workflows created before descriptions were introduced keep the shorter title without the description.

After the first agent turn settles in a phase, the footer shows `/workflow-next when ready`. The session title already identifies whether the active phase is planning, implementation, or review.

The reminder stays visible if the session resumes. Implementation completion checks run after each settled turn, and `/workflow-next` enters review after completion or retries failed checks. Cleanup and completion do not add session names or footer status because they are short, non-agentic transitions.

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

`metadata.json` exists from the start of planning. It contains `DraftWorkflowMetadata` while planning and is replaced by `CompletedWorkflowMetadata` when planning completes. Both types store the verbatim, write-once original ask and the plain-English description. The completed type also stores the final identifier and workflow lifecycle state. Workflows created before original-ask capture migrate with `ask: null`; new workflows require a non-empty ask. Existing `description.txt` files are migrated into metadata and removed when the workflow next loads. The identifier remains the source of the plan-directory, branch, and worktree names.

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
