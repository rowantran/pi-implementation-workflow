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

The workflow is built around two objects: the **plan bundle** (the immutable original ask, the frozen plan and its version history, and explicit clarifications) and the **workspace** (a dedicated Git worktree and branch). Everything else — pull requests, reviews, session phases — is discovered live from Git, GitHub, and the saved artifacts, so any command can run from any session at any time.

## The main flow

Start planning inside the repository:

```text
/workflow-plan
```

The command opens a required multiline editor. Submit a non-empty ask to start planning. Press Escape to cancel without changing the session or workflow storage. You can provide optional inline text as an editor prefill, but you must still review and submit it:

```text
/workflow-plan describe the issue
```

After you submit the ask, the extension generates a stable slug from it, records the current branch and commit as the base, creates branch `workflow/<identifier>` and worktree `<repository>/.worktrees/<identifier>`, and switches to a planning session there. It warns first if the original checkout has uncommitted files: those files are not copied into the worktree. Cancelling the editor creates no workflow files, branch, or worktree.

If planning is already active, continue through normal conversation instead of running `/workflow-plan` again. A session or worktree that already belongs to a workflow refuses another `/workflow-plan`; start a fresh session in the original checkout instead. The slug never changes as the plan evolves; its English description can change.

The extension saves the submitted ask verbatim as immutable workflow metadata, creates an empty editable plan directory at `working-plan/`, and sends the ask as the planning kickoff message. No plan version is published until the first successful finalization. After each `workflow_update_plan` finalization, its output includes the HTTP dashboard link. It never opens the browser automatically. The extension serves a single-page dashboard styled with the Isara design system. It has:

- a concise plain-English plan description as the main document title, beside its prominent current version number;
- a **Plan** view with a guided reader ordered as Goal, optional Introduction, Dependency graph, original and followup changes, and Testing; a full-document fallback; the immutable original ask; and structured user clarifications;
- the latest finalized snapshot by default, an explicit original approved baseline, and a snapshot selector for historical definitions and flags;
- **Marked implemented** / **Not marked implemented** labels and counts across every original and followup change, separate from independent review verdicts; followups show their source review, testing criteria, and additions or amendments;
- GitHub-style Markdown rendering, including tables, syntax-highlighted code blocks, and Mermaid diagrams in `mermaid` fenced code blocks;
- an automatically generated plan outline, top-anchored previous/next navigation, `[`/`]` section shortcuts, `S`/`C` controls for the navigation and workflow-context sidebars, and direct links to individual planned changes;
- a **Compare versions** view with two version selectors, separate requirement and implementation-flag changes, `[`/`]` diff-block navigation, and a rich, formatted plan diff with green additions and red deletions; nearby changes use Git's default three-line context rule, so changes separated by up to six unchanged lines form one block;
- light and dark themes;
- automatic change detection when the browser regains focus, with a reload only when dashboard content changed.

Press `Ctrl+Alt+D` or run `/workflow-dashboard` to regenerate the dashboard and show its link again.

The plan uses directories for structure, JSON for relationships, and freeform Markdown for explanations. `goal.md` states the desired outcome, optional `intro.md` gives context, and `testing.md` lists explicit verification criteria. Each planned change has a stable descriptive slug, JSON metadata, and a `change.md` explanation. The planning prompt suggests **What**, **Why**, and optional **Pseudocode** sections for readability. Include pseudocode only when it clarifies meaningful behavior, state, interfaces, or data flow. This is writing guidance, not a schema: the application does not extract or validate these sections, and no Markdown heading names, levels, or field order are required. Planned changes and testing criteria become separate units of implementation review.

### Change identity, reading order, and dependencies

Each change lives under `planned-changes/<slug>/`. Slugs use lowercase kebab-case, start with a letter, and contain at most 80 characters. Keep a slug stable when changing its title, prose, or reading position. Do not reuse a deleted slug for an unrelated change.

The plan-level `plan.json` has exactly two fields:

