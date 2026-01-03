# Config Module Usage Map

This document shows how each file uses the config module and what subpaths they access.

## Overview Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              config.ts exports                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Constants:        APP_NAME, CONFIG_DIR_NAME, VERSION, ENV_AGENT_DIR             │
│ Single paths:     getAgentDir, getAuthPath, getModelsPath, getCommandsDir, ...  │
│ Multi-config:     getConfigDirs, getConfigDirPaths, findConfigFile,             │
│                   readConfigFile, findNearestProjectConfigDir, ...              │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Usage by Category

### 1. Display/Branding Only (no file I/O)

| File | Imports | Purpose |
|------|---------|---------|
| `cli/args.ts` | `APP_NAME`, `CONFIG_DIR_NAME`, `ENV_AGENT_DIR` | Help text, env var names |
| `cli/plugin-cli.ts` | `APP_NAME` | Command output |
| `cli/update-cli.ts` | `APP_NAME`, `VERSION` | Update messages |
| `core/export-html/index.ts` | `APP_NAME` | HTML export title |
| `modes/interactive/components/welcome.ts` | `APP_NAME` | Welcome banner |
| `utils/tools-manager.ts` | `APP_NAME` | Tool download messages |

### 2. Single Fixed Paths (user-level only)

| File | Imports | Path | Purpose |
|------|---------|------|---------|
| `core/logger.ts` | `CONFIG_DIR_NAME` | `~/.omp/logs/` | Log file directory |
| `core/agent-session.ts` | `getAuthPath` | `~/.omp/agent/auth.json` | Error messages |
| `core/session-manager.ts` | `getAgentDir` | `~/.omp/agent/sessions/` | Session storage |
| `modes/interactive/theme/theme.ts` | `getCustomThemesDir` | `~/.omp/agent/themes/` | Custom themes |
| `modes/interactive/interactive-mode.ts` | `getAuthPath`, `getDebugLogPath` | auth.json, debug log | Status messages |
| `utils/changelog.ts` | `getChangelogPath` | Package CHANGELOG.md | Re-exports |
| `core/system-prompt.ts` | `getAgentDir`, `getDocsPath`, `getExamplesPath`, `getReadmePath` | Package assets + AGENTS.md | System prompt building |
| `migrations.ts` | `getAgentDir` | `~/.omp/agent/` | Auth/session migration |
| `core/plugins/installer.ts` | `getAgentDir` | `~/.omp/agent/` | Plugin installation |
| `core/plugins/paths.ts` | `CONFIG_DIR_NAME` | `~/.omp/plugins/` | Plugin directories |

### 3. Multi-Config Discovery (with fallbacks)

These use the new helpers to check `.omp`, `.pi`, `.claude` directories:

| File | Helper Used | Subpath(s) | Levels |
|------|-------------|------------|--------|
| `main.ts` | `findConfigFile` | `SYSTEM.md` | project |
| `core/sdk.ts` | `getConfigDirPaths` | `auth.json`, `models.json` | user |
| `core/settings-manager.ts` | `readConfigFile` | `settings.json` | user+project |
| `core/skills.ts` | `getConfigDirPaths` | `skills/` | user+project |
| `core/slash-commands.ts` | `getConfigDirPaths` | `commands/` | project |
| `core/hooks/loader.ts` | `getConfigDirPaths` | `hooks/` | project |
| `core/custom-tools/loader.ts` | `getConfigDirPaths` | `tools/` | project |
| `core/custom-commands/loader.ts` | `getConfigDirPaths` | `commands/` | project |
| `core/plugins/paths.ts` | `getConfigDirPaths` | `plugin-overrides.json` | project |
| `core/mcp/config.ts` | `getConfigDirPaths` | `mcp.json` | user+project |
| `core/tools/lsp/config.ts` | `getConfigDirPaths` | `lsp.json`, `.lsp.json` | user+project |
| `core/tools/task/commands.ts` | `getConfigDirPaths`, `findAllNearestProjectConfigDirs` | `commands/` | user+project |
| `core/tools/task/discovery.ts` | `getConfigDirs`, `findAllNearestProjectConfigDirs` | `agents/` | user+project |
| `core/tools/task/model-resolver.ts` | `readConfigFile` | `settings.json` | user |
| `core/tools/web-search/auth.ts` | `getConfigDirPaths` | `` (root for models.json, auth.json) | user |

## Subpath Summary

```
User-level (~/.omp/agent/, ~/.pi/agent/, ~/.claude/):
├── auth.json          ← sdk.ts, web-search/auth.ts
├── models.json        ← sdk.ts, web-search/auth.ts
├── settings.json      ← settings-manager.ts, task/model-resolver.ts
├── commands/          ← slash-commands.ts, custom-commands/loader.ts, task/commands.ts
├── hooks/             ← hooks/loader.ts
├── tools/             ← custom-tools/loader.ts
├── skills/            ← skills.ts
├── themes/            ← theme.ts (user-level only, no fallback)
├── sessions/          ← session-manager.ts (user-level only, no fallback)
├── agents/            ← task/discovery.ts
└── AGENTS.md          ← system-prompt.ts

User-level root (~/.omp/, ~/.pi/, ~/.claude/) - not under agent/:
├── mcp.json           ← mcp/config.ts
├── plugins/           ← plugins/paths.ts (primary only)
└── logs/              ← logger.ts (primary only)

Project-level (.omp/, .pi/, .claude/):
├── SYSTEM.md          ← main.ts
├── settings.json      ← settings-manager.ts
├── commands/          ← slash-commands.ts, custom-commands/loader.ts, task/commands.ts
├── hooks/             ← hooks/loader.ts
├── tools/             ← custom-tools/loader.ts
├── skills/            ← skills.ts
├── agents/            ← task/discovery.ts
├── plugin-overrides.json ← plugins/paths.ts
├── lsp.json           ← lsp/config.ts
└── .mcp.json          ← mcp/config.ts

Special paths (not under agent/):
├── ~/.omp/plugins/    ← plugins/paths.ts
└── ~/.omp/logs/       ← logger.ts
```

## Files Using Manual Paths (Intentionally)

These files construct paths manually because they only use the primary config dir:

| File | Current Approach | Reason |
|------|------------------|--------|
| `core/logger.ts` | `CONFIG_DIR_NAME` for logs dir | Logs only written to primary (~/.omp/logs/) |
| `core/plugins/paths.ts` | `CONFIG_DIR_NAME` for plugins dir | Plugins only installed in primary (~/.omp/plugins/) |
