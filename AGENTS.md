# Development Rules

## First Message

If the user did not give you a concrete task in their first message,
read README.md, then ask which module(s) to work on. Based on the answer, read the relevant README.md files in parallel.

- packages/ai/README.md
- packages/tui/README.md
- packages/agent/README.md
- packages/coding-agent/README.md
- packages/mom/README.md
- packages/web-ui/README.md

## Code Quality

- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional

## Bun Over Node

This project uses Bun as its runtime. Always prefer Bun APIs over Node.js equivalents.

### Process Spawning

```typescript
// GOOD: Bun.spawn with ReadableStream API
import type { Subprocess } from "bun";

const child: Subprocess = Bun.spawn(["cmd", ...args], {
   stdin: "ignore",
   stdout: "pipe",
   stderr: "pipe",
});

const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
while (true) {
   const { done, value } = await reader.read();
   if (done) break;
   // process Buffer.from(value)
}
const exitCode = await child.exited;

// BAD: Node child_process
import { spawn } from "node:child_process";
const child = spawn("cmd", args);
child.stdout.on("data", (chunk) => { ... });
child.on("close", (code) => { ... });
```

### Sync Process Execution

```typescript
// GOOD: Bun.spawnSync
const result = Bun.spawnSync(["cmd", ...args], {
   stdin: "ignore",
   stdout: "pipe",
   stderr: "pipe",
});
if (result.exitCode === 0) { ... }

// BAD: Node execSync/spawnSync
import { spawnSync } from "node:child_process";
```

### File I/O

```typescript
// GOOD: Bun.file and Bun.write
const content = await Bun.file("path.txt").text();
const binary = await Bun.file("image.png").arrayBuffer();
const exists = await Bun.file("maybe.txt").exists();
await Bun.write("path.txt", content);

// BAD: Node fs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
```

### Scripts and package.json

```json
// GOOD: Use bun in scripts
{
   "scripts": {
      "start": "bun run src/index.ts",
      "test": "bun test",
      "check": "bunx tsc --noEmit"
   }
}

// BAD: Use node/npm/npx
{
   "scripts": {
      "start": "node dist/index.js",
      "test": "npm test",
      "check": "npx tsc --noEmit"
   }
}
```

### Running Commands

```bash
# GOOD
bun run script.ts
bun test
bunx tsc --noEmit
bun install

# BAD
node script.js
npm test
npx tsc --noEmit
npm install
```

### Type Imports for Bun APIs

```typescript
// Import Bun types when needed
import type { Subprocess } from "bun";

// Bun globals are available without import
Bun.spawn(...)
Bun.file(...)
Bun.write(...)
Bun.stdin.stream()
```

### Casting Bun Subprocess Streams

Bun's `Subprocess.stdout`/`stderr` types can be `number | ReadableStream | undefined`. Cast when using pipe mode:

```typescript
const child = Bun.spawn(["cmd"], { stdout: "pipe", stderr: "pipe" });
const stdoutReader = (child.stdout as ReadableStream<Uint8Array>).getReader();
const stderrReader = (child.stderr as ReadableStream<Uint8Array>).getReader();
```

### Binary Existence Checks

```typescript
// GOOD: Bun.which (cross-platform)
const gitPath = Bun.which("git");
if (!gitPath) throw new Error("git not found");

// BAD: Spawning which/where (platform-specific)
Bun.spawnSync(["which", "git"]);  // Unix only
Bun.spawnSync(["where", "git"]);  // Windows only
```

### Path Resolution

```typescript
// GOOD: import.meta (Bun ESM)
const thisDir = import.meta.dir;      // equivalent to __dirname
const thisFile = import.meta.path;    // equivalent to __filename

// BAD: fileURLToPath dance
import { fileURLToPath } from "url";
import { dirname } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

### Crypto

```typescript
// GOOD: Web Crypto (standard) or Bun.hash
const uuid = crypto.randomUUID();
const bytes = crypto.getRandomValues(new Uint8Array(32));
const hash = Bun.hash("sha256", data);