```json
{
  "schemaVersion": 2,
  "readingOrder": [
    "define-redrive-policy",
    "implement-queue-redrive-mechanism",
    "test-redrive-failures"
  ]
}
```

Every change must appear exactly once in `readingOrder`. The dashboard derives visual numbers from this list for each version. Slugs—not display numbers—identify dependencies, links, review results, and changes across versions. Reordering a change does not change its identity.

Version 2 requires a boolean `implemented` in every `change_metadata.json`, initially `false`. Original changes contain exactly these fields:

```json
{
  "title": "Implement queue redrive",
  "dependsOn": ["define-redrive-policy"],
  "implemented": false
}
```

A followup uses the same directory layout, adds a required nonempty `testing.md` beside `change.md`, and records its origin and scope effect in metadata:

```json
{
  "title": "Retry transient redrive failures",
  "dependsOn": ["implement-queue-redrive-mechanism"],
  "implemented": false,
  "followup": {
    "origin": {
      "reviewNumber": 1,
      "sessionId": "review-session-id",
      "entryId": "saved-session-entry-id"
    },
    "effect": { "type": "addition" }
  }
}
```

`origin` identifies the saved review and a current review-session entry where the followup was recorded; it is not a user-approval citation and cannot change after publication. There are no per-followup decisions or proposed/accepted/dismissed states. Discuss suggestions in review, edit the draft, and finalize the intended scope. Every finalized followup is implicitly accepted, just like an original planned change, when you run the next `/workflow-implement` or `/workflow-review`.

An amendment replaces the `effect` value with explicit references to the requirements it changes:

```json
{
  "type": "amendment",
  "requirements": [
    {
      "source": { "type": "change", "id": "implement-queue-redrive-mechanism" },
      "quotedRequirement": "Stop redrive after any failure."
    }
  ]
}
```

Each quote must occur verbatim in its source. Sources are `{ "type": "original-ask" }`, `{ "type": "plan-section", "name": "goal" }` (also `intro` or `testing`), or `{ "type": "change", "id": "stable-slug" }`. An amendment makes the changed requirement explicit without rewriting the original ask or baseline. Followups can amend other followups; amendment references and dependencies must remain acyclic. Every followup needs its own testing criteria, including an amendment to original testing.

`implemented: true` is the implementer's assessment, not proof of delivery, passing tests, or review approval. False means **Not marked implemented**, not that code is absent. A marked change can receive a failing independent review. Code edits, rebases, new followups, and failed reviews do not automatically clear flags. All finalized changes remain in review scope regardless of their flag.

Use `[]` for independent work. Dependencies can refer to later reading-order entries. An arrow **define-redrive-policy → implement-queue-redrive-mechanism** means that the redrive implementation requires the policy. Do not invent dependencies to force a linear sequence or match a pull request stack. Independent changes can still conflict in shared files.

The **Dependency graph** in **Guided view** uses this structured metadata, not parsed Markdown. Nodes display change numbers and titles, not slug IDs. Select a node to highlight its prerequisites and downstream changes. Requires and Enables links connect the change explanations. The version comparison matches changes by slug and summarizes dependency and reading-order changes. Full-document Markdown is generated for display only; it is never a second editable source.

### Prepare, edit, and finalize

Planning, implementation, and review use the same `workflow_update_plan` prepare/edit/finalize interface, with different field permissions:

1. Call with `{"action":"prepare"}`. The tool copies the latest finalized version into `working-plan/`, or creates a skeleton for the first plan. It returns `draftPath` and `baseVersion`; `0` means no published version. Preparing again preserves existing unsaved edits, including invalid drafts.
2. Edit the draft's JSON and Markdown files with native `edit` and `write`, then call with `{"action":"finalize","expectedBaseVersion":0,"description":"Describe the entire plan"}`. Use the base version returned by prepare. The description must be at most 18 words and 160 characters.

Finalization checks required files, nonempty prose, strict JSON fields and types, safe slug IDs, complete reading order, and valid dependencies. Unknown changes, duplicate edges, self-dependencies, cycles, unexpected files, and unsafe links are errors. It reports file and field details together where possible. Invalid drafts remain editable and never replace the published plan.

