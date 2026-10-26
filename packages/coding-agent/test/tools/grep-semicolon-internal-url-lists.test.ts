import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetActiveSkillsForTests, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { InternalUrlRouter, LocalProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { AstEditTool } from "../../src/tools/ast-edit";
import { AstGrepTool } from "../../src/tools/ast-grep";
import { GlobTool } from "../../src/tools/glob";
import { GrepTool } from "../../src/tools/grep";
import { ReadTool } from "../../src/tools/read";
import { expandDelimitedPathEntries, resolveReadPath, splitDelimitedPathEntry } from "../../src/tools/path-utils";

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

describe("GrepTool semicolon internal-URL path lists", () => {
	let tmpDir: string;
	let skillBodyNeedle: string;
	let absFile: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-semicolon-"));
		AgentRegistry.resetGlobalForTests();
		MCPManager.resetForTests();
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();

		const skillDir = path.join(tmpDir, "skills", "demo");
		await fs.mkdir(skillDir, { recursive: true });
		skillBodyNeedle = "skill body needle in instructions";
		await Bun.write(path.join(skillDir, "SKILL.md"), `---\nname: demo\n---\n\n# Demo\n\n${skillBodyNeedle}\n`);
		setActiveSkills([
			{
				name: "demo",
				description: "demo skill",
				filePath: path.join(skillDir, "SKILL.md"),
				baseDir: skillDir,
				source: "test",
			},
		]);

		absFile = path.join(tmpDir, "abs-target.md");
		await Bun.write(absFile, "abs path needle\n");
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
		AgentRegistry.resetGlobalForTests();
		MCPManager.resetForTests();
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
		resetActiveSkillsForTests();
	});

	function createSession(): ToolSession {
		return {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
		} as ToolSession;
	}

	it("finds matches from every part of a `;` list mixing an internal URL and an absolute path", async () => {
		const tool = new GrepTool(createSession());

		const result = await tool.execute("semicolon-list", {
			pattern: "needle",
			path: `skill://demo;${absFile}`,
		});

		const text = getResultText(result);
		expect(text).toContain(skillBodyNeedle);
		expect(text).toContain("abs path needle");
	});

	it("searches mixed internal URL lists while excluding filesystem tails", async () => {
		const targets = path.join(tmpDir, "targets");
		await Bun.write(path.join(targets, "keep.md"), "included directory needle\n");
		await Bun.write(path.join(targets, "omit.skip.md"), "excluded directory needle\n");
		const result = await new GrepTool(createSession()).execute("mixed-exclusion", {
			pattern: "needle",
			path: `skill://demo;${targets};!*.skip.md`,
		});
		expect(getResultText(result)).toContain(skillBodyNeedle);
		expect(getResultText(result)).toContain("included directory needle");
		expect(getResultText(result)).not.toContain("excluded directory needle");
		expect(await expandDelimitedPathEntries(["skill://demo;!*.md"], tmpDir)).toEqual([
			"skill://demo;!*.md",
		]);
		expect(await expandDelimitedPathEntries(["skill://demo/a;"], tmpDir, { exclusionParts: true })).toEqual([
			"skill://demo/a;",
		]);
	});

	it("review regression: reads searches and finds a literal selector-shaped local tail", async () => {
		const literal = path.join(tmpDir, "log:1-2");
		await Bun.write(literal, "literal colon filename needle\n");
		const target = `skill://demo;${literal}`;
		const session = createSession();
		const searched = await new GrepTool(session).execute("literal-colon-search", { pattern: "needle", path: target });
		expect(getResultText(searched)).toContain(skillBodyNeedle);
		expect(getResultText(searched)).toContain("literal colon filename needle");
		const found = await new GlobTool(session).execute("literal-colon-find", { path: target });
		expect(found.details?.files?.some(file => file.endsWith("log:1-2"))).toBe(true);
		const read = await new ReadTool(session).execute("literal-colon-read", { path: target });
		expect(getResultText(read)).toContain("literal colon filename needle");
	});

	it("review regression: never truncates a routed MCP component query into a cwd read", async () => {
		await Bun.write(path.join(tmpDir, "tail.md"), "unrelated cwd needle\n");
		const uri = "custom://host/doc?q=x;tail.md";
		const readUris: string[] = [];
		MCPManager.setInstance({
			getConnectedServers: () => ["custom"],
			getServerResources: () => ({
				resources: [{ uri, name: "exact" }],
				templates: [{ uriTemplate: "custom://host/{path}", name: "broad" }],
			}),
			waitForPendingConnections: async () => {},
			ensureServerResources: async () => {},
			readServerResource: async (_server: string, requested: string) => {
				readUris.push(requested);
				return { contents: [{ uri: requested, text: "routed MCP needle" }] };
			},
		} as unknown as MCPManager);
		const target = `skill://demo;${uri}`;
		await expect(new ReadTool(createSession()).execute("routed-query", { path: target })).rejects.toThrow(
			"Unknown skill: demo;custom:",
		);
		expect(readUris).toEqual([]);
	});

	it("review regression: reads an exact native MCP semicolon URI rather than its local tail", async () => {
		const uri = `custom:item;${absFile}`;
		MCPManager.setInstance({
			getConnectedServers: () => ["custom"],
			getServerResources: () => ({
				resources: [{ uri, name: "exact" }, { uri: "custom:item", name: "prefix" }],
				templates: [],
			}),
			waitForPendingConnections: async () => {},
			ensureServerResources: async () => {},
			readServerResource: async (_server: string, requested: string) => ({
				contents: [{ uri: requested, text: requested === uri ? "whole native MCP needle" : "wrong prefix needle" }],
			}),
		} as unknown as MCPManager);
		const result = await new ReadTool(createSession()).execute("exact-native", { path: uri });
		expect(getResultText(result)).toContain("whole native MCP needle");
		expect(getResultText(result)).not.toContain("wrong prefix needle");
		expect(getResultText(result)).not.toContain("abs path needle");
	});

	it("review regression: refuses uncertain discovery for a server registered during the wait", async () => {
		let registered = false;
		MCPManager.setInstance({
			getAllServerNames: () => (registered ? ["late"] : []),
			getConnectedServers: () => [],
			getServerResources: () => undefined,
			waitForPendingConnections: async () => {
				registered = true;
			},
			ensureServerResources: async () => {},
		} as unknown as MCPManager);
		await expect(
			new GrepTool(createSession()).execute("late-failed-server", {
				pattern: "needle",
				path: `skill://demo;${absFile}`,
			}),
		).rejects.toThrow("cannot safely split");
	});

	it("anchors file URL tails after expanding them to filesystem paths", async () => {
		const fileUrl = `file://${absFile}`;
		const target = `skill://demo/SKILL.md;${fileUrl}`;
		expect(await expandDelimitedPathEntries([target], tmpDir)).toEqual(["skill://demo/SKILL.md", fileUrl]);

		const searched = await new GrepTool(createSession()).execute("file-url-tail-search", {
			pattern: "needle",
			path: target,
		});
		expect(getResultText(searched)).toContain(skillBodyNeedle);
		expect(getResultText(searched)).toContain("abs path needle");

		const found = await new GlobTool(createSession()).execute("file-url-tail-find", { path: target });
		expect(found.details?.files).toContain("skill://demo/SKILL.md");
		expect(found.details?.files?.some(file => file.endsWith("abs-target.md"))).toBe(true);

		const read = await new ReadTool(createSession()).execute("file-url-tail-read", { path: target });
		expect(getResultText(read)).toContain(skillBodyNeedle);
		expect(getResultText(read)).toContain("abs path needle");
		const missingTarget = `skill://demo/SKILL.md;file://${path.join(tmpDir, "missing.md")}`;
		expect(await expandDelimitedPathEntries([missingTarget], tmpDir)).toEqual([missingTarget]);
		await expect(
			new GrepTool(createSession()).execute("missing-file-url-tail", {
				pattern: "needle",
				path: missingTarget,
			}),
		).rejects.toMatchObject({
			message: `Cannot search ${missingTarget}: File not found: ${path.join(tmpDir, "skills", "demo", `SKILL.md;file://${path.join(tmpDir, "missing.md")}`)}`,
		});
	});

	it("keeps exact MCP resources whole, including URL-shaped suffixes, and fans out readable HTTPS URL tails", async () => {
		const exactUri = `skill://figma/resource;${absFile}`;
		MCPManager.setInstance({
			getConnectedServers: () => ["figma"],
			getServerResources: () => ({ resources: [{ uri: exactUri, name: "exact" }], templates: [] }),
			readServerResource: async () => ({ contents: [{ uri: exactUri, text: "exact MCP resource needle" }] }),
			waitForPendingConnections: async () => {},
			ensureServerResources: async () => {},
		} as unknown as MCPManager);
		await Bun.write(absFile, "local tail needle\n");
		const read = await new ReadTool(createSession()).execute("exact-mcp-resource", { path: exactUri });
		expect(getResultText(read)).toContain("exact MCP resource needle");
		expect(getResultText(read)).not.toContain("local tail needle");

		const httpsList = "skill://demo/SKILL.md;https://example.test/doc";
		expect(await expandDelimitedPathEntries([httpsList], tmpDir)).toEqual([
			"skill://demo/SKILL.md",
			"https://example.test/doc",
		]);

		// Exact MCP URI whose suffix is itself URL-shaped must stay whole through
		// ReadTool's routed-only fallback (splitMixed declines, then tryReadDelimitedPaths).
		const exactOpaque = "skill://figma/foo;custom:item";
		MCPManager.setInstance({
			getConnectedServers: () => ["figma"],
			getServerResources: () => ({ resources: [{ uri: exactOpaque, name: "exact-opaque" }], templates: [] }),
			readServerResource: async () => ({ contents: [{ uri: exactOpaque, text: "exact opaque MCP needle" }] }),
			waitForPendingConnections: async () => {},
			ensureServerResources: async () => {},
		} as unknown as MCPManager);
		const opaqueRead = await new ReadTool(createSession()).execute("exact-opaque-mcp", { path: exactOpaque });
		expect(getResultText(opaqueRead)).toContain("exact opaque MCP needle");
		expect(getResultText(opaqueRead)).not.toContain("interpreted as");

		// A readable URL component with its own path must keep a following relative
		// tail attached (`https://host/a;b.md` stays whole when b.md exists).
		await Bun.write(path.join(tmpDir, "b.md"), "relative after https needle\n");
		const httpsWithPath = "skill://demo;https://example.test/a;b.md";
		expect(await expandDelimitedPathEntries([httpsWithPath], tmpDir)).toEqual([httpsWithPath]);
	});

	it("waits for deferred MCP catalogs before preserving an exact semicolon resource", async () => {
		const uri = `skill://figma/deferred;${absFile}`;
		let connected = false;
		let catalogReady = false;
		MCPManager.setInstance({
			getConnectedServers: () => (connected ? ["figma"] : []),
			getServerResources: () =>
				catalogReady ? { resources: [{ uri, name: "deferred" }], templates: [] } : undefined,
			waitForPendingConnections: async () => {
				connected = true;
			},
			ensureServerResources: async () => {
				catalogReady = true;
			},
			readServerResource: async () => ({ contents: [{ uri, text: "deferred exact needle" }] }),
		} as unknown as MCPManager);
		const result = await new GrepTool(createSession()).execute("deferred-exact-search", {
			pattern: "needle",
			path: uri,
		});
		expect(getResultText(result)).toContain("deferred exact needle");
		expect(getResultText(result)).not.toContain("abs path needle");
	});

	it("bounds deferred manager loading without guessing whether the semicolon URI is a list", async () => {
		vi.useFakeTimers();
		try {
			const started = Promise.withResolvers<void>();
			MCPManager.setDeferredInstance(() => {
				started.resolve();
				return Promise.withResolvers<MCPManager>().promise;
			});
			let outcome: string | undefined;
			const checking = expandDelimitedPathEntries([`skill://demo;${absFile}`], tmpDir).then(
				() => {
					outcome = "split";
				},
				(error: unknown) => {
					outcome = String(error);
				},
			);
			await started.promise;
			vi.advanceTimersByTime(5_000);
			for (let i = 0; i < 20; i++) await Promise.resolve();
			expect(outcome).toContain("cannot safely split");
			await checking;
		} finally {
			vi.useRealTimers();
		}
	});

	it("shares one discovery budget between deferred startup and unsettled catalogs", async () => {
		vi.useFakeTimers();
		try {
			const loading = Promise.withResolvers<MCPManager>();
			const loadStarted = Promise.withResolvers<void>();
			const catalogsStarted = Promise.withResolvers<void>();
			MCPManager.setDeferredInstance(() => {
				loadStarted.resolve();
				return loading.promise;
			});
			let outcome: string | undefined;
			const checking = expandDelimitedPathEntries([`skill://demo;${absFile}`], tmpDir).then(
				() => {
					outcome = "split";
				},
				(error: unknown) => {
					outcome = String(error);
				},
			);
			await loadStarted.promise;
			vi.advanceTimersByTime(4_000);
			loading.resolve({
				getConnectedServers: () => [],
				getServerResources: () => undefined,
				waitForPendingConnections: () => {
					catalogsStarted.resolve();
					return Promise.withResolvers<void>().promise;
				},
				ensureServerResources: async () => {},
			} as unknown as MCPManager);
			await catalogsStarted.promise;
			vi.advanceTimersByTime(1_000);
			for (let i = 0; i < 20; i++) await Promise.resolve();
			expect(outcome).toContain("cannot safely split");
			await checking;
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels deferred manager loading before classifying a semicolon input", async () => {
		const started = Promise.withResolvers<void>();
		MCPManager.setDeferredInstance(() => {
			started.resolve();
			return Promise.withResolvers<MCPManager>().promise;
		});
		const controller = new AbortController();
		const checking = expandDelimitedPathEntries([`skill://demo;${absFile}`], tmpDir, {
			context: { signal: controller.signal },
		});
		await started.promise;
		controller.abort();
		await expect(checking).rejects.toMatchObject({ name: "AbortError" });
	});

	it("preserves an exact MCP resource URI before a trailing read selector", async () => {
		const uri = `skill://figma/foo;${absFile}`;
		MCPManager.setInstance({
			getConnectedServers: () => ["figma"],
			getServerResources: () => ({ resources: [{ uri, name: "literal" }], templates: [] }),
			waitForPendingConnections: async () => {},
			ensureServerResources: async () => {},
			readServerResource: async () => ({
				contents: [{ uri, text: "selected exact needle\nsecond line\nexcluded needle" }],
			}),
		} as unknown as MCPManager);
		const result = await new GrepTool(createSession()).execute("exact-selected-search", {
			pattern: "needle",
			path: `${uri}:1-2`,
		});
		expect(getResultText(result)).toContain("selected exact needle");
		expect(getResultText(result)).not.toContain("abs path needle");
		expect(getResultText(result)).not.toContain("excluded needle");
	});

	it("cancels delimiter recovery waiting for an MCP catalog without splitting the URI", async () => {
		const started = Promise.withResolvers<void>();
		const pending = Promise.withResolvers<void>();
		MCPManager.setInstance({
			getConnectedServers: () => [],
			getServerResources: () => undefined,
			waitForPendingConnections: () => {
				started.resolve();
				return pending.promise;
			},
			ensureServerResources: async () => {},
		} as unknown as MCPManager);
		const controller = new AbortController();
		const checking = expandDelimitedPathEntries([`skill://figma/deferred;${absFile}`], tmpDir, {
			context: { cwd: tmpDir, signal: controller.signal },
		});
		expect(
			await Promise.race([
				started.promise.then(() => true),
				checking.then(
					() => false,
					() => false,
				),
			]),
		).toBe(true);
		controller.abort();
		try {
			await expect(checking).rejects.toMatchObject({ name: "AbortError" });
		} finally {
			pending.resolve();
		}
	});

	it("reads an opaque MCP URI after a path-bearing internal URL", async () => {
		MCPManager.setInstance({
			getConnectedServers: () => ["custom"],
			getServerResources: () => ({ resources: [{ uri: "custom:item", name: "item" }], templates: [] }),
			waitForPendingConnections: async () => {},
			ensureServerResources: async () => {},
			readServerResource: async () => ({ contents: [{ uri: "custom:item", text: "opaque resource marker" }] }),
		} as unknown as MCPManager);
		const result = await new ReadTool(createSession()).execute("opaque-list-read", {
			path: "skill://demo/SKILL.md;custom:item",
		});
		expect(getResultText(result)).toContain(skillBodyNeedle);
		expect(getResultText(result)).toContain("opaque resource marker");
	});

	it("searches bare cwd and parent directory targets after an internal URL path", async () => {
		const child = path.join(tmpDir, "cwd");
		await fs.mkdir(child);
		await Bun.write(path.join(child, "child.md"), "cwd target needle\n");
		const session = { ...createSession(), cwd: child } as ToolSession;
		for (const tail of [".", ".."]) {
			const result = await new GrepTool(session).execute("dot-tail-search", {
				pattern: "needle",
				path: `skill://demo/SKILL.md;${tail}`,
			});
			expect(getResultText(result)).toContain(skillBodyNeedle);
			expect(getResultText(result)).toContain("cwd target needle");
		}
	});

	it("fans out a local:// list without waiting on pending MCP catalogs", async () => {
		const artifactsDir = path.join(tmpDir, "pending-local-artifacts");
		await Bun.write(path.join(artifactsDir, "local", "notes"), "local list needle\n");
		const session = {
			...createSession(),
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => "pending-local-session",
		} as ToolSession;
		const pending = Promise.withResolvers<void>();
		MCPManager.setInstance({
			getConnectedServers: () => [],
			getServerResources: () => undefined,
			waitForPendingConnections: () => pending.promise,
			ensureServerResources: async () => {},
		} as unknown as MCPManager);
		try {
			const target = `local://notes;${absFile}`;
			// Without the scheme short-circuit this spends the discovery budget and throws.
			expect(await expandDelimitedPathEntries([target], tmpDir)).toEqual(["local://notes", absFile]);
			const result = await new GrepTool(session).execute("local-list-no-mcp-wait", {
				pattern: "needle",
				path: target,
			});
			expect(getResultText(result)).toContain("local list needle");
			expect(getResultText(result)).toContain("abs path needle");
		} finally {
			pending.resolve();
		}
	});

	it("fans out colon-prefixed relative tails after a path-bearing URL", async () => {
		await Bun.write(path.join(tmpDir, "b.md"), "colon relative needle\n");
		const target = "skill://demo/SKILL.md;:./b.md";
		expect(await expandDelimitedPathEntries([target], tmpDir)).toEqual(["skill://demo/SKILL.md", ":./b.md"]);
		const result = await new GrepTool(createSession()).execute("colon-relative-search", {
			pattern: "needle",
			path: target,
		});
		expect(getResultText(result)).toContain(skillBodyNeedle);
		expect(getResultText(result)).toContain("colon relative needle");
	});

	it("keeps a local:// artifact whose name contains `;` whole even when the suffix names a cwd file", async () => {
		const artifactsDir = path.join(tmpDir, "artifacts");
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		await Bun.write(path.join(localRoot, "notes;README.md"), "local artifact needle\n");
		await Bun.write(path.join(tmpDir, "README.md"), "cwd readme needle\n");
		const session = {
			...createSession(),
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => "semicolon-session",
		} as ToolSession;
		LocalProtocolHandler.setOverride({
			getArtifactsDir: () => path.join(tmpDir, "other-session"),
			getSessionId: () => "other-session",
		});
		const tool = new GrepTool(session);

		const result = await tool.execute("literal-semicolon-local", {
			pattern: "needle",
			path: "local://notes;README.md",
		});

		const text = getResultText(result);
		expect(text).toContain("local artifact needle");
		expect(text).not.toContain("cwd readme needle");

		const read = await new ReadTool(session).execute("literal-semicolon-read", { path: "local://notes;README.md" });
		expect(getResultText(read)).toContain("local artifact needle");
		expect(getResultText(read)).not.toContain("cwd readme needle");
		const found = await new GlobTool(session).execute("literal-semicolon-find", { path: "local://notes;README.md" });
		expect(found.details?.files).toEqual(["local://notes;README.md"]);
	});

	it("searches and rewrites a whole semicolon artifact in the caller's pinned local root", async () => {
		const artifactsDir = path.join(tmpDir, "pinned-artifacts");
		const artifactFile = path.join(artifactsDir, "local", "bundle;tail.ts");
		await Bun.write(artifactFile, "legacyWrap(localValue, 1);\n");
		await Bun.write(path.join(tmpDir, "tail.ts"), "legacyWrap(cwdValue, 2);\n");
		const session = {
			...createSession(),
			getArtifactsDir: () => path.join(tmpDir, "own-artifacts"),
			getSessionId: () => "own-session",
			localProtocolOptions: {
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "pinned-session",
			},
		} as ToolSession;
		LocalProtocolHandler.setOverride({
			getArtifactsDir: () => path.join(tmpDir, "other-artifacts"),
			getSessionId: () => "other-session",
		});
		const target = "local://bundle;tail.ts";
		const found = await new AstGrepTool(session).execute("literal-semicolon-ast-search", {
			pat: "legacyWrap($A, $B)",
			path: target,
		});
		expect(getResultText(found)).toContain("localValue");
		expect(getResultText(found)).not.toContain("cwdValue");
		const preview = await new AstEditTool(session).execute("literal-semicolon-ast-edit", {
			ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
			paths: [target],
		});
		expect(getResultText(preview)).toContain("modernWrap(localValue, 1)");
		expect(getResultText(preview)).not.toContain("cwdValue");
	});

	it("fans out for find (GlobTool) too", async () => {
		const tool = new GlobTool(createSession());

		const result = await tool.execute("semicolon-find", { path: `skill://demo;${absFile}` });

		const text = getResultText(result);
		expect(text).toContain("SKILL.md");
		expect(text).toContain("abs-target.md");
	});

	it("keeps a list with a glob or missing local part whole (strict rule)", async () => {
		const tool = new GrepTool(createSession());

		for (const [target, diagnosis] of [
			["skill://demo;*.md", "Cannot search skill://: skill:// URL requires a skill name: skill://<name>"],
			[
				"skill://demo;missing.md",
				"Cannot search skill://demo;missing.md: Unknown skill: demo;missing.md\nAvailable: demo",
			],
		] as const) {
			// A glob is parsed below skill:// after delimiter recovery; prove the
			// recovery step itself retained the exact authored target as well.
			expect(await expandDelimitedPathEntries([target], tmpDir)).toEqual([target]);
			await expect(tool.execute("semicolon-whole", { pattern: "needle", path: target })).rejects.toMatchObject({
				message: diagnosis,
			});
		}
	});

	it("gives a literal `;` in a routed URL path precedence over an existing relative tail", async () => {
		await Bun.write(path.join(tmpDir, "b.md"), "relative tail needle\n");
		await Bun.write(path.join(tmpDir, "skills", "demo", "a;b.md"), "literal resource needle\n");
		const tool = new GrepTool(createSession());

		const result = await tool.execute("semicolon-literal", { pattern: "needle", path: "skill://demo/a;b.md" });
		const text = getResultText(result);
		expect(text).toContain("literal resource needle");
		expect(result.details?.searchPath).toBe("skill://demo/a;b.md");
		expect(text).not.toContain("relative tail needle");
	});

	it("keeps semicolons in an internal URL query or fragment through real consumers", async () => {
		await Bun.write(path.join(tmpDir, "README.md"), "cwd readme needle\n");
		const router = InternalUrlRouter.instance();
		router.register({
			scheme: "vault",
			spec: { backing: "virtual", selectors: "lines", immutable: true },
			async resolve(url) {
				const value = url.searchParams.get("q") ?? url.hash.slice(1);
				const content = value === "foo;README.md" ? "whole query needle\n" : "truncated query needle\n";
				return { url: url.href, content, contentType: "text/plain", size: Buffer.byteLength(content) };
			},
		});
		for (const target of ["vault://Work?op=search&q=foo;README.md", "vault://Work#foo;README.md"]) {
			const result = await new GrepTool(createSession()).execute("query-semicolon-search", {
				pattern: "needle",
				path: target,
			});
			expect(getResultText(result)).toContain("whole query needle");
			expect(getResultText(result)).not.toContain("truncated query needle");
			expect(getResultText(result)).not.toContain("cwd readme needle");
			const found = await new GlobTool(createSession()).execute("query-semicolon-find", { path: target });
			expect(found.details?.files).toEqual([target]);
			const read = await new ReadTool(createSession()).execute("query-semicolon-read", { path: target });
			expect(getResultText(read)).toContain("whole query needle");
			expect(getResultText(read)).not.toContain("cwd readme needle");
		}
		// Read's routed-only recovery must also keep a semicolon inside the query.
		expect(
			await splitDelimitedPathEntry("vault://Work?q=foo;skill://demo", tmpDir, {
				routedUrlPredicate: entry => router.canHandle(entry),
			}),
		).toBeNull();
	});

	it("fans out the supported local:/ alias without mistaking its slash for a URL path", async () => {
		const artifactsDir = path.join(tmpDir, "alias-artifacts");
		await Bun.write(path.join(artifactsDir, "local", "notes"), "alias artifact needle\n");
		await Bun.write(path.join(tmpDir, "README.md"), "cwd readme needle\n");
		const session = {
			...createSession(),
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => "alias-session",
		} as ToolSession;
		const target = "local:/notes;README.md";
		const result = await new GrepTool(session).execute("alias-semicolon-search", { pattern: "needle", path: target });
		expect(getResultText(result)).toContain("alias artifact needle");
		expect(getResultText(result)).toContain("cwd readme needle");
		const found = await new GlobTool(session).execute("alias-semicolon-find", { path: target });
		expect(found.details?.files?.toSorted()).toEqual(["README.md", "local://notes"]);

		// The same spelling must retain a whole existing artifact in this caller's root.
		await Bun.write(path.join(artifactsDir, "local", "notes;README.md"), "whole alias needle\n");
		const whole = await new GrepTool(session).execute("alias-semicolon-whole", { pattern: "needle", path: target });
		expect(getResultText(whole)).toContain("whole alias needle");
		expect(getResultText(whole)).not.toContain("cwd readme needle");
	});

	it("fans out explicit Windows dot-relative tails after URL paths", async () => {
		const url = "skill://demo/subdir";
		const tailStat = await fs.lstat(absFile);
		const realLstat = nodeFs.promises.lstat.bind(nodeFs.promises);
		for (const tail of [String.raw`.\b.md`, String.raw`..\b.md`]) {
			// Supply only Windows literal existence on Linux; keep the production parser and classifier.
			const resolvedTail = resolveReadPath(tail, tmpDir);
			const literalProbe = spyOn(nodeFs.promises, "lstat").mockImplementation((async (target: nodeFs.PathLike) =>
				target === resolvedTail ? tailStat : realLstat(target)) as typeof nodeFs.promises.lstat);
			try {
				expect(await expandDelimitedPathEntries([`${url};${tail}`], tmpDir)).toEqual([url, tail]);
			} finally {
				literalProbe.mockRestore();
			}
		}
	});

	it("fans out a URL with path segments followed by either UNC spelling", async () => {
		const url = "skill://demo/subdir";
		const uncStat = await fs.lstat(absFile);
		const realLstat = nodeFs.promises.lstat.bind(nodeFs.promises);
		for (const tail of [String.raw`\\server\share\file.md`, "//server/share/file.md"]) {
			// Linux cannot stat a native Windows UNC share. Supply only that
			// literal-existence result; run the real canonical delimiter parser
			// and cross-platform anchor classifier without changing platform.
			const resolvedUnc = resolveReadPath(tail, tmpDir);
			const literalProbe = spyOn(nodeFs.promises, "lstat").mockImplementation((async (target: nodeFs.PathLike) =>
				target === resolvedUnc ? uncStat : realLstat(target)) as typeof nodeFs.promises.lstat);
			try {
				expect(await expandDelimitedPathEntries([`${url};${tail}`], tmpDir)).toEqual([url, tail]);
			} finally {
				literalProbe.mockRestore();
			}
		}
	});

	it("searches, finds, and reads a routed resource ending in a literal semicolon without truncating its target", async () => {
		await Bun.write(path.join(tmpDir, "skills", "demo", "a"), "wrong resource needle\n");
		await Bun.write(path.join(tmpDir, "skills", "demo", "a;"), "trailing semicolon needle\n");
		const target = "skill://demo/a;";
		const result = await new GrepTool(createSession()).execute("trailing-semicolon-search", {
			pattern: "needle",
			path: target,
		});
		const text = getResultText(result);
		expect(text).toContain("trailing semicolon needle");
		expect(result.details?.searchPath).toBe(target);
		expect(text).not.toContain("wrong resource needle");
		const found = await new GlobTool(createSession()).execute("trailing-semicolon-find", { path: target });
		expect(found.details?.files).toEqual([target]);
		const read = await new ReadTool(createSession()).execute("trailing-semicolon-read", { path: target });
		const readText = getResultText(read);
		expect(readText).toContain("trailing semicolon needle");
		expect(readText).not.toContain("wrong resource needle");
	});

	it("covers the routed-predicate parser boundary for a trailing semicolon and two URLs", async () => {
		const router = InternalUrlRouter.instance();
		const options = { routedUrlPredicate: (entry: string) => router.canHandle(entry) };
		expect(await splitDelimitedPathEntry("skill://demo/a;", tmpDir, options)).toBeNull();
		expect(await splitDelimitedPathEntry("skill://demo/a;skill://demo/b", tmpDir, options)).toEqual([
			"skill://demo/a",
			"skill://demo/b",
		]);
	});
});
