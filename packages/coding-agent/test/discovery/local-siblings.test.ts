import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defineCapability, registerProvider } from "@oh-my-pi/pi-coding-agent/capability";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { type ContextFile, contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { loadAgentsMd } from "@oh-my-pi/pi-coding-agent/discovery/agents-md";
import { loadProjectContextFiles } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

function write(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

describe("standalone .local.md sibling discovery", () => {
	let tempDir!: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-siblings-"));
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("emits AGENTS.local.md attached to its base at every walked depth", async () => {
		const repoRoot = path.join(tempDir, "repo");
		const pkgDir = path.join(repoRoot, "pkg");
		const cwd = path.join(pkgDir, "src");
		fs.mkdirSync(cwd, { recursive: true });

		const pkgBase = path.join(pkgDir, "AGENTS.md");
		const pkgLocal = path.join(pkgDir, "AGENTS.local.md");
		const repoBase = path.join(repoRoot, "AGENTS.md");
		const repoLocal = path.join(repoRoot, "AGENTS.local.md");
		write(pkgBase, "pkg context");
		write(pkgLocal, "pkg local context");
		write(repoBase, "repo context");
		write(repoLocal, "repo local context");

		const result = await loadAgentsMd({ cwd, home: tempDir, repoRoot });

		expect(result.items.map(file => file.path)).toEqual([pkgBase, pkgLocal, repoBase, repoLocal]);
		const [pkgSibling, repoSibling] = [result.items[1], result.items[3]];
		expect(pkgSibling.localSiblingOf).toBe(pkgBase);
		expect(pkgSibling.depth).toBe(result.items[0].depth);
		expect(repoSibling.localSiblingOf).toBe(repoBase);
		expect(repoSibling.depth).toBe(result.items[2].depth);
	});

	test("never discovers a local sibling without its base file", async () => {
		const repoRoot = path.join(tempDir, "repo");
		const cwd = path.join(repoRoot, "src");
		fs.mkdirSync(cwd, { recursive: true });
		write(path.join(repoRoot, "AGENTS.local.md"), "orphan local context");

		const result = await loadAgentsMd({ cwd, home: tempDir, repoRoot });

		expect(result.items).toEqual([]);
	});

	test("ignores an empty local sibling", async () => {
		const repoRoot = path.join(tempDir, "repo");
		const cwd = path.join(repoRoot, "src");
		fs.mkdirSync(cwd, { recursive: true });
		const base = path.join(repoRoot, "AGENTS.md");
		write(base, "repo context");
		write(path.join(repoRoot, "AGENTS.local.md"), "");

		const result = await loadAgentsMd({ cwd, home: tempDir, repoRoot });

		expect(result.items.map(file => file.path)).toEqual([base]);
	});
});

describe("local sibling shadowing semantics", () => {
	let tempDir!: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-sibling-dedup-"));
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("local sibling rides its base when the base wins the depth tie", async () => {
		const repoRoot = path.join(tempDir, "repo");
		const cwd = path.join(repoRoot, "src");
		fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		const agentsBase = path.join(repoRoot, "AGENTS.md");
		const agentsLocal = path.join(repoRoot, "AGENTS.local.md");
		write(agentsBase, "agents context");
		write(agentsLocal, "agents local context");
		write(path.join(repoRoot, "CLAUDE.md"), "claude context");
		write(path.join(repoRoot, "CLAUDE.local.md"), "claude local context");

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd });

		const atRepoRoot = result.items.filter(file => file.level === "project" && file.depth === 1);
		expect(atRepoRoot.map(file => file.path)).toEqual([agentsBase, agentsLocal]);
		expect(atRepoRoot[1].localSiblingOf).toBe(agentsBase);

		// CLAUDE.md lost the depth tie to AGENTS.md, so its local sibling is
		// shadowed too instead of sneaking in through the side door.
		const claudeLocal = result.all.find(file => file.path === path.join(repoRoot, "CLAUDE.local.md"));
		expect(claudeLocal?._shadowed).toBe(true);
	});

	test("a local sibling does not consume its depth scope", async () => {
		const repoRoot = path.join(tempDir, "repo");
		const cwd = path.join(repoRoot, "pkg");
		fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		write(path.join(repoRoot, "AGENTS.md"), "repo context");
		write(path.join(repoRoot, "AGENTS.local.md"), "repo local context");
		write(path.join(cwd, "AGENTS.md"), "pkg context");
		write(path.join(cwd, "AGENTS.local.md"), "pkg local context");

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd });

		expect(result.items.filter(file => file.level === "project" && file.depth === 1).map(file => file.path)).toEqual([
			path.join(repoRoot, "AGENTS.md"),
			path.join(repoRoot, "AGENTS.local.md"),
		]);
		expect(result.items.filter(file => file.level === "project" && file.depth === 0).map(file => file.path)).toEqual([
			path.join(cwd, "AGENTS.md"),
			path.join(cwd, "AGENTS.local.md"),
		]);
	});

	test("disabling the base extension drops its local sibling too", async () => {
		const repoRoot = path.join(tempDir, "repo");
		const cwd = path.join(repoRoot, "src");
		fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		write(path.join(repoRoot, "AGENTS.md"), "agents context");
		write(path.join(repoRoot, "AGENTS.local.md"), "agents local context");

		const result = await loadCapability<ContextFile>(contextFileCapability.id, {
			cwd,
			disabledExtensions: ["context-file:project:AGENTS.md"],
		});

		expect(result.items.filter(file => file.level === "project" && file.depth === 1)).toEqual([]);
		const local = result.all.find(file => file.path === path.join(repoRoot, "AGENTS.local.md"));
		expect(local?._shadowed).toBe(true);
	});

	test("a local sibling can be opted out alone without dropping its base", async () => {
		const repoRoot = path.join(tempDir, "repo");
		const cwd = path.join(repoRoot, "src");
		fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		const base = path.join(repoRoot, "AGENTS.md");
		write(base, "agents context");
		write(path.join(repoRoot, "AGENTS.local.md"), "agents local context");

		const result = await loadCapability<ContextFile>(contextFileCapability.id, {
			cwd,
			disabledExtensions: ["context-file:project:AGENTS.local.md"],
		});

		const atRepoRoot = result.items.filter(file => file.level === "project" && file.depth === 1);
		expect(atRepoRoot.map(file => file.path)).toEqual([base]);
	});

	test(".claude/CLAUDE.local.md rides .claude/CLAUDE.md in the cwd config directory", async () => {
		const repoRoot = path.join(tempDir, "repo");
		const cwd = repoRoot;
		fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
		const base = path.join(cwd, ".claude", "CLAUDE.md");
		const local = path.join(cwd, ".claude", "CLAUDE.local.md");
		write(base, "claude context");
		write(local, "claude local context");

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd });

		const claudeFiles = result.items.filter(file => file._source.provider === "claude" && file.level === "project");
		expect(claudeFiles.map(file => file.path)).toEqual([base, local]);
		expect(claudeFiles[1].localSiblingOf).toBe(base);
	});

	test(".omp/AGENTS.local.md rides .omp/AGENTS.md from the nearest non-empty .omp directory", async () => {
		const repoRoot = path.join(tempDir, "repo");
		const cwd = path.join(repoRoot, "src");
		fs.mkdirSync(path.join(repoRoot, ".omp"), { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		const base = path.join(repoRoot, ".omp", "AGENTS.md");
		const local = path.join(repoRoot, ".omp", "AGENTS.local.md");
		write(base, "native context");
		write(local, "native local context");

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd });

		const nativeFiles = result.items.filter(file => file._source.provider === "native" && file.level === "project");
		expect(nativeFiles.map(file => file.path)).toEqual([base, local]);
		expect(nativeFiles[1].localSiblingOf).toBe(base);
	});

	test(".omp/AGENTS.local.md without .omp/AGENTS.md contributes nothing", async () => {
		const repoRoot = path.join(tempDir, "repo");
		const cwd = path.join(repoRoot, "src");
		fs.mkdirSync(path.join(repoRoot, ".omp"), { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		write(path.join(repoRoot, ".omp", "AGENTS.local.md"), "orphan native local context");

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd });

		expect(result.items.filter(file => file._source.provider === "native")).toEqual([]);
	});

	test("user-level ~/.claude/CLAUDE.local.md rides the user CLAUDE.md", async () => {
		const claudeDir = path.join(tempDir, "claude-home");
		const base = path.join(claudeDir, "CLAUDE.md");
		const local = path.join(claudeDir, "CLAUDE.local.md");
		write(base, "user context");
		write(local, "user local context");

		const previous = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = claudeDir;
		Bun.env.CLAUDE_CONFIG_DIR = claudeDir;
		try {
			const result = await loadCapability<ContextFile>(contextFileCapability.id, {
				cwd: path.join(tempDir, "workdir"),
				providers: ["claude"],
			});
			const userFiles = result.items.filter(file => file.level === "user");
			expect(userFiles.map(file => file.path)).toEqual([base, local]);
			expect(userFiles[1].localSiblingOf).toBe(base);
		} finally {
			delete Bun.env.CLAUDE_CONFIG_DIR;
			if (previous === undefined) {
				delete process.env.CLAUDE_CONFIG_DIR;
			} else {
				process.env.CLAUDE_CONFIG_DIR = previous;
				Bun.env.CLAUDE_CONFIG_DIR = previous;
			}
		}
	});

	test("user-level ~/.omp/agent/AGENTS.local.md rides the native user AGENTS.md", async () => {
		const agentDir = path.join(tempDir, "native-agent");
		const base = path.join(agentDir, "AGENTS.md");
		const local = path.join(agentDir, "AGENTS.local.md");
		write(base, "native user context");
		write(local, "native user local context");

		const originalAgentDir = getAgentDir();
		setAgentDir(agentDir);
		try {
			const result = await loadCapability<ContextFile>(contextFileCapability.id, {
				cwd: path.join(tempDir, "workdir"),
				providers: ["native"],
			});
			const userFiles = result.items.filter(file => file.level === "user");
			expect(userFiles.map(file => file.path)).toEqual([base, local]);
			expect(userFiles[1].localSiblingOf).toBe(base);
		} finally {
			setAgentDir(originalAgentDir);
		}
	});
});