The tool validates an isolated snapshot and publishes `plan-versions/vN/` by atomically updating the relative `latest-plan` symlink. Concurrent finalization uses a cross-process lock and rejects a stale base version. If another session published a plan, preserve your edits separately, remove the stale working draft, prepare from the latest version, and reconcile your edits. Never overwrite finalized versions or manually change draft bookkeeping.

Finalization creates a plan snapshot, **not a Git commit**, and does not certify clean code. A flag can be finalized without a new code commit or an evidence document. Identical valid content can still create another version. Both implementation and review handoff reject any unfinalized draft differences; they never silently omit followups or flag edits. First approval pins the exact baseline instead of following `latest-plan`.

After approval, the original ask, goal, introduction, original testing, and original change requirements are protected. Original titles, IDs, dependencies, and all metadata except `implemented` stay unchanged. Published IDs cannot be deleted or reused, and old snapshots are immutable. Express requirement changes through followup additions or explicit amendments.

| Phase | Permitted draft edits | Code permissions |
| --- | --- | --- |
| Planning | Plan JSON and Markdown; originals start false, no followups | Read-only |
| Implementation | Only `implemented` booleans on existing originals and followups; no requirement, title, dependency, origin, testing, or reading-order edits | Implement, test, commit, and push |
| Review conversation | Followup JSON/Markdown/testing and reading order; originals remain protected. New followups start false; revised followup requirements must explicitly reset that followup to false. No standalone flag edits or marking true | Code-read-only |
| Isolated review agents | No draft or flag edits | Read-only |

Native `edit`/`write` calls are limited to permitted paths, and finalization enforces field-level rules. Tool-owned metadata, published snapshots, and reports cannot be edited directly. Saving workflow records and handing off between phases never stage or commit files, so unrelated staged changes remain untouched and no Git signing credentials are needed. Records stay local to the worktree. Cleanup asks before deleting them; copy any records you want to keep outside the worktree first.

### Implement

When the plan is ready, run the suggested next command in the planning session:

```text
/workflow-implement
```

From the planning session, this approves the saved plan in the existing worktree:

1. requires a saved English description, a valid plan, and no unsaved working-plan changes;
2. records the approved plan version in metadata;
3. creates and switches to a separate implementation session in the same worktree.

Approval saves local metadata without creating a Git commit. The base commit, slug, artifact paths, and dashboard URL remain unchanged.

The separate slug-generation request at planning startup uses `low` reasoning for OpenAI-compatible APIs, clamped to the selected model's declared supported levels. This avoids disabling reasoning on models that require it and does not change the session's thinking level. Other APIs keep their default behavior.

The planning conversation remains saved and does not enter implementation context. Running `/workflow-implement` again later — from any session — starts a fresh implementation session in the existing worktree.

Implementation reads the immutable original ask in `metadata.json`, the exact original approved baseline and current finalized `plan-versions/vN/` directories, and explicit answers in `clarifications.json`. It also receives the latest review coverage, followup amendments, the working-draft path when present, and the same implemented flags shown in the dashboard. False originals and followups are remaining work; true items are already reported implemented, not independently verified. When all flags are true, the agent does not invent work or claim tests passed. If the scope has material ambiguity, the agent asks through `workflow_questions`. Submitted answers are appended verbatim to the local `clarifications.json` file and shown in the dashboard. Selected answers retain the exact option label; custom answers retain the exact submitted text. Cancelled questionnaires are not stored.

The implementer chooses the lightest reviewable delivery. A small cohesive plan uses one pull request. A larger plan uses a linear stack through Graphite. When Graphite is unavailable, the implementer submits a native GitHub PR stack through GitHub CLI (`gh`). The initial `workflow/<identifier>` branch is always the bottom branch. Its pull request targets the recorded base branch; every later pull request targets the branch directly below it; and the checked-out branch remains the stack tip. Planning does not add subplans or pull request boundaries.

