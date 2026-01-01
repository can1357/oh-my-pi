# Contributing to oh-my-pi

## Development Setup

```bash
git clone https://github.com/can1357/oh-my-pi.git
cd oh-my-pi
bun install
bun run build
```

## Testing Local Changes

After building, test the CLI directly:

```bash
# Run the built CLI
bun dist/cli.js list
bun dist/cli.js install @oh-my-pi/exa
bun dist/cli.js doctor

# Or link it globally for testing
bun link
omp list
```

For plugin development, use `omp link` to symlink your local plugin:

```bash
omp link ./plugins/my-plugin
```

## Code Quality

```bash
bun run check    # Lint (Biome) + typecheck
bun run format   # Prettier (markdown) + Biome (TS)
```

## Project Structure

```
oh-my-pi/
├── src/
│   ├── cli.ts           # Commander.js entry point
│   ├── commands/        # Command implementations (one file per command)
│   ├── manifest.ts      # Plugin manifest types, config loading
│   ├── symlinks.ts      # Symlink creation/management
│   ├── loader.ts        # Generates tool/hook loaders in ~/.pi/agent/
│   ├── paths.ts         # All path constants
│   ├── npm.ts           # npm CLI wrapper
│   └── ...
├── plugins/             # Built-in plugins (each published separately)
│   ├── subagents/       # Task delegation system
│   ├── exa/             # Exa AI web search
│   ├── lsp/             # Language Server Protocol
│   └── ...
└── scripts/
    ├── bump-version.ts  # Version all packages together
    └── publish.ts       # Publish CLI + all plugins to npm
```

## Adding a New Command

1. Create `src/commands/mycommand.ts`:

```typescript
import { withErrorHandling } from '@omp/errors'

export const myCommand = withErrorHandling(async (options: { local?: boolean }) => {
   // Implementation
})
```

2. Wire it up in `src/cli.ts`:

```typescript
program.command('mycommand').description('Does something useful').option('-l, --local', 'Use project-level overrides').action(myCommand)
```

## Creating a Plugin

Plugins live in `plugins/` and are npm packages with an `omp` field in `package.json`.

### Plugin with Tools

```
plugins/my-plugin/
├── package.json
└── tools/
    ├── index.ts         # Exports CustomToolFactory
    └── runtime.json     # Feature state (injected at load time)
```

```json
{
   "name": "@oh-my-pi/my-plugin",
   "version": "1.0.0",
   "keywords": ["omp-plugin"],
   "omp": {
      "tools": "tools",
      "runtime": "tools/runtime.json",
      "variables": {
         "apiKey": { "type": "string", "env": "MY_API_KEY", "required": true }
      },
      "features": {
         "advanced": { "description": "Advanced features", "default": false }
      }
   },
   "files": ["tools"]
}
```

The tool factory (`tools/index.ts`) must export a `CustomToolFactory`:

```typescript
import type { CustomToolFactory } from '@mariozechner/pi-coding-agent'
import runtime from './runtime.json'

const factory: CustomToolFactory = api => {
   if (!runtime.features?.advanced) return []

   return [
      {
         name: 'my_tool',
         description: 'Does something',
         parameters: Type.Object({ input: Type.String() }),
         async execute({ input }) {
            return { output: `Processed: ${input}` }
         },
      },
   ]
}

export default factory
```

### Plugin with Symlinked Files

For agents, commands, and themes (non-code files):

```json
{
   "omp": {
      "install": [
         { "src": "agents/helper.md", "dest": "agent/agents/helper.md" },
         { "src": "commands/do-thing.md", "dest": "agent/commands/do-thing.md" }
      ]
   }
}
```

## Versioning and Publishing

All packages share the same version number. To release:

```bash
# Bump version in all package.json files
bun scripts/bump-version.ts 1.4.0

# Or bump and push in one go
bun scripts/bump-version.ts 1.4.0 --push

# Publish all packages to npm
bun scripts/publish.ts

# Dry run first
bun scripts/publish.ts --dry-run
```

## Commit Messages

```
<type>(scope): <past-tense description>
```

Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `chore`

Examples:

- `feat(install): added git URL support`
- `fix(symlinks): resolved detection on Windows`
- `docs(readme): updated plugin guide`

## Pull Requests

1. Fork and create a feature branch
2. Make changes, run `bun run check`
3. Commit with conventional commit messages
4. Open PR with description of changes

## Reporting Issues

Include:

- `omp --version`
- Bun version (`bun --version`)
- OS
- Steps to reproduce
- Full error output
