import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { canonicalSnapshotKey } from "@oh-my-pi/pi-coding-agent/edit/file-snapshot-store";
import type { RenderResultOptions } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-coding-agent/modes/components/agent-transcript-viewer";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import type {
	ObservableSession,
	SessionObserverRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { Text } from "@oh-my-pi/pi-tui";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { grepToolRenderer } from "../../src/tools/grep";

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "astGrep.enabled": true, "astEdit.enabled": true, "tools.xdev": false }),
		...overrides,
	};
}

const plainTheme = {
	fg: (_color: unknown, text: string) => text,
	styledSymbol: () => "…",
	sep: { dot: " • " },
	format: { bracketLeft: "[", bracketRight: "]" },
} as unknown as Theme;

const renderOptions: RenderResultOptions = {
	expanded: false,
	isPartial: true,
};

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

async function createSearchFixture(rootDir: string): Promise<void> {
	const targets = ["apps", "packages", "phases"] as const;
	for (const target of targets) {
		await fs.mkdir(path.join(rootDir, target), { recursive: true });
	}
	await fs.mkdir(path.join(rootDir, "other"), { recursive: true });
	await fs.mkdir(path.join(rootDir, "folder with spaces"), { recursive: true });

	await Bun.write(path.join(rootDir, "apps", "grep.txt"), "shared-needle apps\n");
	await Bun.write(path.join(rootDir, "packages", "grep.txt"), "shared-needle packages\n");
	await Bun.write(path.join(rootDir, "phases", "grep.txt"), "shared-needle phases\n");
	await Bun.write(path.join(rootDir, "other", "grep.txt"), "shared-needle other\n");
	await Bun.write(path.join(rootDir, "folder with spaces", "note.txt"), "space-needle\n");

	await Bun.write(
		path.join(rootDir, "apps", "ast.ts"),
		"const providerOptions = {};\nlegacyWrap(appsValue, appsArg);\n",
	);
	await Bun.write(
		path.join(rootDir, "packages", "ast.ts"),
		"const providerOptions = {};\nlegacyWrap(packagesValue, packagesArg);\n",
	);
	await Bun.write(
		path.join(rootDir, "phases", "ast.ts"),
		"const providerOptions = {};\nlegacyWrap(phasesValue, phasesArg);\n",
	);
	await Bun.write(
		path.join(rootDir, "other", "ast.ts"),
		"const providerOptions = {};\nlegacyWrap(otherValue, otherArg);\n",
	);
}
async function makeJsonlSessionFile(dirPath: string, entries: object[]): Promise<string> {
	const filePath = path.join(dirPath, "session.jsonl");
	await Bun.write(filePath, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	return filePath;
}

function makeSubagentRegistry(sessions: ObservableSession[]): SessionObserverRegistry {
	return {
		getSessions: () => sessions,
		getSession: (id: string) => sessions.find(session => session.id === id),
		onChange: () => () => {},
		setMainSession: () => {},
		getActiveSubagentCount: () => sessions.filter(session => session.status === "active").length,
	} as unknown as SessionObserverRegistry;
}

let treeEntryCounter = 0;
function makeMessageNode(message: AgentMessage, parentId: string | null = null): SessionTreeNode {
	const entry: SessionEntry = {
		type: "message",
		id: `entry-${treeEntryCounter++}`,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
	return { entry, children: [] };
}

function renderTree(tree: SessionTreeNode[], currentLeafId: string): string {
	const selector = new TreeSelectorComponent(
		tree,
		currentLeafId,
		60,
		() => {},
		() => {},
	);
	return Bun.stripANSI(selector.render(120).join("\n"));
}

describe("tool path arrays", () => {
	let tempDir: string;

	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "search-path-lists-"));
		await createSearchFixture(tempDir);
	});

	beforeEach(() => {
		treeEntryCounter = 0;
	});

	afterAll(async () => {
		await removeWithRetries(tempDir);
		resetSettingsForTest();
	});

	it("search accepts a semicolon-delimited path list", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("search-path-array", {
			pattern: "shared-needle",
			path: "apps/; packages/; phases/",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toMatch(/^# apps\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# packages\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# phases\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).toContain("shared-needle");
		expect(text).not.toContain("# other");
		expect(details?.fileCount).toBe(3);
		expect(details?.scopePath).toBe("apps/, packages/, phases/");
	});

	it("search accepts JSON-array string paths in direct execute", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("search-json-array-string-paths", {
			pattern: "shared-needle",
			path: JSON.stringify(["apps/", "packages/", "phases/"]),
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toMatch(/^# apps\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# packages\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# phases\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).not.toContain("# other");
		expect(details?.fileCount).toBe(3);
		expect(details?.scopePath).toBe("apps/, packages/, phases/");
	});

	it("search expands delimited path entries", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		if (!tool) throw new Error("Missing grep tool");

		for (const [name, entry] of [
			["comma", "apps/grep.txt, packages/grep.txt"],
			["semicolon", "apps/grep.txt;packages/grep.txt"],
			["space", "apps/grep.txt packages/grep.txt"],
		] as const) {
			const result = await tool.execute(`search-delimited-${name}`, {
				pattern: "shared-needle",
				path: entry,
			});
			const text = getText(result);
			const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

			expect(text).toMatch(/^# apps\/\n## grep\.txt#[0-9A-F]{4}/m);
			expect(text).toMatch(/^# packages\/\n## grep\.txt#[0-9A-F]{4}/m);
			expect(text).not.toContain("phases");
			expect(text).not.toContain("other");
			expect(details?.fileCount).toBe(2);
			expect(details?.scopePath).toBe("apps/grep.txt, packages/grep.txt");
		}
	});

	it("search keeps comma-delimited surviving entries when peers are missing", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("search-delimited-missing", {
			pattern: "shared-needle",
			path: "missing.txt, packages/grep.txt",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; missingPaths?: string[] } | undefined;

		expect(text).toMatch(/^\[packages\/grep\.txt#[0-9A-F]{4}\]/m);
		expect(text).toContain("Skipped missing paths: missing.txt");
		expect(text).not.toContain("apps");
		expect(details?.fileCount).toBe(1);
		expect(details?.missingPaths).toEqual(["missing.txt"]);
	});

	it("records hashline snapshots for matched files", async () => {
		const session = createTestSession(tempDir);
		const tools = await createTools(session);
		const tool = tools.find(entry => entry.name === "grep");
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("search-records-snapshot", {
			pattern: "shared-needle",
			path: "apps/",
		});
		const text = getText(result);
		const tag = /^# apps\/\n## grep\.txt#([0-9A-F]{4})/m.exec(text)?.[1];
		if (!tag) throw new Error("Missing search snapshot tag");

		const snapshot = session.fileSnapshotStore?.byHash(
			canonicalSnapshotKey(path.join(tempDir, "apps", "grep.txt")),
			tag,
		);
		expect(snapshot?.text).toBe("shared-needle apps\n");
	});

	it("search accepts a single string path through tool validation", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		if (!tool) throw new Error("Missing grep tool");

		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "search-single-string-path",
			name: tool.name,
			arguments: {
				pattern: "space-needle",
				path: "folder with spaces/",
			},
		});
		const result = await tool.execute("search-single-string-path", args);
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("note.txt");
		expect(details?.fileCount).toBe(1);
		expect(details?.scopePath).toBe("folder with spaces");
	});
	it("search resolves bracketed literal paths (Next.js routes) when they exist", async () => {
		// Create `apps/[id]/page.tsx` — `[id]` is glob char-class syntax but here it
		// is a literal directory name. The literal path must take precedence over
		// the glob interpretation, otherwise the lookup returns no matches.
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "search-path-lists-"));
		await fs.mkdir(path.join(tmp, "apps", "[id]"), { recursive: true });
		await Bun.write(path.join(tmp, "apps", "[id]", "page.tsx"), "bracket-needle\n");

		const tools = await createTools(createTestSession(tmp));
		const tool = tools.find(entry => entry.name === "grep");
		if (!tool) throw new Error("Missing grep tool");

		const single = await tool.execute("search-bracket-literal-single", {
			pattern: "bracket-needle",
			path: "apps/[id]/page.tsx",
		});
		expect(getText(single)).toContain("bracket-needle");

		const dir = await tool.execute("search-bracket-literal-dir", {
			pattern: "bracket-needle",
			path: "apps/[id]",
		});
		expect(getText(dir)).toContain("bracket-needle");
		await removeWithRetries(tmp);
	});

	it("grep pending renderer accepts a single string path", () => {
		const component = grepToolRenderer.renderCall(
			{ pattern: "space-needle", paths: "folder with spaces/" },
			renderOptions,
			plainTheme,
		);

		expect((component as Text).getText()).toContain("in folder with spaces/");
	});
	it("agent hub chat renders a single-string grep path summary", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "search-path-lists-"));
		const sessionFile = await makeJsonlSessionFile(tmp, [
			{ type: "session", version: 3, id: "search-overlay-session", timestamp: new Date().toISOString() },
			{
				type: "message",
				id: "msg-user-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "grep", timestamp: 1 },
			},
			{
				type: "message",
				id: "msg-assistant-1",
				parentId: "msg-user-1",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "search-call-1",
							name: "grep",
							arguments: { pattern: "space-needle", paths: "folder with spaces/" },
						},
					],
					api: "test",
					provider: "test",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: 2,
				},
			},
		]);
		const observers = makeSubagentRegistry([
			{
				id: "search-overlay-session",
				kind: "subagent",
				label: "Search Overlay",
				status: "active",
				sessionFile,
				lastUpdate: Date.now(),
			},
		]);
		const agents = new AgentRegistry();
		agents.register({
			id: "search-overlay-session",
			displayName: "search-overlay-session",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile,
			status: "parked",
		});

		const viewer = new AgentTranscriptViewer({
			agentId: "search-overlay-session",
			registry: agents,
			observers,
			ui: { requestRender: () => {}, requestComponentRender: () => {} } as never,
			cwd: tmp,
			expandKeys: ["ctrl+o"],
			hubKeys: ["ctrl+s"],
			requestRender: () => {},
			onClose: () => {},
			onHubClose: () => {},
		});
		const rendered = Bun.stripANSI(viewer.render(120).join("\n"));
		viewer.dispose();

		// The hub chat now renders through grepToolRenderer.renderCall; the
		// single-string `paths` arg shows up as the "in <paths>" scope meta on the
		// pending call line (a completed result merges the call line away).
		expect(rendered).toContain("in folder with spaces/");
		await removeWithRetries(tmp);
	});

	it("tree selector renders a single-string grep path summary", () => {
		const root = makeMessageNode({ role: "user", content: "grep", timestamp: 1 });
		const assistant = makeMessageNode(
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "search-call-1",
						name: "grep",
						arguments: { pattern: "space-needle", paths: "folder with spaces/" },
					},
				],
				api: "test",
				provider: "test",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 2,
				stopReason: "stop",
			} as AgentMessage,
			root.entry.id,
		);
		const toolResult = makeMessageNode(
			{
				role: "toolResult",
				toolCallId: "search-call-1",
				toolName: "grep",
				content: [{ type: "text", text: "note.txt" }],
				isError: false,
				timestamp: 3,
			} as AgentMessage,
			assistant.entry.id,
		);
		root.children.push(assistant);
		assistant.children.push(toolResult);

		const rendered = renderTree([root], toolResult.entry.id);

		expect(rendered).toContain("[grep: /space-needle/ in folder with spaces/]");
		expect(rendered).not.toContain("[grep: /space-needle/ in .]");
	});

	it("search keeps a single path that contains spaces", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("search-space-directory", {
			pattern: "space-needle",
			path: "folder with spaces/",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("note.txt");
		expect(details?.fileCount).toBe(1);
		expect(details?.scopePath).toBe("folder with spaces");
	});

	it("search accepts quoted directory paths", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("search-quoted-path", {
			pattern: "shared-needle",
			path: '"packages/"',
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("grep.txt");
		expect(text).not.toContain("other");
		expect(details?.fileCount).toBe(1);
		expect(details?.scopePath).toBe("packages");
	});

	it("search formats absolute in-cwd paths relative to cwd", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const absoluteAppsPath = path.join(tempDir, "apps");
		const result = await tool.execute("search-absolute-in-cwd", {
			pattern: "shared-needle",
			path: absoluteAppsPath,
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toMatch(/^# apps\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).toContain("shared-needle");
		expect(text).not.toContain(tempDir);
		expect(details?.fileCount).toBe(1);
		expect(details?.scopePath).toBe("apps");
	});

	it("write reports absolute in-cwd targets relative to cwd", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "search-path-lists-"));
		const tools = await createTools(createTestSession(tmp));
		const tool = tools.find(entry => entry.name === "write");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing write tool");

		const absoluteTarget = path.join(tmp, "written.txt");
		const result = await tool.execute("write-absolute-in-cwd", {
			path: absoluteTarget,
			content: "written\n",
		});
		const text = getText(result);

		expect(text).toContain("Successfully wrote 8 bytes to written.txt");
		expect(text).not.toContain(tmp);
		expect(await Bun.file(absoluteTarget).text()).toBe("written\n");
		await removeWithRetries(tmp);
	});

	it("read expands comma-delimited paths", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");

		const result = await tool.execute("read-delimited", {
			path: "apps/grep.txt, packages/grep.txt",
		});
		const text = getText(result);
		const details = result.details as { notes?: string[] } | undefined;

		expect(text).toContain("Note: interpreted as 2 paths: apps/grep.txt, packages/grep.txt");
		expect(text).toContain("shared-needle apps");
		expect(text).toContain("shared-needle packages");
		expect(details?.notes).toEqual(["Note: interpreted as 2 paths: apps/grep.txt, packages/grep.txt"]);
	});

	it("read treats semicolon lists as explicit scope before fuzzy suffix recovery", async () => {
		const decoyRoot = path.join(tempDir, "decoy");
		const decoyPath = path.join(decoyRoot, "apps", "grep.txt; packages", "grep.txt");
		await fs.mkdir(path.dirname(decoyPath), { recursive: true });
		await Bun.write(decoyPath, "fuzzy-decoy\n");

		try {
			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "read");
			expect(tool).toBeDefined();
			if (!tool) throw new Error("Missing read tool");

			const result = await tool.execute("read-semicolon-delimited", {
				path: "apps/grep.txt; packages/grep.txt",
			});
			const text = getText(result);

			expect(text).toContain("Note: interpreted as 2 paths: apps/grep.txt, packages/grep.txt");
			expect(text).toContain("shared-needle apps");
			expect(text).toContain("shared-needle packages");
			expect(text).not.toContain("fuzzy-decoy");
		} finally {
			await removeWithRetries(decoyRoot);
		}
	});

	it("read keeps readable delimited paths when peers are missing", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");

		const result = await tool.execute("read-delimited-missing", {
			path: "missing.txt, packages/grep.txt",
		});
		const text = getText(result);
		const details = result.details as { notes?: string[] } | undefined;

		expect(text).toContain("Note: interpreted as 2 paths: missing.txt, packages/grep.txt");
		expect(text).toContain("shared-needle packages");
		expect(text).toContain("[Could not read missing.txt: Path 'missing.txt' not found]");
		expect(details?.notes).toEqual([
			"Note: interpreted as 2 paths: missing.txt, packages/grep.txt",
			"Could not read missing.txt: Path 'missing.txt' not found",
		]);
	});

	it("ast_grep accepts quoted path and glob filters", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "ast_grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing ast_grep tool");

		const result = await tool.execute("ast-grep-quoted-path", {
			pat: "providerOptions",
			path: '"packages/**/*.ts"',
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("ast.ts");
		expect(text).not.toContain("other");
		expect(details?.fileCount).toBe(1);
		expect(details?.scopePath).toBe("packages");
	});

	it("ast_grep accepts a semicolon-delimited path list", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "ast_grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing ast_grep tool");

		const result = await tool.execute("ast-grep-path-array", {
			pat: "providerOptions",
			path: "apps/**/*.ts; packages/**/*.ts; phases/**/*.ts",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toMatch(/^# apps\/\n## ast\.ts#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# packages\/\n## ast\.ts#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# phases\/\n## ast\.ts#[0-9A-F]{4}/m);
		expect(text).not.toContain("# other");
		expect(details?.fileCount).toBe(3);
		expect(details?.scopePath).toBe("apps/**/*.ts, packages/**/*.ts, phases/**/*.ts");
	});

	it("ast_grep expands delimited path entries", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "ast_grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing ast_grep tool");

		for (const [name, entry] of [
			["comma", "apps/**/*.ts, packages/**/*.ts"],
			["semicolon", "apps/**/*.ts;packages/**/*.ts"],
			["space", "apps/**/*.ts packages/**/*.ts"],
		] as const) {
			const result = await tool.execute(`ast-grep-delimited-${name}`, {
				pat: "providerOptions",
				path: entry,
			});
			const text = getText(result);
			const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

			expect(text).toMatch(/^# apps\/\n## ast\.ts#[0-9A-F]{4}/m);
			expect(text).toMatch(/^# packages\/\n## ast\.ts#[0-9A-F]{4}/m);
			expect(text).not.toContain("# phases");
			expect(text).not.toContain("# other");
			expect(details?.fileCount).toBe(2);
			expect(details?.scopePath).toBe("apps/**/*.ts, packages/**/*.ts");
		}
	});

	it("ast_edit applies across an explicit path array", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "search-path-lists-"));
		await createSearchFixture(tmp);
		const queue = new ToolChoiceQueue();
		const tools = await createTools(
			createTestSession(tmp, {
				getToolChoiceQueue: () => queue,
				buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
				steer: () => {},
			}),
		);
		const tool = tools.find(entry => entry.name === "ast_edit");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing ast_edit tool");

		const preview = await tool.execute("ast-edit-path-array", {
			ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
			paths: ["apps/**/*.ts", "packages/**/*.ts", "phases/**/*.ts"],
		});
		const text = getText(preview);
		const details = preview.details as { totalReplacements?: number; scopePath?: string } | undefined;

		expect(text).toMatch(/^# apps\/\n## ast\.ts#[0-9A-F]{4} \(\d+ replacement/m);
		expect(text).toMatch(/^# packages\/\n## ast\.ts#[0-9A-F]{4} \(\d+ replacement/m);
		expect(text).toMatch(/^# phases\/\n## ast\.ts#[0-9A-F]{4} \(\d+ replacement/m);
		expect(text).not.toContain("# other");
		expect(details?.totalReplacements).toBe(3);
		expect(details?.scopePath).toBe("apps/**/*.ts, packages/**/*.ts, phases/**/*.ts");

		const invoker = queue.peekPendingInvoker();
		if (!invoker) throw new Error("Expected pending resolve invoker");
		await invoker({ action: "apply", reason: "apply multi-path ast edit" });

		expect(await Bun.file(path.join(tmp, "apps", "ast.ts")).text()).toContain("modernWrap(appsValue, appsArg)");
		expect(await Bun.file(path.join(tmp, "packages", "ast.ts")).text()).toContain(
			"modernWrap(packagesValue, packagesArg)",
		);
		expect(await Bun.file(path.join(tmp, "phases", "ast.ts")).text()).toContain("modernWrap(phasesValue, phasesArg)");
		expect(await Bun.file(path.join(tmp, "other", "ast.ts")).text()).toContain("legacyWrap(otherValue, otherArg)");
		await removeWithRetries(tmp);
	});

	it("find accepts a semicolon-delimited path list", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "glob");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing glob tool");

		const result = await tool.execute("find-path-array", {
			path: "apps/; packages/; phases/",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string; files?: string[] } | undefined;

		expect(text).toMatch(/^# apps\/\n(?:ast\.ts|grep\.txt)\n(?:ast\.ts|grep\.txt)$/m);
		expect(text).toMatch(/^# packages\/\n(?:ast\.ts|grep\.txt)\n(?:ast\.ts|grep\.txt)$/m);
		expect(text).toMatch(/^# phases\/\n(?:ast\.ts|grep\.txt)\n(?:ast\.ts|grep\.txt)$/m);
		expect(details?.files).toEqual(
			expect.arrayContaining([
				"apps/ast.ts",
				"packages/ast.ts",
				"phases/ast.ts",
				"apps/grep.txt",
				"packages/grep.txt",
				"phases/grep.txt",
			]),
		);
		expect(text).not.toContain("other/ast.ts");
		expect(details?.fileCount).toBe(6);
		expect(details?.scopePath).toBe("apps/, packages/, phases/");
	});

	it("find expands delimited path entries", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "glob");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing glob tool");

		for (const [name, entry] of [
			["comma", "apps/grep.txt, packages/grep.txt"],
			["semicolon", "apps/grep.txt;packages/grep.txt"],
			["space", "apps/grep.txt packages/grep.txt"],
		] as const) {
			const result = await tool.execute(`find-delimited-${name}`, {
				path: entry,
			});
			const text = getText(result);
			const details = result.details as { fileCount?: number; scopePath?: string; files?: string[] } | undefined;

			expect(text).toMatch(/^# apps\/\ngrep\.txt$/m);
			expect(text).toMatch(/^# packages\/\ngrep\.txt$/m);
			expect(text).not.toContain("phases");
			expect(text).not.toContain("other");
			expect(details?.fileCount).toBe(2);
			expect(details?.files).toEqual(expect.arrayContaining(["apps/grep.txt", "packages/grep.txt"]));
			expect(details?.scopePath).toBe("apps/grep.txt, packages/grep.txt");
		}
	});

	it("find keeps comma-delimited surviving entries when peers are missing", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "glob");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing glob tool");

		const result = await tool.execute("find-delimited-missing", {
			path: "missing.txt, packages/grep.txt",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; missingPaths?: string[]; files?: string[] } | undefined;

		expect(text).toMatch(/^# packages\/\ngrep\.txt$/m);
		expect(text).toContain("Skipped missing paths: missing.txt");
		expect(text).not.toContain("apps");
		expect(details?.fileCount).toBe(1);
		expect(details?.files).toEqual(["packages/grep.txt"]);
		expect(details?.missingPaths).toEqual(["missing.txt"]);
	});

	it("find keeps a single path that contains spaces", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "glob");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing glob tool");

		const result = await tool.execute("find-space-directory", {
			path: "folder with spaces/",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string; files?: string[] } | undefined;

		expect(text).toMatch(/^# folder with spaces\/\nnote\.txt$/m);
		expect(details?.fileCount).toBe(1);
		expect(details?.files).toEqual(["folder with spaces/note.txt"]);
		expect(details?.scopePath).toBe("folder with spaces");
	});

	it("find accepts quoted directory patterns", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "glob");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing glob tool");

		const result = await tool.execute("find-quoted-pattern", {
			path: '"packages/"',
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("ast.ts");
		expect(text).toContain("grep.txt");
		expect(text).not.toContain("other/ast.ts");
		expect(details?.fileCount).toBe(2);
		expect(details?.scopePath).toBe("packages");
	});

	it("find keeps paths outside cwd absolute", async () => {
		const outsideDir = await fs.mkdtemp(path.join(path.dirname(tempDir), "find-outside-"));
		try {
			await Bun.write(path.join(outsideDir, "outside.txt"), "outside\n");
			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "glob");
			expect(tool).toBeDefined();
			if (!tool) throw new Error("Missing glob tool");

			const result = await tool.execute("find-outside-cwd", {
				path: outsideDir,
			});
			const text = getText(result);
			const expectedPath = path.join(outsideDir, "outside.txt").replace(/\\/g, "/");
			const details = result.details as { fileCount?: number; scopePath?: string; files?: string[] } | undefined;

			expect(text).toContain(`# ${outsideDir.replace(/\\/g, "/")}/\noutside.txt`);
			expect(text).not.toContain("../");
			expect(details?.fileCount).toBe(1);
			expect(details?.files).toEqual([expectedPath]);
			expect(details?.scopePath).toBe(outsideDir.replace(/\\/g, "/"));
		} finally {
			await removeWithRetries(outsideDir);
		}
	});

	it("grep accepts a bare semicolon-delimited directory list", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("grep-bare-path-array", {
			pattern: "shared-needle",
			path: "apps; packages; phases",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toMatch(/^# apps\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# packages\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# phases\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).not.toContain("# other");
		expect(details?.fileCount).toBe(3);
		expect(details?.scopePath).toBe("apps, packages, phases");
	});

	it("grep keeps explicit files exact", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "search-path-lists-"));
		await fs.mkdir(path.join(tmp, "nested"), { recursive: true });
		await Bun.write(path.join(tmp, "alpha.txt"), "exact-needle alpha\n");
		await Bun.write(path.join(tmp, "beta.txt"), "exact-needle beta\n");
		await Bun.write(path.join(tmp, "nested", "alpha.txt"), "exact-needle nested alpha\n");
		await Bun.write(path.join(tmp, "nested", "beta.txt"), "exact-needle nested beta\n");

		const tools = await createTools(createTestSession(tmp));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("grep-exact-file-array", {
			pattern: "exact-needle",
			path: "alpha.txt; beta.txt",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toMatch(/^# alpha\.txt#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# beta\.txt#[0-9A-F]{4}/m);
		expect(text).toContain("exact-needle alpha");
		expect(text).toContain("exact-needle beta");
		expect(text).not.toContain("nested");
		expect(details?.fileCount).toBe(2);
		expect(details?.scopePath).toBe("alpha.txt, beta.txt");
		await removeWithRetries(tmp);
	});

	it("grep renders only file headings that have child lines", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("grep-no-empty-headings", {
			pattern: "shared-needle",
			path: "apps/; packages/; phases/",
		});
		const lines = getText(result).split("\n");

		for (let index = 0; index < lines.length; index += 1) {
			if (!lines[index].startsWith("#")) continue;
			const nextIndex = lines.findIndex((line, candidateIndex) => candidateIndex > index && line.trim().length > 0);
			expect(nextIndex, `heading ${lines[index]} should have rendered children`).toBeGreaterThan(index);
			if (lines[index].startsWith("##")) {
				expect(lines[nextIndex].startsWith("#")).toBe(false);
			} else if (!lines[nextIndex].startsWith("##")) {
				expect(lines[nextIndex].startsWith("#")).toBe(false);
			}
		}
	});

	it("grep explains match and context gutters with new format", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "search-path-lists-"));
		await Bun.write(path.join(tmp, "context.txt"), "#if FLAG\nneedle\n#endif\n");

		const tools = await createTools(
			createTestSession(tmp, {
				settings: Settings.isolated({ "grep.contextBefore": 1, "grep.contextAfter": 1 }),
			}),
		);
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("grep-context-label", {
			pattern: "needle",
			path: "context.txt",
		});
		const text = getText(result);

		expect(text).toMatch(/ 1:#if FLAG/);
		expect(text).toMatch(/\*2:needle/);
		expect(text).toMatch(/ 3:#endif/);
		await removeWithRetries(tmp);
	});
});