After a settled implementation turn leaves the worktree clean with new commits, a persistent reminder below the editor suggests `/workflow-review`. The reminder is a suggestion, not a gate: full delivery validation happens when you run the review.

### Review

```text
/workflow-review
```

The command checks the live delivery — the worktree must be clean, and walking open pull requests backward from the checked-out branch must form a complete linear chain to the recorded base branch, with the bottom pull request on the initial workflow branch, each pull request containing the branch below it, and the stack tip containing the local `HEAD` commit. A normal pull request is a stack with one item. The discovered pull requests are recorded bottom to top as display metadata.

The workflow then deterministically generates the review before entering a separate code-read-only review session with followup draft editing:

1. one isolated, read-only agent reviews every slug-identified original and finalized followup, including those marked implemented, against its full Markdown explanation, dependencies, and explicit amendments, producing a literate Markdown walkthrough of what was actually implemented — prose interleaved with key code excerpts and callouts for deviations from the plan;
2. one read-only holistic reviewer checks cross-cutting architecture, missing behavior, and implementation outside the plan;
3. one read-only testing-criteria reviewer verifies the original Testing section and every followup's testing group with repository and execution evidence;
4. one synthesizer receives paths to all three forms of analysis and produces only the overall result and deduplicated overall concerns.

The review progress display nests a live status row under the active stage for every individual agent. Queued and running reviewers, completed or failed reviewers, and reused cached results remain visible while the workflow advances through analysis and synthesis.

Reviews are local derived artifacts with two storage layers:

- `review-runs/` is the work-in-progress cache of raw per-agent outputs, keyed by commit range and a fingerprint of the original ask, baseline requirements, finalized followup requirements, and clarifications. A retry reuses every valid completed result, so a synthesis failure does not repeat the earlier reviews. It is safe to delete; deleting it only costs recomputation.
- `reviews/` is the local, append-only history of finished reports. Each saved report is the synthesized review of one commit range. `review.json` and `review.md` always mirror the newest report and feed the default **Review** tab in the browser dashboard.

Saving a report updates local files without creating a Git commit. For compatibility with older branches, reviews, readiness reminders, and dashboard staleness still ignore trailing `.workflows/`-only commits. Delivery may accept such an unpushed suffix when the remote pull request tip is its ancestor and the implementation content is identical; unpushed code changes still block review.

Running `/workflow-review` again selects the cheapest correct behavior from the saved artifacts and Git history — never an error:

- if the newest report already covers the current commits, plan, and pull requests, it is reused as-is;
- if a saved report reviewed an earlier state of the same plan and its head commit is a Git ancestor of the current head, the re-review is incremental: a read-only scope agent identifies by slug the planned changes whose prior reviews could be affected, only those are rerun, and unaffected planned-change results carry forward, while the holistic reviewer, testing-criteria reviewer, and synthesizer always rerun against the complete aggregate delivery;
- otherwise — after a rebase, history rewrite, or any other mismatch — the workflow says so and generates a full review.

Requirement changes, including finalizing a followup at unchanged code HEAD, require a full review. Later code-only changes with the same scope can use an incremental review. Toggling `implemented` or converting a version 1 plan alone does not change the requirement fingerprint or stale a current-format report. Origin metadata is also excluded from that fingerprint, but published origins remain immutable. Neither review generation nor cache reuse writes flags.

The report and dashboard list every pull request from bottom to top. Review uses the same Guided view and Full document modes as Plan. Guided view shares the one-section-at-a-time outline, previous/next controls, and `[`/`]` shortcuts. Each planned-change section has its literate implementation walkthrough, separate necessary and sufficient verdicts, and its own concerns. A dedicated Testing criteria section shows the original criteria and each followup group, the testing review's verdict, and source evidence for each criterion. Version 4 reports store original/followup kinds and amendment effects, exact `baselinePlanVersion` and `currentPlanVersion` numbers, `testingCriteria.originalCriteria`, and groups identified by `plan:testing` or `followup:<slug>`. Each `testingCriteria.review.criteria` result has a matching `sourceId`. Historical reports keep their own definitions and the flags from their exact reviewed snapshot, never those of a newer plan.

