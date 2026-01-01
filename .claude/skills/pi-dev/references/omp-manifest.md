# oh-my-pi (OMP) Manifest Structure

Complete reference for the `omp` field in plugin package.json.

## Full Structure

```json
{
   "name": "@oh-my-pi/my-plugin",
   "version": "1.0.0",
   "description": "My custom plugin for pi",
   "keywords": ["omp-plugin"],
   "type": "module",
   "omp": {
      "tools": "tools",
      "hooks": "hooks",
      "runtime": "tools/runtime.json",
      "variables": {
         "apiKey": {
            "type": "string",
            "env": "MY_API_KEY",
            "description": "API key for authentication",
            "required": true
         }
      },
      "features": {
         "search": {
            "description": "Core search functionality",
            "default": true,
            "variables": {
               "maxResults": {
                  "type": "number",
                  "default": 10,
                  "description": "Maximum results to return"
               }
            }
         },
         "advanced": {
            "description": "Advanced features",
            "default": false
         }
      },
      "install": [
         { "src": "agents/my-agent.md", "dest": "agent/agents/my-agent.md" },
         { "src": "themes/my-theme.json", "dest": "agent/themes/my-theme.json" },
         { "src": "commands/my-cmd.md", "dest": "agent/commands/my-cmd.md" }
      ]
   },
   "files": ["tools", "agents", "themes", "commands"],
   "dependencies": {
      "cli-highlight": "^2.1.11"
   }
}
```

## OMP Field Types

```typescript
interface OmpField {
   /** Path to tools factory (e.g., "tools" → "<pkg>/tools") */
   tools?: string
   /** Path to hooks factory (e.g., "hooks" → "<pkg>/hooks") */
   hooks?: string
   /** Path to runtime config JSON (e.g., "tools/runtime.json") */
   runtime?: string
   /** Top-level runtime variables (always available) */
   variables?: Record<string, OmpVariable>
   /** Named features with metadata and per-feature variables */
   features?: Record<string, OmpFeature>
   /** Files to symlink into ~/.pi/agent/ */
   install?: OmpInstallEntry[]
}

interface OmpVariable {
   type: 'string' | 'number' | 'boolean' | 'string[]'
   default?: string | number | boolean | string[]
   description?: string
   required?: boolean
   /** Environment variable name (e.g., "EXA_API_KEY") */
   env?: string
}

interface OmpFeature {
   description?: string
   /** Runtime variables specific to this feature */
   variables?: Record<string, OmpVariable>
   /** Default enabled state (default: true) */
   default?: boolean
}

interface OmpInstallEntry {
   src: string
   dest: string
   /** If true, file is copied (not symlinked) and editable */
   copy?: boolean
}
```

## runtime.json Structure

```typescript
interface PluginRuntimeConfig {
   features?: string[]
   options?: Record<string, unknown>
}
```

Example:

```json
{
   "features": ["search", "advanced"],
   "options": {
      "maxOutputLines": 5000,
      "maxConcurrency": 16
   }
}
```

## Feature-Based Tool Loading

```typescript
import runtime from './runtime.json'

const FEATURE_LOADERS: Record<string, () => Promise<{ default: CustomToolFactory }>> = {
   search: () => import('./search'),
   advanced: () => import('./advanced'),
}

const factory: CustomToolFactory = async toolApi => {
   const tools: CustomAgentTool[] = []
   const enabledFeatures = runtime.features ?? []

   for (const feature of enabledFeatures) {
      const loader = FEATURE_LOADERS[feature]
      if (!loader) continue

      const module = await loader()
      const result = await module.default(toolApi)
      if (result) {
         tools.push(...(Array.isArray(result) ? result : [result]))
      }
   }

   return tools.length > 0 ? tools : null
}

export default factory
```

## Storage Hierarchy

```
~/.pi/plugins/
├── node_modules/           # npm packages (supports dependencies!)
│   └── @oh-my-pi/my-plugin/
│       ├── package.json    # omp manifest
│       └── tools/
│           ├── index.ts    # Tool factory
│           └── runtime.json # Default config
├── package.json            # dependencies + omp config
└── store/                  # Persistent config (survives npm update)
    └── @oh-my-pi__my-plugin.json

.pi/                        # Project-level overrides
├── overrides.json          # Disabled plugins list
└── store/
    └── @oh-my-pi__my-plugin.json  # Project-level config
```

