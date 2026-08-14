# Pi

T3 Code can run Pi through Pi's RPC mode. Pi keeps control of its models, accounts, extensions,
skills, tools, configuration, and session files.

## Set Up Pi

Install and configure Pi first. Confirm that the command works in the same environment as the T3
server:

```bash
pi --version
```

Then open **Settings**, add a **Pi** provider, and refresh its status. T3 uses `pi` from `PATH` by
default. Set **Binary path** when Pi lives elsewhere.

T3 marks the provider unavailable when it cannot run the configured binary.

## Models And Reasoning

T3 asks Pi for its current model list. Sign in to providers and manage custom models through Pi as
you normally would. T3 does not keep a separate fallback model list.

The model picker shows the models Pi reports. The reasoning picker only shows levels supported by
the selected model.

## MCP, Subagents, Commands, And Skills

Pi keeps MCP and subagents outside its core. A useful T3 setup must enable extensions for both.
Install the MCP adapter in Pi's normal configuration:

```bash
pi install npm:pi-mcp-adapter
```

T3 reports a warning when it cannot detect that adapter. The adapter reads `.mcp.json`,
`~/.config/mcp/mcp.json`, and its Pi-specific override files. Its proxy and direct MCP calls appear
as MCP tool activity in T3. Remote OAuth can use the adapter's `auth-start` and `auth-complete`
tool actions.

Enable a Pi subagent extension for isolated agents. T3 supports Pi's current `subagent` extension
result format, including single, parallel, and chained work. It also supports the older
`subagent_spawn` and `workflow` formats. Claude Code-style `Agent` extensions, including
`@tintinweb/pi-subagents`, can keep background agents running while the main Pi orchestrator
accepts new messages. T3 tracks their completion notifications and `get_subagent_result` calls.
Agent status, model, token use, and completed tool-call count appear in the Agents panel. For
`@tintinweb/pi-subagents`, token and tool-use counters update while an agent runs and retain their
final values when it settles. T3 also loads a private RPC-only Pi bridge for normalized lifecycle
events and targeted Stop requests. When `@tintinweb/pi-subagents`
reports RPC protocol v2 support, **Stop generation** stops detached and queued agents by their
opaque agent ID. T3 does not use a generic process-tree kill when targeted Stop is unavailable.

T3 reads the user-level Pi command catalog when it checks the provider:

- User-level Pi extension and prompt commands appear in the `/` menu.
- User-level Pi skills appear in both the `/skill:` menu and the `$` skill menu.
- Project commands and skills load inside the project session but are not advertised as a global
  provider catalog.
- Extension `select`, `confirm`, `input`, and `editor` requests use T3's user-input panel.

Extensions must use Pi's RPC-compatible UI methods for remote input. TUI-only custom views cannot
run in RPC mode.

## Sessions And Configuration

T3 stores the Pi session file path with each thread and resumes that same file later. It validates
the durable session ID, canonical file path, and working directory before resume. An invalid cursor
fails clearly and remains stored for diagnosis. It is never discarded automatically. A client can
explicitly start a new Pi session with `resumePolicy: "fresh"`; this ignores the supplied or stored
cursor without deleting the old Pi session file.

T3 reads the active Pi entry branch through `get_entries`. Thread rollback is available only while
the session and all background work are idle. It uses Pi's durable user-entry IDs with the native
`fork` operation. A rollback fails if an extension cancels the fork or Pi changes session identity.

T3 does not copy or replace Pi's configuration directory. Changes made through Pi remain available
in T3, and changes made by a T3-hosted Pi session remain available to Pi.

You can set environment variables on each Pi provider instance in Settings. T3 passes them to the
Pi process without replacing the rest of the server environment.

## Context Use

T3 requests Pi session statistics at assistant response boundaries and settlement. Refreshes are
coalesced and stop after a short bound, so telemetry cannot block generation or settlement. The
thread meter shows the tokens in the current model context, while processed-token totals remain
cumulative for the session. Immediately after Pi compacts a session, current usage can be
temporarily unavailable until the next model response.

## Current Limits

Pi sessions use **Full access** mode. T3 does not add an approval gate around Pi tools. MCP and
subagent behavior comes from the enabled Pi extensions, and T3 translates their RPC events. Git
checkpoints are authoritative for workspace diffs when available; partial provider-native patches
remain a fallback when a real checkpoint is unavailable.