The review session keeps the implementation conversation out of review context and announces the completed report through the dashboard link. It is **code-read-only**, but native `edit` and `write` can update permitted followup draft files. A durable transcript card explains how to discuss findings and finalize followups, then continue with `/workflow-implement` or finish with `/workflow-cleanup`.

## Side flows

### Brief any agent session

```text
/workflow-brief [identifier]
```

Run this in an existing side-agent session to load the workflow's original ask, exact baseline and current finalized plan paths, followup amendments and flags, explicit user clarifications, and latest review when available. The agent reads the context, confirms which workflow and plan status it loaded, then waits for your task. It does not start implementation or advance the workflow.

Briefing does not create a session, change its working directory, rename it, assign a role, select a model, or change its tools. Its workflow association survives resume and compaction. Artifact paths remain available on later turns, so the agent can read updated sources rather than rely on a stale summary. During planning, the briefing explicitly identifies the plan as unapproved and points out any separate working draft. Side agents must coordinate edits because they share the worktree.

An explicit identifier selects a workflow; otherwise the active marker in the current worktree takes priority over a saved session association. A role-bound session cannot be briefed on a different workflow.

### Continue after review

Discuss corrections in the review session, edit followups through `workflow_update_plan`, and finalize them. Run `/workflow-implement` to start a fresh implementation session in the same worktree; there is no change-request editor or separate revision phase. Existing manual code edits and the checked-out stack tip survive. After implementation commits and pushes, run `/workflow-review` again.

The removed `/workflow-revise` command has no alias. Use `/workflow-implement` instead. Legacy serialized `revision` sessions resume with implementation behavior, without reviving the old request editor.

### Clean up

```text
/workflow-cleanup
```

Cleanup asks for confirmation before deleting local workflow records, including the original ask, plan versions, clarifications, finished reviews, and any working draft. It removes those files with the worktree directory and its Git worktree registration, keeping local branches, remote branches, and pull requests. It does not create a Git commit or an archive of the workflow files.

Cleanup also asks for confirmation before discarding uncommitted code changes or when no saved review covers the current implementation content. When the current session lives inside the worktree, the command switches Pi back to the original repository first and removes the worktree from there; otherwise it removes the worktree in place. The active marker, dashboard, and review cache are also removed with the worktree. The dashboard URL is no longer served after cleanup.

## Targeting a workflow

Every worktree verb — `/workflow-brief`, `/workflow-implement`, `/workflow-review`, and `/workflow-cleanup` — resolves its target workflow in this order:

1. an explicit identifier argument, with autocomplete over known workflows (for example `/workflow-review my-plan-slug`);
2. the workflow identified by `.workflows/active.json` in the current worktree;
3. the workflow already bound to the current session;
4. otherwise, the active workflows recorded for the current repository: a single match is used directly, and multiple matches open an interactive picker sorted by recency.

Other `.workflows/` directories never imply an active workflow. Only the local active marker does. Opening a bound session or running a workflow command in an active worktree can rebuild a missing global locator.

Because the argument position is reserved for identifiers, only `/workflow-plan` accepts inline prefill text.

## Dashboard delivery

Plan and Review code blocks use Marked for Markdown parsing and highlight.js for syntax highlighting, including Guided view, Full document, and version comparisons. Agents are instructed to label fenced code blocks with the language immediately after the opening backticks, such as `typescript`, `bash`, or `json`. The bundled highlighter supports common languages and aliases such as `ts`, `js`, and `py`. Unlabeled blocks, unsupported languages, and `text` blocks remain plain text; `mermaid` blocks remain diagrams. Code colors follow the light or dark theme without replacing the green and red diff backgrounds. All rendering libraries are served locally; the browser does not need a CDN connection.

The extension serves dashboards over HTTP in local and remote environments. Dashboard addresses are deterministic:

```text
/implementation-workflow/workflows/<workflow-id>
```