## Config Precedence

1. Default values from `runtime.json` (lowest)
2. Global store `~/.pi/plugins/store/<plugin>.json`
3. Project store `.pi/store/<plugin>.json` (highest)

Runtime configs are merged via `Object.assign` at load time.

## Key Difference: Dependencies

**Regular pi extensions** cannot have npm dependencies—they must be self-contained.

**omp plugins** support full npm dependencies:

```json
{
   "dependencies": {
      "cli-highlight": "^2.1.11",
      "vscode-languageserver-protocol": "^3.17.5"
   }
}
```

The omp loader patches Node's module resolution to include `~/.pi/plugins/node_modules`.

## Plugin Examples

### Tools-Only Plugin

```json
{
   "name": "@oh-my-pi/simple-tool",
   "omp": {
      "tools": "tools"
   },
   "files": ["tools"]
}
```

### Install-Only Plugin (Theme)

```json
{
   "name": "@oh-my-pi/my-theme",
   "omp": {
      "install": [{ "src": "themes/dark.json", "dest": "agent/themes/dark.json" }]
   },
   "files": ["themes"]
}
```

### Mixed Plugin (Tools + Agents + Hooks)

```json
{
   "name": "@oh-my-pi/full-plugin",
   "omp": {
      "tools": "tools",
      "hooks": "hooks",
      "runtime": "tools/runtime.json",
      "install": [
         { "src": "agents/helper.md", "dest": "agent/agents/helper.md" },
         { "src": "commands/run.md", "dest": "agent/commands/run.md" }
      ]
   },
   "files": ["tools", "hooks", "agents", "commands"]
}
```

### Hooks-Only Plugin (Using hooks field)

```json
{
   "name": "@oh-my-pi/permission-gate",
   "omp": {
      "hooks": "hooks"
   },
   "files": ["hooks"]
}
```

**Important**: The `hooks` field loads hook factories via the omp loader (like tools). Do NOT use `install` for hooks — that only works for static files (agents, commands, themes).

### Plugin with Required API Key

```json
{
   "name": "@oh-my-pi/api-plugin",
   "omp": {
      "tools": "tools",
      "variables": {
         "apiKey": {
            "type": "string",
            "env": "MY_SERVICE_API_KEY",
            "description": "API key from my-service.com",
            "required": true
         }
      }
   }
}
```

In tool code:

```typescript
const factory: CustomToolFactory = async _pi => {
   const apiKey = process.env.MY_SERVICE_API_KEY
   if (!apiKey) return null // Tool unavailable

   return {
      name: 'my_service',
      // ...
   }
}
```

## CLI Commands

```bash
# Install plugins
omp install @oh-my-pi/my-plugin

# Reinstall (updates dependencies)
omp reinstall @oh-my-pi/my-plugin

# List installed plugins
omp list

# Enable/disable features
omp features @oh-my-pi/my-plugin          # Interactive
omp enable @oh-my-pi/my-plugin search     # Enable feature
omp disable @oh-my-pi/my-plugin advanced  # Disable feature

# Set variables
omp config @oh-my-pi/my-plugin apiKey "sk-..."

# View plugin config
omp config @oh-my-pi/my-plugin

# Project-local overrides (add -l flag)
omp features @oh-my-pi/my-plugin -l
omp config @oh-my-pi/my-plugin -l

# Link local plugin for development
omp link ./path/to/plugin

# Generate env exports
omp env
```

## Loader Architecture

`omp install` generates two loaders:

- `~/.pi/agent/tools/omp/index.ts` — tool loader
- `~/.pi/agent/hooks/omp/index.ts` — hook loader

**Common bootstrap:**

1. Patches `Module._nodeModulePaths` to include `~/.pi/plugins/node_modules`
2. For each plugin with `omp.runtime`, imports and patches with store data

**Tool loader:**

1. Imports each `omp.tools` factory, calls with `ToolAPI`
2. Factories return tools; aggregates into single array for pi

**Hook loader:**

1. Preloads each `omp.hooks` factory at module load (top-level await)
2. Exports a factory that invokes all hook factories synchronously with `HookAPI`