describe("attachment invariant", () => {
	interface Widget {
		path: string;
		ok: boolean;
		attachedTo?: string;
		_source: SourceMeta;
	}

	const widgetCapability = defineCapability<Widget>({
		id: "test-attachment-widgets",
		displayName: "Test Widgets",
		description: "Synthetic capability for attachment-pipeline tests",
		key: widget => widget.path,
		attachmentId: widget => widget.path,
		attachTo: widget => widget.attachedTo,
		validate: widget => (widget.ok ? undefined : "invalid widget"),
	});

	function widget(path: string, ok: boolean, attachedTo?: string): Widget {
		return {
			path,
			ok,
			attachedTo,
			_source: { provider: "test-widgets", providerName: "Test Widgets", path, level: "project" },
		};
	}

	// Note: registerProvider mutates the module-global provider registry and is
	// never unregistered (no unregister API). Residue is inert: no other test
	// loads the "test-attachment-widgets" capability id, so it can never reach
	// a load surface; it may merely appear in provider-catalog introspection.
	registerProvider(widgetCapability.id, {
		id: "test-widgets",
		displayName: "Test Widgets",
		description: "Synthetic provider for attachment-pipeline tests",
		priority: 10,
		load: async () => ({
			items: [
				widget("/fixture/valid-base", true),
				widget("/fixture/valid-child", true, "/fixture/valid-base"),
				widget("/fixture/invalid-base", false),
				widget("/fixture/orphan-child", true, "/fixture/invalid-base"),
			],
			warnings: [],
		}),
	});

	test("an attachment never outlives a base rejected by validation", async () => {
		const result = await loadCapability<Widget>(widgetCapability.id, { cwd: os.tmpdir() });

		expect(result.items.map(widget => widget.path)).toEqual(["/fixture/valid-base", "/fixture/valid-child"]);
		const orphan = result.all.find(candidate => candidate.path === "/fixture/orphan-child");
		expect(orphan?._shadowed).toBe(true);
	});

	test("a suppressed attachment never survives even when its base did", async () => {
		const result = await loadCapability<Widget>(widgetCapability.id, {
			cwd: os.tmpdir(),
			suppress: candidate => candidate.path === "/fixture/valid-child",
		});

		expect(result.items.map(widget => widget.path)).toEqual(["/fixture/valid-base"]);
	});
});

describe("local sibling injection", () => {
	let tempDir!: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-sibling-inject-"));
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("local sibling is injected directly after its base with @ imports expanded", async () => {
		const repoRoot = path.join(tempDir, "repo");
		const cwd = path.join(repoRoot, "src");
		fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		write(path.join(repoRoot, "AGENTS.md"), "repo context");
		write(path.join(repoRoot, "AGENTS.local.md"), "machine aliases live in @aliases.md");
		write(path.join(repoRoot, "aliases.md"), "alias: ll = git log");

		const files = await loadProjectContextFiles({ cwd });
		const repoFiles = files.filter(file => file.depth === 1);
		expect(repoFiles.map(file => file.path)).toEqual([
			path.join(repoRoot, "AGENTS.md"),
			path.join(repoRoot, "AGENTS.local.md"),
		]);
		expect(repoFiles[1].content).toBe("machine aliases live in alias: ll = git log");
	});
});