The same link works from planning through review. On every request, the server resolves the identifier through the global locator index, validates the worktree's active marker, and reads its current `dashboard.html`. It does not serve historical bundles or removed worktrees.

## Configuration

The optional extension configuration is TOML at:

```text
~/.pi/agent/implementation-workflow/config.toml
```

The path is relative to pi's agent directory, so `PI_CODING_AGENT_DIR` overrides the `~/.pi/agent` part. The previous `~/.pi/agent/implementation-workflow.json` file is no longer accepted. Move its dashboard settings into the TOML file before upgrading.

### Phase model and thinking overrides

A workflow uses the session's selected model and thinking level unless its current phase has an override. The three override names are `planning`, `implementing`, and `reviewing`:

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
```

Every field is optional, with these constraints:

- `provider` is the model provider registered with pi. If present, `model` is also required.
- `model` is the complete model identifier. It can contain `/`, `:`, or other characters used by custom Isara models because the provider is stored separately. If present, `provider` is also required.
- `thinking_level` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

A phase table must override the model, the thinking level, or both. You can omit the entire phase. An omitted setting keeps the session's current value. Pi clamps a configured thinking level when the selected model does not support it.

The removed `models.revising` table is rejected with a migration message. Move its desired settings into `models.implementing` and delete the old table; it is not silently ignored or treated as an alias.

The `reviewing` settings apply both to the isolated review agents that generate the report and to the code-read-only review session. An override is applied when its phase starts or resumes; it does not lock the model or thinking level against a later manual change. Unknown models, unavailable authentication, and invalid thinking levels produce an error notification instead of silently changing the configuration.

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

- `/workflow-plan [ask]` — open the required multiline ask editor, generate a stable slug, create the worktree, and start planning there. The dashboard link appears after `workflow_update_plan` saves the first plan version.
- `/workflow-brief [identifier]` — load workflow context into the current session without assigning a role or changing its tools.
- `/workflow-implement [identifier]` — from a planning session, approve the saved plan and switch to implementation; otherwise start a fresh implementation session for an approved workflow.
- `/workflow-review [identifier]` — validate the live delivery, generate or reuse the deterministic review, and switch to a code-read-only review session with followup draft editing.
- `/workflow-cleanup [identifier]` — confirm deletion of local workflow records and remove the worktree, with additional checks for uncommitted code or unreviewed work.
- `/workflow-dashboard` — regenerate the active workflow dashboard and show its link.

There is no state machine to advance: each command checks its own preconditions against Git, GitHub, and the saved plan when it runs, and the extension suggests the natural next command instead of enforcing an order.

## Session names

Planning, implementation, and review session names put the English description next to the stable slug:

```text
Planning: <identifier> · <description>
Implement: <identifier> · <description>
Review: <identifier> · <description>
```

Planning has its stable slug from the start. Until a description is saved, the name is `Planning: <identifier>`. Briefing leaves the existing session name unchanged.

After the first agent turn settles, the footer suggests `/workflow-implement when the plan is ready` while planning, `/workflow-review when ready` while implementing, and `/workflow-implement after finalizing followups · /workflow-cleanup to finish` while reviewing. When the checked-out workflow branch has an open pull request, the footer starts with a clickable `PR #<number>` link. For a stack, it shows only the tip pull request; implementation guidance then reads `/workflow-review to review`. Implementation sessions additionally show a persistent below-editor `/workflow-review` reminder whenever the worktree is clean with new commits. Readiness uses delivery and review coverage, never all-true flags. The review transcript card describes code-read-only access, followup draft editing, and implementation after finalization. Both reminders survive resume.

## State

Workflow files are local to the worktree under `.workflows/`, which the consumer repository's `.gitignore` is expected to ignore. The extension saves these files locally; it does not automatically commit or push them. Each active worktree contains one marker and a bundle under its stable identifier:

```text
<worktree>/.workflows/
├── active.json                 # active identifier and machine-local paths
└── <identifier>/
```

The local bundle exists from planning until cleanup:

