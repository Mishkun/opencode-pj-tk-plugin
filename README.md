---
title: OpenCode pj/tk workspace plugin
status: experimental
updated: 2026-11-12
---

# OpenCode pj/tk workspace

Projects, tasks and related sessions in the OpenCode terminal sidebar, powered by the [pj CLI](https://github.com/Mishkun/pj). Project records live in `projects/` and `.archived/` within a Git checkout. The plugin adds project actions, task controls and a searchable Inbox for sessions without project membership. Native Todo remains available for session-local work.

Targets OpenCode **2.2.5**. SDK/client versions and UI dependencies are pinned to that tested integration.

## Install from GitHub

1. Install [pj](https://github.com/Mishkun/pj#install-from-github) and make its `bin` directory available on the OpenCode server's PATH.
2. Clone this plugin and install its dependencies:

   ```sh
   git clone https://github.com/Mishkun/opencode-pj-tk-plugin.git
   cd opencode-pj-tk-plugin
   npm ci
   pwd
   ```

3. Merge the following entry into `plugins` in `~/.config/opencode/opencode.jsonc` (or a project-local `opencode.jsonc`). Replace the example path with the absolute checkout path printed by `pwd`; retain your other settings and plugins.

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["/absolute/path/to/opencode-pj-tk-plugin"]
   }
   ```

4. Open a session in your Git repository. Create its first project with `pj`:

   ```sh
   mkdir -p projects/example
   cd projects/example
   pj init --json
   ```

OpenCode loads the server and TUI parts from the same entry. The sidebar shows the project tree and Inbox. Use Project Actions to link the current session, add a task or change the project status. Use Refresh after changing files externally.

For an explicit CLI path, set `OPENCODE_PJ_BIN=/absolute/path/to/pj/bin/pj` in the OpenCode server's environment. Project data and task mutations go through this executable.

## Local development

```sh
npm ci
npm run typecheck
npm test
PJ_INTEGRATION_BIN=/absolute/path/to/pj/bin/pj npm test -- test/cli-integration.test.ts
```

Bun 1.3.14 is a repository-local development dependency; these scripts use npm's local executable path. OpenTUI is pinned to 0.8.0 and Solid to 1.9.18. OpenTUI declares Bun >=1.3.14 and Node >=26.4.0; npm on Node 22 emits an engine warning, while tests run with the local Bun.

## Isolated native verification

Use a synthetic Git repository and an isolated OpenCode profile. Its server config contains:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-pj-tk-plugin"]
}
```

Launch OpenCode 2.2.5 with `--standalone`, with **HOME and every XDG directory redirected into the isolated profile**. Set `OPENCODE_PJ_BIN=/absolute/path/to/pj/bin/pj` in the server environment, or put that companion binary on the isolated server's PATH. Use disposable sessions to verify project display, session linking, task creation, Inbox and archive actions.

The package exports the server at `.` and TUI at `./tui`; root `index.ts` and `tui.ts` are present. `./rpc` exports the transport definition.

Read-only contract probe for an existing synthetic vault:

```sh
OPENCODE_PJ_BIN=/absolute/path/to/pj/bin/pj npm run check:contract -- /absolute/synthetic/vault ses_A
```

The probe lists projects related to the supplied SID and verifies CLI transport/normalization. It runs as a standalone local process and supplies no evidence about native shell admission or UI acceptance.

## Host-client trust boundary

OpenCode permissions govern agent actions. Authenticated native clients and plugin RPC already operate as the host, including native session APIs. `HostPjBridge` is the explicit HOST capability for this plugin's RPC and verified native lifecycle events. RPC inputs contain data targets and project paths; `actorSessionID` is rejected and never selects an agent's permissions. No extra token, session-derived authority, per-file permission manifest or host API change is introduced.

Agents perform project-file reads and mutations with ordinary `pj` commands in the built-in native shell. OpenCode's existing shell policy governs those calls. The system context supplies the configured executable (`OPENCODE_PJ_BIN`, otherwise `pj`), safely quoted examples, cwd conventions, and partial-outcome guidance. Selected project materials are read with native read.

For a root `Manager`, `experimental.idle` checks linked, non-archived projects when the agent loop would otherwise stop and no background work remains. `countsVaultRoot` selects the pj inventory for this hook (default: checkout root). The notice gives all unresolved tasks and the subset that are `open`, dependency-ready and unclaimed or claimed by this session. No lookup on individual model/tool steps, no wake for an idle session when files change. A persisted per-SID signature suppresses repeated ready counts; zero available tasks re-arms the notice. A continuation is an opportunity to finish in-scope work, not authority to take unrelated tasks.

File mutations by agents stay ordinary direct shell commands. The plugin's HOST RPC serves the TUI, and its native lifecycle integration persists fork relationships. Project archiving changes project folders and preserves native conversations, open views and execution. Existing native session archive metadata remains untouched data.

Sources: [Permissions](https://opencode.ai/docs/permissions), [native client](https://opencode.ai/docs/build/client), [plugin RPC](https://opencode.ai/docs/build/plugins/rpc). Native `shell` runs with the host user's filesystem, process and network authority; its agent admission is governed by the `shell` action.

## Implemented host interface

The sidebar shows project folder ancestry under `projects/`, independent project status, task parentage/readiness/status, all stored task assignments, and related sessions. Completed tasks start collapsed. Selecting a session uses native tabs focus, or native session routing when tabs are disabled. The native conversation and composer remain host-owned. Archived project folders are accessed through the CLI or files.

Project Actions offers context, notes, task creation, explicit membership, project status, and **Archive project**. Task selection offers plain task text, start, close, claim, and task notes. Markdown checklists stay ordinary task body text. Controls use muted text, base text on hover, and transparent backgrounds.

Inbox loads the authenticated official native inventory through `ctx.client.session.list({ project: current.projectID, limit: 200, order: "desc", cursor }, { signal })`. Current project metadata comes from `data.session.get(sessionID)`, with authenticated `client.session.get({ sessionID }, { signal })` fallback when cold. The list input omits `directory` to cover nested vault folders and omits `archived` to include both native states.

Every populated page with a next cursor is followed, including the final populated page on OpenCode 2.2.5. An empty page or an absent/null next cursor terminates loading. SIDs are deduplicated, keeping their first occurrence. A repeated cursor, malformed page, read failure or cancellation rejects the whole load. Accumulated pages stay local until success. The sidebar publishes the complete project snapshot and inventory together; request-local session ID/signal, latest-generation and disposal guards prevent stale publication. Loading and unavailable states keep Inbox classification hidden.

Inbox contains root/fork sessions in the current vault/project scope with zero memberships across the complete CLI list, including `.archived/`. Native subagents (`parentID && !fork`) are excluded. A session linked only to archived projects stays outside Inbox; a shared session remains visible under its other active projects. Native session archive flags remain data. **Search Inbox** matches inventory titles or SIDs. Session rows prefer loaded inventory titles and retain native focus/navigation. Incomplete memberships or missing native session data produce a readable unavailable state.

**Archive project** asks for confirmation of the folder move, derives the matching `.archived/` destination, and invokes the existing `pj move` once. The whole nested branch moves with project statuses, README content, task text and assignments, materials and memberships retained. Destination collisions are rejected by pj. The native conversation and composer stay open; the integration makes no native session archive calls.

## Direct agent CLI and native fork lifecycle

Run `pj list` from the vault root for compact non-archived records. Add `--archived` for the complete inventory and for session memberships. Use `--fields` for selected fields or `-a` for full snapshots with task bodies. Run local commands from a project folder or its document subfolder; pj resolves the nearest project. The following uses the configured binary as one quoted shell word:

```sh
pj_bin="${OPENCODE_PJ_BIN:-pj}"
"$pj_bin" list --json
"$pj_bin" list --session ses_ID --archived --json
"$pj_bin" show --json
"$pj_bin" context --json
"$pj_bin" tk claim TASK_ID ses_ID --json
"$pj_bin" tk close TASK_ID --result 'Result and verification' --json
"$pj_bin" log 'Project result' --session ses_ID --json
```

From `projects/P`, archive the whole branch with `"$pj_bin" move '.archived/P' --json`. For `projects/<relative>`, the destination is `.archived/<relative>` relative to the vault root. Project status remains an explicit field and is retained by the move.

Inspect the version-1 envelope and exit status. A successful mutation reports `committed` with its verified commit or `unchanged`. Report saved paths, checks and commit evidence for partial/unknown outcomes. After timeout or cancellation, inspect current state before explicit recovery. Retry, rollback and push remain explicit actions.

Actual `session.forked` events identify the source and cross-check both native source/target identities and locations, `SessionInfo.fork.sessionID` and the message boundary. The event's optional `location` is checked when present; absent event location is resolved through those native records. The HOST lifecycle persists all relationships with one `pj session fork SOURCE TARGET --json` invocation from the vault root, including archived project memberships, with task assignments retained by the source. Generic child `parentID` never establishes fork inheritance. Real persistence failures are surfaced through RPC/toast and a native synthetic message in the forked conversation. There is no retry, rollback, or push.

HOST RPC uses empty input for `snapshot` and explicit `{ project, operation }` for `operate`. The bridge explicitly invokes `pj list -a --archived` to retain task bodies and all archived memberships. A successful snapshot contains the complete project list, `vaultRoot` and `complete: true`; this complete list supplies Inbox membership checks while the tree renders active projects only. Operations come from the bounded structured CLI allowlist. `{ kind: "project-archive" }` accepts no target SID or arbitrary destination and maps to `pj move` from the selected project's cwd.

A conflicting task claim displays the complete CLI error, including owner SIDs, in the existing review alert. The plugin sends one unforced claim. Explicit reassignment is available through `pj tk claim ID SID --force` after coordination.

The HOST bridge executes argument arrays with `shell: false`. Operation kinds, fields, IDs and paths are validated before execution. Mutations return the entire pj envelope, including saved paths, checks and verified/unknown commit state. Invalid/interrupted mutation transport is explicitly unknown. HOST CLI processes have a 30-second timeout and a 16-MiB stdout limit.

## Native acceptance boundaries

1. **Accepted sidebar composition:** the project tree is prepended above the existing native sidebar blocks. Native Todo remains the session's scratchpad. This accepted slice preserves title/MCP/Context and the other native blocks; selective replacement is deferred. The plugin uses the public `sidebar.content` slot and the actual native Todo widget.
2. **Agent admission:** agents call the existing native shell directly for project operations. HOST RPC and fork lifecycle actions use host authority. OpenCode V2 uses the permission action `shell`.
3. **Inbox scope:** only native sessions in the current vault and native project ID are considered. Complete active-and-archived memberships and the full native inventory are required before claiming a session is unlinked. Read errors are shown explicitly.
4. **Live refresh:** RPC `changed`/`forkResult`, native `session.created`, `session.forked`, `session.deleted`, `session.archived`, `session.unarchived`, `session.renamed`, `session.moved`, `server.connected`, route changes and manual Refresh rebuild the project snapshot and inventory. Subscriptions are removed on sidebar cleanup. Native filesystem changes reach the sidebar through the server's RPC change notification; external CLI event delivery remains a native acceptance case. Each refresh uses the existing abort/latest-generation guards; loading is a single pass with explicit error reporting.

## Source map

- `src/contract.ts`, `src/bridge.ts`: normalized CLI envelope, bounded HOST process runner and structured argv.
- `src/projection.ts`: active project/task trees and complete-membership Inbox projection.
- `src/native-inventory.ts`: authenticated paginated native inventory and native refresh subscriptions.
- `src/lifecycle.ts`: verified native fork attachment and focus/navigation.
- `src/server.ts`, `src/rpc.ts`: actual SDK registrations, direct-shell agent instructions and HOST RPC contract.
- `src/tui.tsx`: native sidebar contribution and dialogs.
- `test/`: unit contracts and opt-in real pj/Git first-slice integration.

Pj integration tests create temporary synthetic repositories under ignored `verification/` and remove only their own fixture directories. They execute the real CLI and HOST bridge. They verify CLI transport/data behavior, not native agent admission or full UI acceptance.

The real CLI test archives a nested branch, verifies one scoped commit, preserves unrelated staged/unstaged content, checks destination collision without overwriting, and compares README content, tasks, memberships and statuses before and after the move. Inbox tests cover archived-only membership, shared active projects, true unlinked roots/forks, native child exclusion, search, native legacy flags, foreign scopes and incomplete-read errors.

## License

[MIT](LICENSE).
