import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type FifoCase,
	itRefusesFifo,
	mod,
	namedAsFifo,
	runChild,
	TEST_TIMEOUT_MS,
	useFifoSandbox,
	writerWaitingInOpen,
} from "./fifo-harness";

// Files a user, or another tool, places that omp reads on its own while it
// runs: LSP, lspmux, secrets and SSH config, other CLIs' credentials, Claude's
// transcripts, project manifests and changelogs a command reads by convention,
// shell rc files, token files and a `--clients` file. One case per reader; see
// `fifo-harness.ts` for how each case runs.
const box = useFifoSandbox("@omp-fifo-runtime-config-");

const literal = (value: string): string => JSON.stringify(value);

/** The project directory as the child's `process.cwd()` spells it, symbolic links resolved. */
const realProject = (): string => fs.realpathSync(box.projectDir);

/** Run git in `cwd` with no user or system configuration, so no hook, signing or template of this machine applies. */
function git(cwd: string, ...args: string[]): void {
	const run = Bun.spawnSync(
		["git", "-c", "user.name=omp", "-c", "user.email=omp@example.invalid", "-c", "commit.gpgsign=false", ...args],
		{
			cwd,
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

/** A repository at the project with one commit and `src/a.ts` staged on top of it. */
function repositoryWithStagedChange(): void {
	const project = box.projectDir;
	git(project, "init", "-q");
	fs.writeFileSync(path.join(project, "README.md"), "# project\n");
	git(project, "add", "README.md");
	git(project, "commit", "-q", "--no-verify", "-m", "init");
	fs.mkdirSync(path.join(project, "src"), { recursive: true });
	fs.writeFileSync(path.join(project, "src", "a.ts"), "export function answer(): number {\n\treturn 42;\n}\n");
	git(project, "add", "src/a.ts");
}

/** A repository whose index lists `files`, with `listed` then taken out of the working tree for the FIFO. */
function repositoryListing(files: Record<string, string>, listed: string): void {
	const project = box.projectDir;
	git(project, "init", "-q");
	for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(project, name), content);
	git(project, "add", ...Object.keys(files));
	fs.rmSync(path.join(project, listed));
}

const marketplacePluginDir = (): string => path.join(box.projectDir, "marketplace", "plugins", "demo");

const changelogPath = (): string => path.join(realProject(), "CHANGELOG.md");

const cases: FifoCase[] = [
	{
		// `lsp.*`/`dap.*` in every config root share this reader.
		name: "<project>/lsp.json",
		at: () => path.join(box.projectDir, "lsp.json"),
		script: () =>
			`import { loadConfig } from ${mod("coding-agent", "lsp/config.ts")};
			loadConfig(${literal(box.projectDir)});`,
		outcome: "skipped",
	},
	{
		name: "<marketplace>/marketplace.json, for a plugin's LSP servers",
		at: () => path.join(box.projectDir, "marketplace", "marketplace.json"),
		setup: () => fs.mkdirSync(marketplacePluginDir(), { recursive: true }),
		// Plugin roots come from this one `--plugin-dir`, not from the runner's own Claude plugins.
		env: () => ({ CLAUDE_CONFIG_DIR: "" }),
		script: () =>
			`import { injectPluginDirRoots } from ${mod("coding-agent", "discovery/helpers.ts")};
			import { loadConfig } from ${mod("coding-agent", "lsp/config.ts")};
			await injectPluginDirRoots(${literal(box.home)}, [${literal(marketplacePluginDir())}], ${literal(box.projectDir)});
			loadConfig(${literal(box.projectDir)});`,
		outcome: "skipped",
	},
	{
		name: "~/.config/lspmux/config.toml",
		at: () => path.join(box.home, ".config", "lspmux", "config.toml"),
		// lspmux is looked for on PATH before its config is read; this one reports no server.
		setup: () => {
			const bin = path.join(box.root, "bin");
			fs.mkdirSync(bin, { recursive: true });
			fs.writeFileSync(path.join(bin, "lspmux"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		},
		env: () => ({ PATH: `${path.join(box.root, "bin")}${path.delimiter}${process.env.PATH ?? ""}` }),
		script: () =>
			`import { detectLspmux } from ${mod("coding-agent", "lsp/lspmux.ts")};
			await detectLspmux();`,
		outcome: "skipped",
	},
	{
		// `<project>/.omp/secrets.yml` shares this reader.
		name: "~/.omp/agent/secrets.yml",
		at: () => path.join(box.agentDir, "secrets.yml"),
		script: () =>
			`import { loadSecrets } from ${mod("coding-agent", "secrets/index.ts")};
			await loadSecrets(${literal(box.projectDir)}, ${literal(box.agentDir)});`,
		outcome: "skipped",
	},
	{
		name: "~/.omp/agent/ssh.json",
		at: () => path.join(box.agentDir, "ssh.json"),
		script: () =>
			`import { readSSHConfigFile } from ${mod("coding-agent", "ssh/config-writer.ts")};
			import { getSSHConfigPath } from ${mod("utils", "dirs.ts")};
			try {
				await readSSHConfigFile(getSSHConfigPath("user"));
			} catch (error) {
				console.log(\`error \${String(error)}\`);
			}`,
		outcome: "reported",
	},
	{
		name: "~/.config/gh/hosts.yml",
		at: () => path.join(box.home, ".config", "gh", "hosts.yml"),
		env: () => ({ GH_CONFIG_DIR: path.join(box.home, ".config", "gh") }),
		script: () =>
			`import { resolveGithubCacheAuthKey } from ${mod("coding-agent", "tools/github-cache.ts")};
			resolveGithubCacheAuthKey("github.com");`,
		outcome: "skipped",
	},
	{
		// Read to decide whether a GitLab token in the environment may go to an MR URL's host.
		name: "~/.config/glab-cli/config.yml",
		at: () => path.join(box.home, ".config", "glab-cli", "config.yml"),
		env: () => ({
			GLAB_CONFIG_DIR: path.join(box.home, ".config", "glab-cli"),
			GITLAB_TOKEN: "fifo-test-token",
			GITLAB_HOST: "",
			GITLAB_URI: "",
			GL_HOST: "",
		}),
		script: () =>
			`import { getOrFetchMrDiff } from ${mod("coding-agent", "tools/glab-mr.ts")};
			import { ToolError } from ${mod("tui", "tools/tool-errors.ts")};
			try {
				await getOrFetchMrDiff({ cwd: ${literal(box.projectDir)}, project: "gitlab.fifo.invalid/group/project", iid: 1 });
			} catch (error) {
				// Refusing an untrusted host is this call's own answer, as with no config at all.
				if (!(error instanceof ToolError)) throw error;
			}`,
		outcome: "skipped",
	},
	{
		name: "~/.cmux/relay/<port>.auth",
		at: () => path.join(box.home, ".cmux", "relay", "47123.auth"),
		env: () => ({ CMUX_RELAY_ID: "", CMUX_RELAY_TOKEN: "" }),
		script: () =>
			`import { CmuxSocketClient } from ${mod("coding-agent", "tools/browser/cmux/socket-client.ts")};
			const client = new CmuxSocketClient({ socketPath: "127.0.0.1:47123" });
			try {
				await client.connect();
			} catch (error) {
				console.log(\`error \${String(error)}\`);
			} finally {
				client.close();
			}`,
		outcome: "reported",
	},
	{
		// The one reader of Claude's and Codex's JSONL files: transcripts, history, session index.
		name: "~/.claude/projects/<project>/<session>.jsonl",
		at: () => path.join(box.home, ".claude", "projects", "-project", "fifo-session.jsonl"),
		env: () => ({ CLAUDE_CONFIG_DIR: "" }),
		script: () =>
			`import { ClaudeSessionStore } from ${mod("coding-agent", "session/claude-session-store.ts")};
			const store = new ClaudeSessionStore(${literal(path.join(box.home, ".claude"))});
			try {
				await store.load({
					source: "claude",
					id: "fifo-session",
					path: ${literal(path.join(box.home, ".claude", "projects", "-project", "fifo-session.jsonl"))},
					cwd: ${literal(box.projectDir)},
					created: new Date(),
					modified: new Date(),
				});
			} catch (error) {
				console.log(\`error \${String(error)}\`);
			}`,
		outcome: "reported",
	},
	{
		// `package.json`, `pyproject.toml`, `go.mod` and the rest share this reader.
		name: "<project>/Cargo.toml",
		at: () => path.join(box.projectDir, "Cargo.toml"),
		script: () =>
			`import { detectRepositoryContext } from ${mod("coding-agent", "commit/conventional/repo-context.ts")};
			await detectRepositoryContext(${literal(box.projectDir)});`,
		outcome: "skipped",
	},
	{
		name: "<project>/CHANGELOG.md, when `omp commit` writes changelog entries",
		at: changelogPath,
		setup: repositoryWithStagedChange,
		script: () =>
			`import { runChangelogFlow } from ${mod("coding-agent", "commit/changelog/index.ts")};
			try {
				// Nothing reaches the model: the changelog is read before any completion.
				await runChangelogFlow({
					cwd: ${literal(realProject())},
					model: {},
					apiKey: "unused",
					stagedFiles: ["src/a.ts"],
					dryRun: true,
				});
			} catch (error) {
				console.log(\`error \${String(error)}\`);
			}`,
		outcome: "reported",
	},
	{
		name: "<project>/CHANGELOG.md, when the commit agent applies its entries",
		at: changelogPath,
		setup: repositoryWithStagedChange,
		script: () =>
			`import { applyChangelogProposals } from ${mod("coding-agent", "commit/changelog/index.ts")};
			try {
				await applyChangelogProposals({
					cwd: ${literal(realProject())},
					proposals: [{ path: ${literal(changelogPath())}, entries: { Fixed: ["fixed a thing"] } }],
					dryRun: true,
				});
			} catch (error) {
				console.log(\`error \${String(error)}\`);
			}`,
		outcome: "reported",
	},
	{
		name: "<project>/CHANGELOG.md, when the commit agent reads its existing entries",
		at: changelogPath,
		// `omp commit` reads these before its agent starts, and stops on the error.
		script: () =>
			`import { loadExistingChangelogEntries } from ${mod("coding-agent", "commit/agentic/index.ts")};
			try {
				await loadExistingChangelogEntries([${literal(changelogPath())}]);
			} catch (error) {
				console.log(\`error \${String(error)}\`);
			}`,
		outcome: "reported",
	},
	{
		name: "<project>/pyproject.toml, when cleanse looks for checkers",
		at: () => path.join(realProject(), "pyproject.toml"),
		setup: () => repositoryListing({ "pyproject.toml": "[tool.mypy]\n", "main.py": "print(1)\n" }, "pyproject.toml"),
		script: () =>
			`import { discoverCleanseDiagnosticSuite } from ${mod("coding-agent", "cleanse/checkers.ts")};
			await discoverCleanseDiagnosticSuite(${literal(box.projectDir)});`,
		outcome: "skipped",
	},
	{
		name: "<project>/package.json, when cleanse looks for test scripts",
		at: () => path.join(realProject(), "package.json"),
		setup: () =>
			repositoryListing(
				{ "package.json": '{"scripts":{"test":"bun test"}}\n', "index.ts": "export {};\n" },
				"package.json",
			),
		script: () =>
			`import { discoverCleanseDiagnosticSuite } from ${mod("coding-agent", "cleanse/checkers.ts")};
			await discoverCleanseDiagnosticSuite(${literal(box.projectDir)}, { includeTests: true });`,
		outcome: "skipped",
	},
	{
		// `<project>/CLAUDE.md` shares this reader.
		name: "<project>/AGENTS.md, when sharpshooter consolidates its memory",
		at: () => path.join(box.projectDir, "AGENTS.md"),
		// A queued delta makes consolidation due; a model registry with no key ends it after the docs are read.
		script: () =>
			`import { getBundledModel } from ${mod("catalog", "models.ts")};
			import { Settings } from ${mod("coding-agent", "config/settings.ts")};
			import { runSharpshooterConsolidation } from ${mod("coding-agent", "sharpshooter/consolidate.ts")};
			import { appendSharpshooterDelta } from ${mod("coding-agent", "sharpshooter/queue.ts")};
			const agentDir = ${literal(box.agentDir)};
			const cwd = ${literal(box.projectDir)};
			const sessionId = "01900000-0000-7000-8000-000000000001";
			await appendSharpshooterDelta(agentDir, cwd, {
				v: 1,
				kind: "architecture_decision",
				statement: "Keep boundaries explicit.",
				source: "explicit_user",
				evidence: "Keep boundaries explicit.",
				friction: { corrective: false, regression: false, subtle: true },
				sessionId,
				ts: Date.now(),
			});
			const model = getBundledModel("anthropic", "claude-haiku-4-5");
			const modelRegistry = {
				getAll: () => [model],
				getAvailable: () => [model],
				resolver: () => {
					throw new Error("no completion in this test");
				},
			};
			const result = await runSharpshooterConsolidation({
				agentDir,
				cwd,
				settings: Settings.isolated({ "sharpshooter.model": "anthropic/claude-haiku-4-5" }),
				modelRegistry,
				sessionId,
				force: true,
			});
			if (result.reason !== "error") throw new Error(\`consolidation did not reach the model: \${JSON.stringify(result)}\`);`,
		outcome: "skipped",
	},
	{
		name: "~/.omp/agent/smithery.json",
		at: () => path.join(box.agentDir, "smithery.json"),
		env: () => ({ SMITHERY_API_KEY: "" }),
		script: () =>
			`import { getSmitheryApiKey } from ${mod("coding-agent", "mcp/smithery-auth.ts")};
			await getSmitheryApiKey();`,
		outcome: "skipped",
	},
	{
		// `~/.bunfig.toml` and `$XDG_CONFIG_HOME/.bunfig.toml` share this reader.
		name: "~/.npmrc, when `omp update` resolves its registry",
		at: () => path.join(box.home, ".npmrc"),
		script: () =>
			`import { loadNpmRegistryResolver } from ${mod("coding-agent", "cli/npm-registry.ts")};
			try {
				await loadNpmRegistryResolver({ homeDir: ${literal(box.home)}, env: {} });
			} catch (error) {
				console.log(\`error \${String(error)}\`);
			}`,
		outcome: "reported",
	},
	{
		name: "~/.bashrc, when `--alias` installs a profile alias",
		at: () => path.join(box.home, ".bashrc"),
		script: () =>
			`import { installProfileAlias } from ${mod("coding-agent", "cli/profile-alias.ts")};
			try {
				await installProfileAlias({
					profile: "work",
					aliasName: "ompwork",
					shellPath: "/bin/bash",
					platform: "linux",
					homeDir: ${literal(box.home)},
					env: {},
				});
			} catch (error) {
				console.log(\`error \${String(error)}\`);
			}`,
		outcome: "reported",
	},
	{
		// The auth broker's token file shares this reader.
		name: "~/.omp/auth-gateway.token",
		at: () => path.join(box.home, ".omp", "auth-gateway.token"),
		script: () =>
			`import { runAuthGatewayCommand } from ${mod("coding-agent", "cli/auth-gateway-cli.ts")};
			try {
				await runAuthGatewayCommand({ action: "token", flags: {} });
			} catch (error) {
				console.log(\`error \${String(error)}\`);
			}`,
		outcome: "reported",
	},
	{
		name: "--clients <file>, when `omp auth-gateway serve` starts",
		at: () => path.join(box.projectDir, "clients.json"),
		env: () => ({ OMP_AUTH_BROKER_URL: "http://127.0.0.1:9", OMP_AUTH_BROKER_TOKEN: "fifo-test-broker-token" }),
		// The file is read before the broker is called, so nothing listens or connects.
		script: () =>
			`import { runAuthGatewayCommand } from ${mod("coding-agent", "cli/auth-gateway-cli.ts")};
			try {
				await runAuthGatewayCommand({
					action: "serve",
					flags: { bind: "127.0.0.1:0", clients: ${literal(path.join(box.projectDir, "clients.json"))} },
				});
			} catch (error) {
				console.log(\`error \${String(error)}\`);
			}`,
		outcome: "reported",
	},
	{
		// A serving gateway's poll: the file it cannot read revokes every client token and is logged.
		name: "--clients <file>, when a serving gateway re-reads it",
		at: () => path.join(box.projectDir, "clients.json"),
		script: () =>
			`import { createAuthGatewayClientsReloader } from ${mod("coding-agent", "cli/auth-gateway-cli.ts")};
			import { registerLogSink } from ${mod("utils", "logger.ts")};
			registerLogSink(event => {
				if (event.level === "error") console.log(\`error \${String(event.context?.error)}\`);
			});
			let revoked = false;
			const reload = createAuthGatewayClientsReloader(${literal(path.join(box.projectDir, "clients.json"))}, "[]", clients => {
				revoked = clients.length === 0;
			});
			await reload();
			if (!revoked) throw new Error("an unreadable clients file left the client tokens in place");`,
		outcome: "reported",
	},
	{
		name: "<repo>/.git/worktrees/<name>/HEAD, when `omp worktree list` names a worktree's branch",
		at: () => path.join(box.projectDir, ".git", "worktrees", "fifo", "HEAD"),
		setup: () => {
			const worktree = path.join(box.root, "wt", "fifo");
			fs.mkdirSync(worktree, { recursive: true });
			fs.writeFileSync(
				path.join(worktree, ".git"),
				`gitdir: ${path.join(box.projectDir, ".git", "worktrees", "fifo")}\n`,
			);
		},
		env: () => ({ OMP_WORKTREE_DIR: path.join(box.root, "wt") }),
		script: () =>
			`import { listWorktrees } from ${mod("coding-agent", "cli/worktree-cli.ts")};
			await listWorktrees({ json: true });`,
		outcome: "skipped",
	},
];

describe.skipIf(process.platform === "win32")("user-named files omp reads while it runs", () => {
	for (const c of cases) itRefusesFifo(box, c);

	// Claude's own config, read while listing Claude sessions to import, is an
	// optional index that was always passed over silently when unreadable, as
	// `custom-title.json` beside a transcript is; a FIFO there takes that route.
	it(
		"~/.claude.json, with a writer waiting in its open, is passed over silently",
		async () => {
			const at = path.join(box.home, ".claude.json");
			const writer = writerWaitingInOpen(box, at);
			try {
				const run = await runChild(
					box,
					`import { ClaudeSessionStore } from ${mod("coding-agent", "session/claude-session-store.ts")};
					await new ClaudeSessionStore(${literal(path.join(box.home, ".claude"))}).list();`,
					{ CLAUDE_CONFIG_DIR: "" },
				);

				expect(run.exit).toBe(0);
				expect(namedAsFifo(run.stdout + run.stderr, at)).toBe(0);
				expect(await writer.woken()).toBe(false);
			} finally {
				writer.stop();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