```text
<worktree>/.workflows/<identifier>/
├── plan-versions/
│   ├── v1/
│   └── v2/
│       ├── plan.json            # schemaVersion and readingOrder
│       ├── goal.md
│       ├── intro.md            # optional
│       ├── testing.md
│       ├── version-metadata.json # tool-owned title, time, and integrity digest
│       └── planned-changes/
│           └── implement-queue-redrive-mechanism/
│               ├── change_metadata.json # title, dependsOn, implemented; optional followup origin/effect
│               ├── change.md
│               └── testing.md          # required for followups only
├── latest-plan -> plan-versions/v2
├── clarifications.json
├── working-plan/               # phase-restricted editable draft
├── .plan-draft-base.json        # tool-owned draft base
├── .plan.lock                  # prepare/finalize operation lock
├── dashboard.html              # generated browser view
├── review.json
├── review.md
├── reviews/
│   ├── 0001.json
│   ├── 0001.md
│   └── ...
├── review-runs/                # recomputable review cache
│   └── <base>..<head>/<source-fingerprint>/
│       ├── manifest.json
│       ├── incremental-review-scope.json  # re-reviews only
│       ├── planned-changes/
│       │   ├── implement-queue-redrive-mechanism.json
│       │   └── ...
│       ├── holistic-review.json
│       ├── testing-criteria-review.json
│       └── synthesis.json
└── metadata.json
```

Local `metadata.json` records workflow facts: the verbatim, write-once original ask, identifier, base branch and commit, workflow branch, creation time, and the approved plan version when one exists. Each plan snapshot stores its English description, creation time, and integrity digest in tool-owned `version-metadata.json`. The Plan view defaults to the latest finalized snapshot's description and uses the selected snapshot's description when viewing history; the original approved baseline stays identified separately. Approval also records its description in workflow metadata. An absent approval version means the plan is still being drafted. The local `active.json` marker contains the active identifier, repository/worktree paths, Git common directory, and discovered pull requests as a display cache.

The global `~/.pi/agent/workflows/<identifier>.json` files are small location pointers, not artifact copies. The extension uses them for identifier lookup and shared dashboard routing. Authoritative files stay inside the worktree and are deleted with it during cleanup. Stale pointers are skipped when listing workflows. Pi conversation transcripts continue to use Pi's normal session storage.

There is no stored review round or lifecycle state machine; reviewability and staleness are derived from Git, open pull requests, approval metadata, and saved reports.

The metadata format remains version 6; new plan manifests use schema version 2 and reports use version 4. Version 1 plans and version 3 reports remain readable and unchanged on disk. Missing legacy `implemented` fields normalize to false; this is not evidence of missing code. Prepare upgrades only the editable copy to version 2 with explicit false booleans. An implementer can inspect existing code and mark it true without reimplementing it. Legacy reports are displayed as stale and the next review produces a version 4 report through a full review. Older incompatible workflow metadata formats are still rejected, not automatically migrated.

Planning, implementation, and review activate `workflow_update_plan` with the field permissions above. Implementation activates `workflow_questions`. Briefing assigns no role and preserves the session's tools. Plans are referenced by exact paths rather than injecting the whole history into every model request. Review generation launches isolated read-only Pi processes with a maximum concurrency of four. The identifier remains the source of the artifact-directory, branch, and worktree names.

## Isara sandbox requirement

Start `isara pi run` somewhere inside the workflow repository. Isara fixes filesystem write permissions when it launches Pi. A later Pi session switch can change Pi's logical working directory but cannot expand those sandbox permissions.

## Development

```bash
npm install
npm test
```

The package loads `src/index.ts` directly through Pi. No build step is required.

Preview a branching dependency plan with the real dashboard renderer and bundled Mermaid assets:

```bash
npm run preview:dag
```

Open the printed loopback URL. The preview includes two plan versions so you can inspect graph navigation and dependency differences. It uses temporary storage, not your saved workflows, and removes its temporary files when stopped with Ctrl+C. To use another port, run `PORT=43124 npm run preview:dag`. The example structured plan is at `scripts/fixtures/dependency-plan.mjs`.

## License