// BAD: Node crypto
import { randomBytes, randomUUID } from "node:crypto";
```

### Environment Variables

Bun auto-loads `.env` files. Do NOT import dotenv.

```typescript
// GOOD: Direct access
const apiKey = process.env.API_KEY;

// BAD: dotenv
import dotenv from "dotenv";
dotenv.config();
```

### HTTP Servers

```typescript
// GOOD: Bun.serve
const server = Bun.serve({
   port: 3000,
   fetch(req) {
      return new Response("OK");
   },
});
// later: server.stop();

// BAD: Node http
import http from "node:http";
const server = http.createServer((req, res) => { ... });
```

### HTTP Requests

```typescript
// GOOD: Native fetch (built into Bun)
const response = await fetch("https://api.example.com/data");
const json = await response.json();

// BAD: External packages
import fetch from "node-fetch";
import axios from "axios";
```

### Password Hashing

```typescript
// GOOD: Bun.password (bcrypt/argon2 built-in)
const hash = await Bun.password.hash("password", "bcrypt");
const valid = await Bun.password.verify("password", hash);

// BAD: External packages
import bcrypt from "bcrypt";
import argon2 from "argon2";
```

### Watch Mode

```bash
# GOOD: Bun built-in watch/hot reload
bun --watch src/index.ts    # Restart on changes
bun --hot src/index.ts      # Hot reload without restart

# BAD: External tools
npx nodemon src/index.ts
npx ts-node-dev src/index.ts
```

### SQLite

```typescript
// GOOD: Bun built-in SQLite
import { Database } from "bun:sqlite";
const db = new Database("mydb.sqlite");
db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)");

// BAD: External packages
import Database from "better-sqlite3";
```

### Testing

```bash
# GOOD: Bun built-in test runner
bun test

# BAD: External test runners
npx jest
npx vitest
npx mocha
```

See `docs/bun-migration-guide.md` for full migration reference.

## Commands

- After code changes: `bun run check` (get full output, no tail)
- For auto-fixable lint issues: `bun run fix` (includes unsafe fixes)
- NEVER run: `bun run dev`, `bun run build`, `bun test`
- Only run specific tests if user instructs: `bun test test/specific.test.ts`
- NEVER commit unless user asks
- Do NOT use `tsc` or `npx tsc` - always use `bun run check` which runs the correct type checker

## GitHub Issues

When reading issues:

- Always read all comments on the issue

When creating issues:

- Add `pkg:*` labels to indicate which package(s) the issue affects
  - Available labels: `pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:mom`, `pkg:tui`, `pkg:web-ui`
- If an issue spans multiple packages, add all relevant labels

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the commit message
- This automatically closes the issue when the commit is merged

## Tools

- GitHub CLI for issues/PRs
- Add package labels to issues/PRs: pkg:agent, pkg:ai, pkg:coding-agent, pkg:mom, pkg:tui, pkg:web-ui
- TUI interaction: use tmux

## Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be kind but direct (e.g., "Thanks @user" not "Thanks so much @user!")

## Changelog

Location: `packages/*/CHANGELOG.md` (each package has its own)

### Format

Use these sections under `## [Unreleased]`:

- `### Breaking Changes` - API changes requiring migration
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features

### Rules

- New entries ALWAYS go under `## [Unreleased]` section
- NEVER modify already-released version sections (e.g., `## [0.12.2]`)
- Each version section is immutable once released

### Attribution

- **Internal changes (from issues)**: `Fixed foo bar ([#123](https://github.com/badlogic/pi-mono/issues/123))`
- **External contributions**: `Added feature X ([#456](https://github.com/badlogic/pi-mono/pull/456) by [@username](https://github.com/username))`

## Releasing

1. **Update CHANGELOGs**: Ensure all changes since last release are documented in the `[Unreleased]` section of each affected package's CHANGELOG.md

2. **Run release script**:
   ```bash
   npm run release:patch    # Bug fixes
   npm run release:minor    # New features
   npm run release:major    # Breaking changes
   ```

The script handles: version bump, CHANGELOG finalization, commit, tag, publish, and adding new `[Unreleased]` sections.
