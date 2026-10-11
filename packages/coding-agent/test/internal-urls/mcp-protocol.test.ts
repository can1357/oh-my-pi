import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadSkillsFromDir } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPResource, MCPResourceReadResult, MCPResourceTemplate } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { withTimeout } from "@oh-my-pi/pi-utils";

function createMockManager(opts: {
	servers?: string[];
	resources?: Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>;
	readResult?: MCPResourceReadResult | undefined;
	readError?: Error;
	ensureResources?: (name: string) => Promise<void>;
	waitForPendingConnections?: () => Promise<void>;
}) {
	return {
		getConnectedServers: () => opts.servers ?? [],
		waitForPendingConnections: async () => opts.waitForPendingConnections?.(),
		getServerResources: (name: string) => opts.resources?.get(name),
		ensureServerResources: async (name: string) => opts.ensureResources?.(name),
		readServerResource: async (_name: string, _uri: string) => {
			if (opts.readError) throw opts.readError;
			return opts.readResult;
		},
	} as unknown as MCPManager;
}

function createToolSession(): ToolSession {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};
}

describe("McpProtocolHandler", () => {
	beforeEach(() => {
		MCPManager.resetForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		MCPManager.resetForTests();
		InternalUrlRouter.resetForTests();
	});

	it("returns error when no MCP manager is available", async () => {
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("mcp://test://resource")).rejects.toThrow("No MCP manager");
	});

	it("requires resource URI in mcp URL", async () => {
		const manager = createMockManager({ servers: ["server-a"] });
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("mcp://")).rejects.toThrow("mcp:// URL requires a resource URI");
	});

	it("returns error listing available resources when no server matches", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("server-a", {
			resources: [{ uri: "file://known", name: "known-resource" }],
			templates: [],
		});
		const manager = createMockManager({ servers: ["server-a"], resources });
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("mcp://test://missing")).rejects.toThrow("No MCP server has resource");
		await expect(router.resolve("mcp://test://missing")).rejects.toThrow("file://known");
		await expect(router.resolve("mcp://test://missing")).rejects.toThrow("server-a");
	});

	it("lists resource templates alongside concrete resources when no server matches", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("server-a", {
			resources: [{ uri: "example://items/open", name: "open-item" }],
			templates: [{ uriTemplate: "example://items/{id}", name: "item-template" }],
		});
		const manager = createMockManager({ servers: ["server-a"], resources });
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("mcp://example://missing")).rejects.toThrow("example://items/open");
		await expect(router.resolve("mcp://example://missing")).rejects.toThrow("example://items/{id}");
	});

	it("reads resource by exact URI match", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("my-server", {
			resources: [{ uri: "test://doc", name: "doc" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["my-server"],
			resources,
			readResult: { contents: [{ uri: "test://doc", text: "hello world" }] },
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://doc");
		expect(resource.content).toBe("hello world");
		expect(resource.notes).toEqual(["MCP server: my-server"]);
	});

	it("cancels a resource read the server never answers", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("slow", { resources: [{ uri: "test://slow", name: "slow" }], templates: [] });
		const readStarted = Promise.withResolvers<void>();
		const manager = createMockManager({ servers: ["slow"], resources });
		// Like a transport request: pending until the server answers or the caller's signal aborts it.
		manager.readServerResource = (_name, _uri, options) => {
			readStarted.resolve();
			const { promise, reject } = Promise.withResolvers<undefined>();
			options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
			return promise;
		};
		MCPManager.setInstance(manager);
		const controller = new AbortController();

		const reading = InternalUrlRouter.instance().resolve("mcp://test://slow", { signal: controller.signal });
		await readStarted.promise;
		controller.abort();
		// A lost signal leaves the read pending forever; fail instead of hanging the suite.
		await expect(withTimeout(reading, 2_000, "read ignored cancellation")).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	it("preserves a literal semicolon in an exact MCP resource URI", async () => {
		const uri = "catalog://items;active";
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("catalog", {
			resources: [{ uri, name: "active-items" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["catalog"],
			resources,
			readResult: { contents: [{ uri, text: "active items" }] },
		});
		MCPManager.setInstance(manager);

		const result = await new ReadTool(createToolSession()).execute("read-semicolon-resource", {
			path: `mcp://${uri}`,
		});
		const output = result.content.find(block => block.type === "text");

		expect(output?.type).toBe("text");
		if (output?.type !== "text") throw new Error("Expected text output");
		expect(output.text).toContain("active items");
		expect(output.text).not.toContain("interpreted as");
	});

	it("lets read consume a native URI advertised by an MCP server", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("ags", {
			resources: [{ uri: "ags://capabilities/current-host", name: "current-host" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["ags"],
			resources,
			readResult: {
				contents: [{ uri: "ags://capabilities/current-host", text: "host capabilities" }],
			},
		});
		MCPManager.setInstance(manager);

		const result = await new ReadTool(createToolSession()).execute("read-ags-resource", {
			path: "ags://capabilities/current-host",
		});
		const output = result.content.find(block => block.type === "text");

		expect(output?.type).toBe("text");
		if (output?.type !== "text") throw new Error("Expected text output");
		expect(output.text).toContain("host capabilities");
	});

	it("waits for the MCP resource catalog before rejecting a native URI", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		let ensureCalls = 0;
		const manager = createMockManager({
			servers: ["ags"],
			resources,
			ensureResources: async name => {
				ensureCalls += 1;
				resources.set(name, {
					resources: [{ uri: "ags://capabilities/current-host", name: "current-host" }],
					templates: [],
				});
			},
			readResult: {
				contents: [{ uri: "ags://capabilities/current-host", text: "loaded after discovery" }],
			},
		});
		MCPManager.setInstance(manager);

		const result = await new ReadTool(createToolSession()).execute("read-delayed-ags-resource", {
			path: "ags://capabilities/current-host",
		});
		const output = result.content.find(block => block.type === "text");

		expect(ensureCalls).toBe(1);
		expect(output?.type).toBe("text");
		if (output?.type !== "text") throw new Error("Expected text output");
		expect(output.text).toContain("loaded after discovery");
	});

	it("resolves a native URI whose path is exactly a trailing slash", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("catalog", {
			resources: [{ uri: "catalog://root/", name: "root" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["catalog"],
			resources,
			readResult: { contents: [{ uri: "catalog://root/", text: "catalog root" }] },
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("catalog://root/");
		expect(resource.content).toBe("catalog root");
		expect(resource.notes).toEqual(["MCP server: catalog"]);
	});

	it("resolves an opaque resource URI advertised by an MCP server", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("registry", {
			resources: [{ uri: "urn:example:document", name: "document" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["registry"],
			resources,
			readResult: { contents: [{ uri: "urn:example:document", text: "opaque payload" }] },
		});
		MCPManager.setInstance(manager);

		const result = await new ReadTool(createToolSession()).execute("read-opaque-resource", {
			path: "urn:example:document",
		});
		const output = result.content.find(block => block.type === "text");

		expect(output?.type).toBe("text");
		if (output?.type !== "text") throw new Error("Expected text output");
		expect(output.text).toContain("opaque payload");
	});

	it("recognizes opaque URIs in canResolve without swallowing path-like inputs", () => {
		const router = InternalUrlRouter.instance();
		expect(router.canResolve("urn:example:document")).toBe(true);
		expect(router.canResolve("custom:item")).toBe(true);
		// Windows drive paths and selector-shaped filesystem inputs stay on the
		// filesystem path.
		expect(router.canResolve("C:\\Temp\\notes.txt")).toBe(false);
		expect(router.canResolve("C:/tmp/notes.txt")).toBe(false);
		expect(router.canResolve("Makefile:12")).toBe(false);
		expect(router.canResolve("foo.ts:50-80")).toBe(false);
		expect(router.canResolve("README:raw")).toBe(false);
	});

	it("preserves query parameters in MCP resource URI", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("query-server", {
			resources: [{ uri: "test://doc?q=1", name: "doc" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["query-server"],
			resources,
			readResult: { contents: [{ uri: "test://doc?q=1", text: "query resource" }] },
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://doc?q=1");
		expect(resource.content).toBe("query resource");
	});

	it("matches URI templates when no exact URI exists", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("tmpl-server", {
			resources: [],
			templates: [{ uriTemplate: "test://docs/{id}/raw", name: "doc-template" }],
		});
		const manager = createMockManager({
			servers: ["tmpl-server"],
			resources,
			readResult: { contents: [{ uri: "test://docs/foo/raw", text: "from template" }] },
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://docs/foo/raw");
		expect(resource.content).toBe("from template");
	});

	it("matches templates when an expression expands to an empty string", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("query-template-server", {
			resources: [],
			templates: [{ uriTemplate: "test://docs{?cursor}", name: "query-template" }],
		});
		const manager = createMockManager({
			servers: ["query-template-server"],
			resources,
			readResult: { contents: [{ uri: "test://docs", text: "empty expansion" }] },
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://docs");
		expect(resource.content).toBe("empty expansion");
	});

	it("picks the most specific matching template across overlapping schemes", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("broad-server", {
			resources: [],
			templates: [{ uriTemplate: "test://{path}", name: "broad" }],
		});
		resources.set("specific-server", {
			resources: [],
			templates: [{ uriTemplate: "test://foo/{id}", name: "specific" }],
		});
		const manager = createMockManager({
			servers: ["broad-server", "specific-server"],
			resources,
			readResult: { contents: [{ uri: "test://foo/123", text: "from specific" }] },
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://foo/123");
		expect(resource.notes).toEqual(["MCP server: specific-server"]);
	});

	it("uses connected server order when matching templates are equally specific", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("first", {
			resources: [],
			templates: [{ uriTemplate: "test://{id}", name: "first-template" }],
		});
		resources.set("second", {
			resources: [],
			templates: [{ uriTemplate: "test://{id}", name: "second-template" }],
		});
		const manager = createMockManager({
			servers: ["first", "second"],
			resources,
			readResult: { contents: [{ uri: "test://foo", text: "from first" }] },
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://foo");
		expect(resource.notes).toEqual(["MCP server: first"]);
	});

	it("does not match template with different scheme prefix", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("tmpl-server", {
			resources: [],
			templates: [{ uriTemplate: "testing://{id}", name: "testing-template" }],
		});
		const manager = createMockManager({ servers: ["tmpl-server"], resources });
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("mcp://test://foo")).rejects.toThrow("No MCP server has resource");
	});

	it("returns error when readServerResource returns undefined", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("null-server", {
			resources: [{ uri: "test://empty", name: "empty" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["null-server"],
			resources,
			readResult: undefined,
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("mcp://test://empty")).rejects.toThrow("returned no content");
		await expect(router.resolve("mcp://test://empty")).rejects.toThrow("null-server");
	});

	it("formats binary content with mime type and base64 length", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("bin-server", {
			resources: [{ uri: "test://image", name: "image" }],
			templates: [],
		});
		const blobData = "iVBORw0KGgo=";
		const manager = createMockManager({
			servers: ["bin-server"],
			resources,
			readResult: {
				contents: [{ uri: "test://image", mimeType: "image/png", blob: blobData }],
			},
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://image");
		expect(resource.content).toContain("[Binary content:");
		expect(resource.content).toContain("image/png");
		expect(resource.content).toContain(`base64 length ${blobData.length}`);
	});

	it("joins mixed text and binary content with --- separator", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("mix-server", {
			resources: [{ uri: "test://mixed", name: "mixed" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["mix-server"],
			resources,
			readResult: {
				contents: [
					{ uri: "test://mixed", text: "part one" },
					{ uri: "test://mixed", blob: "AAAA", mimeType: "application/octet-stream" },
				],
			},
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://mixed");
		expect(resource.content).toContain("part one");
		expect(resource.content).toContain("\n---\n");
		expect(resource.content).toContain("[Binary content:");
	});

	it("returns (empty resource) when content items have neither text nor blob", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("empty-server", {
			resources: [{ uri: "test://blank", name: "blank" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["empty-server"],
			resources,
			readResult: {
				contents: [{ uri: "test://blank" }],
			},
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://blank");
		expect(resource.content).toBe("(empty resource)");
	});

	it("returns error with message when readServerResource throws", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("err-server", {
			resources: [{ uri: "test://fail", name: "fail" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["err-server"],
			resources,
			readError: new Error("connection refused"),
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("mcp://test://fail")).rejects.toThrow("MCP resource read error:");
		await expect(router.resolve("mcp://test://fail")).rejects.toThrow("connection refused");
	});

	it("picks the first server with a matching resource", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("first", {
			resources: [{ uri: "test://shared", name: "shared" }],
			templates: [],
		});
		resources.set("second", {
			resources: [{ uri: "test://shared", name: "shared" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["first", "second"],
			resources,
			readResult: { contents: [{ uri: "test://shared", text: "from first" }] },
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://shared");
		expect(resource.notes).toEqual(["MCP server: first"]);
	});

	it("shows (none) when no servers have any resources", async () => {
		const manager = createMockManager({ servers: ["lonely-server"] });
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("mcp://test://anything")).rejects.toThrow("(none)");
	});
});

describe("skill:// falls back to an MCP resource with the same URI", () => {
	const skillUri = "skill://figma/figma-use/SKILL.md";
	const mcpText = "---\nname: figma-use\n---\nMANDATORY";
	let tmpDirs: string[] = [];

	beforeEach(() => {
		MCPManager.resetForTests();
		InternalUrlRouter.resetForTests();
		tmpDirs = [];
	});

	afterEach(async () => {
		MCPManager.resetForTests();
		InternalUrlRouter.resetForTests();
		await Promise.all(tmpDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
		tmpDirs = [];
	});

	function figmaManager(text = mcpText) {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("figma", {
			resources: [{ uri: skillUri, name: "figma-use" }],
			templates: [],
		});
		return createMockManager({
			servers: ["figma"],
			resources,
			readResult: { contents: [{ uri: skillUri, text }] },
		});
	}

	function textOf(result: AgentToolResult<ReadToolDetails>): string {
		return result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
	}

	it("applies line/raw selectors to MCP skill text through ReadTool", async () => {
		MCPManager.setInstance(figmaManager("L1\nL2\nL3\nL4"));
		const result = await new ReadTool(createToolSession()).execute("read-skill-range", {
			path: `${skillUri}:2-3:raw`,
		});
		const text = textOf(result);
		expect(text).toContain("L2\nL3");
		expect(text).not.toContain("L1");
		expect(text).not.toContain("L4");
	});

	it("reads a skill resource while its only MCP server is still connecting", async () => {
		const servers: string[] = [];
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		MCPManager.setInstance(
			createMockManager({
				servers,
				resources,
				waitForPendingConnections: async () => {
					servers.push("figma");
				},
				ensureResources: async () => {
					resources.set("figma", { resources: [{ uri: skillUri, name: "figma-use" }], templates: [] });
				},
				readResult: { contents: [{ uri: skillUri, text: "L1\nL2\nL3\nL4" }] },
			}),
		);
		const result = await new ReadTool(createToolSession()).execute("read-connecting-skill", {
			path: `${skillUri}:2-3:raw`,
		});
		const text = textOf(result);
		expect(text).toContain("L2\nL3");
		expect(text).not.toContain("L1");
		expect(text).not.toContain("L4");
	});

	it("requires explicit MCP routing for skill URI templates", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("figma", {
			resources: [],
			templates: [{ uriTemplate: "skill://{+path}", name: "all-skills" }],
		});
		MCPManager.setInstance(
			createMockManager({
				servers: ["figma"],
				resources,
				readResult: { contents: [{ uri: skillUri, text: "template instruction" }] },
			}),
		);
		const read = new ReadTool(createToolSession());
		await expect(read.execute("read-template-skill", { path: skillUri })).rejects.toThrow("Unknown skill: figma");
		const result = await read.execute("read-explicit-template", { path: `mcp://${skillUri}` });
		expect(textOf(result)).toContain("template instruction");
	});

	it("keeps Unknown skill when neither local nor MCP advertises the URI", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("figma", { resources: [], templates: [] });
		MCPManager.setInstance(createMockManager({ servers: ["figma"], resources }));
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("skill://nope", { skills: [] })).rejects.toThrow(/Unknown skill: nope/);
		await expect(router.resolve("skill://nope", { skills: [] })).rejects.toThrow(/Available: none/);

		const target = await router.target("skill://nope", { skills: [] });
		expect(target?.kind).toBe("resource");

		MCPManager.resetForTests();
		InternalUrlRouter.resetForTests();
		const bare = InternalUrlRouter.instance();
		await expect(bare.target("skill://nope", { skills: [] })).rejects.toThrow(/Unknown skill: nope/);
	});

	it("prefers a loaded local skill over an MCP resource with the same URI", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-mcp-fallback-"));
		tmpDirs.push(tmp);
		const skillDir = path.join(tmp, "figma");
		await fs.mkdir(path.join(skillDir, "figma-use"), { recursive: true });
		await Bun.write(path.join(skillDir, "SKILL.md"), "---\nname: figma\ndescription: local\n---\n# figma\n");
		await Bun.write(path.join(skillDir, "figma-use", "SKILL.md"), "local copy");

		const { skills } = await loadSkillsFromDir({ dir: tmp, source: "test" });
		expect(skills.some(s => s.name === "figma")).toBe(true);

		MCPManager.setInstance(figmaManager("mcp copy"));
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve(skillUri, { skills });
		expect(resource.content).toBe("local copy");
		expect(resource.notes ?? []).not.toContain("MCP server: figma");
	});

	it("reports Unknown skill to local-file actions without contacting MCP", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("figma", { resources: [{ uri: skillUri, name: "figma-use" }], templates: [] });
		let contacted = false;
		MCPManager.setInstance(
			createMockManager({
				servers: ["figma"],
				resources,
				readResult: { contents: [{ uri: skillUri, text: mcpText }] },
				waitForPendingConnections: async () => {
					contacted = true;
				},
			}),
		);
		const router = InternalUrlRouter.instance();

		// `%load` and plan-mode writes need a local file; an advertised resource cannot back them.
		await expect(router.requireLocal(skillUri, "load", { skills: [] })).rejects.toThrow("Unknown skill: figma");
		await expect(router.requireLocal("skill://nope", "load", { skills: [] })).rejects.toThrow("Unknown skill: nope");
		expect(contacted).toBe(false);
	});

	it("keeps read result limits for MCP skill text, unlike local skill instructions", async () => {
		const lines = Array.from({ length: 20_000 }, (_, index) => `L${index + 1}`);
		MCPManager.setInstance(figmaManager(lines.join("\n")));
		const result = await new ReadTool(createToolSession()).execute("read-skill-limits", { path: skillUri });
		const text = textOf(result);
		expect(text).toContain("L1\n");
		expect(text).not.toContain("L20000");
	});

	it("reports Unknown skill for an :img read instead of the selector error", async () => {
		MCPManager.setInstance(figmaManager());
		await expect(
			new ReadTool(createToolSession()).execute("read-skill-img", { path: "skill://nope/x.svg:img" }),
		).rejects.toThrow("Unknown skill: nope");
	});

	it("keeps Unknown skill when deferred MCP startup fails", async () => {
		MCPManager.setDeferredInstance(async () => {
			throw new Error("auth storage locked");
		});
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("skill://nope", { skills: [] })).rejects.toThrow("Unknown skill: nope");
		// The startup error itself is what an explicit MCP read reports.
		await expect(router.resolve(`mcp://${skillUri}`)).rejects.toThrow("auth storage locked");
	});

	it("stops waiting for connecting servers when the read is cancelled mid-wait", async () => {
		let waiting = Promise.withResolvers<void>();
		MCPManager.setInstance(
			createMockManager({
				servers: [],
				// Like a server stuck in its handshake: the wait never settles on its own.
				waitForPendingConnections: () => {
					waiting.resolve();
					return Promise.withResolvers<void>().promise;
				},
			}),
		);
		const router = InternalUrlRouter.instance();
		for (const uri of ["skill://nope", `mcp://${skillUri}`]) {
			waiting = Promise.withResolvers<void>();
			const controller = new AbortController();
			const reading = router.resolve(uri, { skills: [], signal: controller.signal });
			await waiting.promise;
			controller.abort();
			await expect(withTimeout(reading, 2_000, "read ignored cancellation")).rejects.toMatchObject({
				name: "AbortError",
			});
		}
	});

	it("runs the deferred MCP loader once and installs its manager for later reads", async () => {
		let loads = 0;
		MCPManager.setDeferredInstance(async () => {
			loads++;
			return figmaManager();
		});
		const router = InternalUrlRouter.instance();

		expect((await router.resolve(skillUri, { skills: [] })).content).toBe(mcpText);
		expect((await router.resolve(`mcp://${skillUri}`)).content).toBe(mcpText);
		expect(loads).toBe(1);
	});

	it("reads through the replacement loader, not a manager whose loader was replaced mid-load", async () => {
		const stale = Promise.withResolvers<MCPManager>();
		const staleStarted = Promise.withResolvers<void>();
		MCPManager.setDeferredInstance(() => {
			staleStarted.resolve();
			return stale.promise;
		});
		const router = InternalUrlRouter.instance();
		const staleRead = router.resolve(skillUri, { skills: [] });
		await staleStarted.promise;

		MCPManager.setDeferredInstance(async () => figmaManager("replacement"));
		stale.resolve(figmaManager("stale"));
		expect((await staleRead).content).toBe("stale");
		expect((await router.resolve(skillUri, { skills: [] })).content).toBe("replacement");
	});
});
