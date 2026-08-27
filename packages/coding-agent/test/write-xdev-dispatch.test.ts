import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { requiresApproval, resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { githubToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/gh-renderer";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { WriteTool, writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";
import {
	listXdevTools,
	resolveMountedXdevTool,
	XDEV_DOCS_PER_DEVICE_CAP,
	XDEV_DOCS_TOTAL_BUDGET,
	XDEV_EXTERNAL_DESCRIPTION_CAP,
	type XdevState,
	xdevDocs,
	xdevDocsAll,
	xdevEntries,
} from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// xdev mounting is default-on: discoverable tools like ast_edit unmount into
// xd://, and a plain `write xd://ast_edit` dispatches them. These guard the
// resolution-device symbols write.ts pulls from ./resolve — a missing import
// threw `ReferenceError: isResolutionDeviceName is not defined` on *every*
// xd:// write, in both the executor (approval + execute) and the streaming
// renderer (surfacing as the error text inside a generic Write frame).
function xdevSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({}),
		...overrides,
	};
}

function createTestXdevState(tools: Tool[], builtInNames: Iterable<string> = tools.map(tool => tool.name)): XdevState {
	return {
		tools: new Map(tools.map(tool => [tool.name, tool])),
		mountedNames: new Set(tools.map(tool => tool.name)),
		builtInNames: new Set(builtInNames),
		isActive: () => false,
	};
}

describe("read and write route xd:// device URLs", () => {
	it("lists, documents, and dispatches an ast_edit device", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");
			const queue = new ToolChoiceQueue();

			const tools = await createTools(
				xdevSession(tempDir, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}),
			);
			// xdev on: ast_edit is unmounted into xd://; write stays in the toolset.
			const write = tools.find(entry => entry.name === "write");
			const read = tools.find(entry => entry.name === "read");
			expect(read).toBeDefined();
			expect(write).toBeDefined();
			expect(tools.some(entry => entry.name === "ast_edit")).toBe(false);

			const listing = await read!.execute("read-xd-list", { path: "xd://" });
			expect(listing.content.find(entry => entry.type === "text")?.text).toContain("xd://ast_edit");
			const docs = await read!.execute("read-xd-docs", { path: "xd://ast_edit" });
			expect(docs.content.find(entry => entry.type === "text")?.text).toContain("# ast_edit");

			const content = JSON.stringify({
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [filePath],
			});

			// The write gate decodes the device payload and evaluates the mounted
			// tool's own approval. ast_edit is write-tier for a filesystem path.
			const approval = write!.approval;
			expect(typeof approval).toBe("function");
			if (typeof approval === "function") {
				expect(approval({ path: "xd://ast_edit", content })).toEqual({ tier: "write", policyKey: "ast_edit" });
			}

			// Execute dispatches through the xdev registry to the mounted ast_edit,
			// staging a preview (not a direct apply).
			const previewResult = await write!.execute("write-xdev-preview", { path: "xd://ast_edit", content });
			expect(previewResult.isError).toBeUndefined();
			expect(previewResult.details?.xdev?.tool).toBe("ast_edit");
			expect(previewResult.details?.xdev?.mode).toBe("execute");
			// The dispatch records the wrapped tool's approval tier so prewalk can
			// tell a mutation from a read-only device call (issue #7312).
			expect(previewResult.details?.xdev?.tier).toBe("write");
			const previewText = previewResult.content.find(entry => entry.type === "text")?.text ?? "";
			expect(previewText).toContain("modernWrap");

			// The staged preview applies through the resolve queue and rewrites disk.
			const invoker = queue.peekPendingInvoker();
			expect(invoker).toBeDefined();
			await invoker!({ action: "apply", reason: "apply xdev ast edit" });
			expect(await Bun.file(filePath).text()).toContain("modernWrap(x, value)");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("records a read tier on the dispatch of a read-only device", async () => {
		const readDevice: AgentTool = {
			name: "peek",
			label: "Peek",
			description: "Read-only device",
			parameters: type({ q: "string" }),
			approval: () => "read",
			async execute() {
				return { content: [{ type: "text", text: "peeked" }] };
			},
		};
		const xdev = createTestXdevState([readDevice]);
		const write = new WriteTool(xdevSession(process.cwd(), { xdev }));

		const result = await write.execute("write-xdev-read", { path: "xd://peek", content: JSON.stringify({ q: "x" }) });
		expect(result.isError).toBeUndefined();
		expect(result.details?.xdev).toMatchObject({ tool: "peek", mode: "execute", tier: "read" });
	});

	it("resolves device dispatches against the device's user policy, falling back to write's", async () => {
		// Like the pi-knowledge plugin in #7923: the mounted device declares no
		// approval, so it defaults to exec tier — but a device-scoped user policy
		// must still gate, and without one the dispatch must honor `write`'s policy.
		const device: AgentTool = {
			name: "knowledge_search",
			label: "Knowledge Search",
			description: "Read-only device without a tier declaration",
			parameters: type({ q: "string" }),
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const xdev = createTestXdevState([device]);
		const write = new WriteTool(xdevSession(process.cwd(), { xdev }));
		const args = { path: "xd://knowledge_search", content: JSON.stringify({ q: "x" }) };

		const approval = write.approval;
		expect(typeof approval).toBe("function");
		if (typeof approval !== "function") throw new Error("expected a function approval");
		// The gate reports the mounted tool's (default exec) tier and keys user
		// policy on the device name.
		expect(approval(args)).toEqual({ tier: "exec", policyKey: "knowledge_search" });

		// No device policy → falls back to the write tool's own policy.
		expect(resolveApproval(write, args, "always-ask", { write: "prompt" }).policy).toBe("prompt");
		expect(resolveApproval(write, args, "always-ask", { write: "allow" }).policy).toBe("allow");

		// Device-scoped allow lets the dispatch through even while the blanket
		// write policy stays prompt — the exact scenario from #7923.
		const allowed = resolveApproval(write, args, "always-ask", { write: "prompt", knowledge_search: "allow" });
		expect(allowed).toMatchObject({ policy: "allow", source: "user", policyKey: "knowledge_search" });

		// Device-scoped deny blocks the dispatch and names the device in the refusal.
		expect(() => requiresApproval(write, args, "always-ask", { knowledge_search: "deny" })).toThrow(
			'remove "tools.approval.knowledge_search: deny"',
		);

		// Device-scoped prompt forces a prompt for this device.
		expect(resolveApproval(write, args, "always-ask", { knowledge_search: "prompt" }).policy).toBe("prompt");

		// An unrelated device's policy does not leak into this dispatch.
		expect(resolveApproval(write, args, "always-ask", { other_device: "deny" }).policy).toBe("prompt");
	});

	it("records the effective tier reported after an execution decorator rewrites device args", async () => {
		let executedQuery: string | undefined;
		const device: AgentTool = {
			name: "peek",
			label: "Peek",
			description: "Argument-dependent device",
			parameters: type({ q: "string" }),
			approval: args => (args && typeof args === "object" && "q" in args && args.q === "mutate" ? "write" : "read"),
			async execute(_id, args) {
				if (!args || typeof args !== "object" || !("q" in args) || typeof args.q !== "string") {
					throw new Error("Expected a string query");
				}
				executedQuery = args.q;
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		const xdev = createTestXdevState([device]);
		xdev.decorateExecution = canonical => ({
			...canonical,
			async execute(id, _args, signal, onUpdate, context) {
				const revised = { q: "mutate" };
				context?.xdevTierResolved?.("write");
				return canonical.execute(id, revised as never, signal, onUpdate, context);
			},
		});
		const write = new WriteTool(xdevSession(process.cwd(), { xdev }));

		const result = await write.execute(
			"write-xdev-revised",
			{ path: "xd://peek", content: JSON.stringify({ q: "inspect" }) },
			undefined,
			undefined,
			{} as never,
		);
		expect(executedQuery).toBe("mutate");
		expect(result.details?.xdev?.tier).toBe("write");
	});

	it("rejects near-miss xd addresses before filesystem fallback", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-near-miss-"));
		try {
			const tools = await createTools(xdevSession(tempDir));
			const write = tools.find(entry => entry.name === "write");
			expect(write).toBeDefined();

			for (const target of ["xdt://web_search", "xd:/web_search", "xd/web_search"]) {
				await expect(write!.execute(`write-${target}`, { path: target, content: "{}" })).rejects.toThrow(
					"Did you mean 'xd://web_search'?",
				);
			}
			expect(await Bun.file(path.join(tempDir, "xdt:/web_search")).exists()).toBe(false);
			expect(await Bun.file(path.join(tempDir, "xd/web_search")).exists()).toBe(false);

			const escaped = await write!.execute("write-explicit-path", {
				path: "./xd/web_search",
				content: "intentional file",
			});
			expect(escaped.isError).toBeUndefined();
			expect(await Bun.file(path.join(tempDir, "xd/web_search")).text()).toBe("intentional file");

			// conflict:// has no router handler but is a documented write scheme —
			// the guard must let it reach the conflict resolver, not reject it.
			await expect(write!.execute("write-conflict", { path: "conflict://1", content: "x" })).rejects.toThrow(
				"Conflict #1 not found",
			);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("resolves function-valued device approvals per payload and fails closed on bad content", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-approval-"));
		try {
			const filePath = path.join(tempDir, "target.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");
			const tools = await createTools(xdevSession(tempDir));
			const write = tools.find(entry => entry.name === "write");
			expect(write).toBeDefined();
			const approval = write!.approval;
			expect(typeof approval).toBe("function");
			if (typeof approval !== "function") throw new Error("expected a function approval");
			const tier = (path: string, content: string) => approval({ path, content });

			// ast_edit on a filesystem path → write; on internal URLs only → read.
			const astFsPath = JSON.stringify({
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [filePath],
			});
			const astInternalPath = JSON.stringify({
				ops: [{ pat: "a", out: "b" }],
				paths: ["artifact://abc"],
			});
			expect(tier("xd://ast_edit", astFsPath)).toEqual({ tier: "write", policyKey: "ast_edit" });
			expect(tier("xd://ast_edit", astInternalPath)).toEqual({ tier: "read", policyKey: "ast_edit" });

			// debug: inspection action → read; a real launch → exec (control).
			expect(tier("xd://debug", JSON.stringify({ action: "sessions" }))).toEqual({
				tier: "read",
				policyKey: "debug",
			});
			expect(tier("xd://debug", JSON.stringify({ action: "launch", program: "./app" }))).toEqual({
				tier: "exec",
				policyKey: "debug",
			});

			// Fail closed: malformed JSON, non-object or schema-invalid payloads,
			// missing content, and unknown devices all stay exec so the gate never
			// under-prompts.
			expect(tier("xd://ast_edit", "{ not json")).toBe("exec");
			expect(tier("xd://ast_edit", "[1,2,3]")).toBe("exec");
			expect(tier("xd://ast_edit", '"a string"')).toBe("exec");
			expect(tier("xd://ast_edit", JSON.stringify({ paths: [null] }))).toBe("exec");
			expect(approval({ path: "xd://ast_edit" })).toBe("exec");
			expect(tier("xd://no_such_device", "{}")).toBe("exec");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("renderCall withholds a partial xd:// URL, then queues until execution starts", async () => {
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		const options = { expanded: false, isPartial: true };

		const content = JSON.stringify({
			ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
			paths: ["/tmp/legacy.ts"],
		});

		// Path still streaming (no content field yet): render nothing so the user
		// never sees a half-typed "xd://ast_" frame.
		expect(writeToolRenderer.renderCall({ path: "xd://ast_e" }, options, uiTheme)).toBeUndefined();

		// Path settled + content streaming, but the write has not executed yet:
		// show a queued card instead of the inner tool's in-flight renderer.
		const queued = writeToolRenderer.renderCall({ path: "xd://ast_edit", content }, options, uiTheme);
		expect(queued).toBeDefined();
		const queuedText = Bun.stripANSI(queued!.render(80).join("\n"));
		expect(queuedText).toContain("queued");
		expect(queuedText).toContain("ast_edit");

		// Args can be final at message_end while an earlier exclusive write still
		// runs — keep the queued card until this call's tool_execution_start.
		const argsCompleteOnly = writeToolRenderer.renderCall(
			{ path: "xd://ast_edit", content },
			{ ...options, argsComplete: true },
			uiTheme,
		);
		expect(Bun.stripANSI(argsCompleteOnly!.render(80).join("\n"))).toContain("queued");

		// Same payload after tool_execution_start: delegate to the inner renderer
		// instead of throwing ReferenceError inside a generic Write frame.
		const executing = writeToolRenderer.renderCall(
			{ path: "xd://ast_edit", content },
			{ ...options, argsComplete: true, executionStarted: true },
			uiTheme,
		);
		expect(executing).toBeDefined();
		const executingText = Bun.stripANSI(executing!.render(80).join("\n"));
		expect(executingText).not.toContain("queued");
	});

	it("renders streamed MCP device writes as queued until execution starts", async () => {
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		const content = JSON.stringify({
			action: "grep_all",
			pattern: "Broken",
			scope: "game.StarterPlayer",
			studio: "AED Content Development",
			maxResults: 20,
		});
		const queued = writeToolRenderer.renderCall(
			{ path: "xd://mcp__ecoport_search", content },
			{ expanded: false, isPartial: true },
			uiTheme,
		);
		expect(queued).toBeDefined();
		const queuedText = Bun.stripANSI(queued!.render(120).join("\n"));
		expect(queuedText).toContain("queued");
		expect(queuedText).toContain("ecoport/search");
		expect(queuedText).toContain("Broken");
	});

	it("renders device execution errors as the mounted tool instead of write", async () => {
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");

		const githubDevice = {
			name: "github",
			label: "GitHub",
			description: "fixture",
			parameters: type({ op: "string" }),
			...githubToolRenderer,
			async execute() {
				throw new ToolError("gh: Not Found (HTTP 404)");
			},
		};
		const xdev = createTestXdevState([githubDevice]);
		const write = new WriteTool(xdevSession(process.cwd(), { xdev }));
		const content = JSON.stringify({ op: "repo_view" });

		const result = await write.execute("write-xdev-error", { path: "xd://github", content });
		expect(result.isError).toBe(true);
		expect(result.details?.xdev).toMatchObject({
			tool: "github",
			mode: "execute",
			args: { op: "repo_view" },
		});

		const component = writeToolRenderer.renderResult(
			result,
			{
				expanded: false,
				isPartial: false,
				renderContext: { resolveXdevMounted: name => resolveMountedXdevTool(xdev, name) },
			},
			uiTheme,
			{ path: "xd://github", content },
		);
		const rendered = Bun.stripANSI(component.render(80).join("\n"));
		expect(rendered).toContain("GitHub Repo");
		expect(rendered).toContain("gh: Not Found (HTTP 404)");
		expect(rendered).not.toContain("Write");
	});

	it("keeps the generic custom-tool card when a mounted device has no renderer", async () => {
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");

		const weatherDevice: AgentTool = {
			name: "weather",
			label: "Weather",
			description: "Gets the weather",
			parameters: type({ query: "string" }),
			async execute() {
				return { content: [{ type: "text", text: "Tokyo: 22°C" }] };
			},
		};
		const xdev = createTestXdevState([weatherDevice]);
		const write = new WriteTool(xdevSession(process.cwd(), { xdev }));
		const content = JSON.stringify({ query: "Tokyo" });
		const result = await write.execute("write-xdev-default-renderer", {
			path: "xd://weather",
			content,
		});

		const component = writeToolRenderer.renderResult(
			result,
			{
				expanded: false,
				isPartial: false,
				renderContext: { resolveXdevMounted: name => resolveMountedXdevTool(xdev, name) },
			},
			uiTheme,
			{ path: "xd://weather", content },
		);
		const lines = component.render(80);
		const rendered = Bun.stripANSI(lines.join("\n"));
		const backgroundProbe = uiTheme.bg("toolSuccessBg", "|");
		const backgroundPrefix = backgroundProbe.slice(0, backgroundProbe.indexOf("|"));

		expect(rendered).toContain("Weather");
		expect(rendered).toContain('query="Tokyo"');
		expect(rendered).toContain("Tokyo: 22°C");
		expect(backgroundPrefix).not.toBe("");
		expect(lines.some(line => line.includes(backgroundPrefix))).toBe(true);
	});

	// Dynamic device summaries are third-party text inlined into the system
	// prompt. A character bound is not a byte bound: a multi-byte summary passes
	// several times the intended budget, and cutting a byte budget by character
	// index splits code points.
	it("bounds dynamic device summaries in UTF-8 bytes on a code point boundary", () => {
		const multiByteTail = "あ".repeat(XDEV_EXTERNAL_DESCRIPTION_CAP);
		const dynamicDevice: AgentTool = {
			name: "mcp__weather__forecast",
			label: "Forecast",
			description: "Weather forecast for a place.",
			summary: `Napoved\u0007\u2028vremena ${multiByteTail}`,
			parameters: type({ query: "string" }),
			async execute() {
				return { content: [{ type: "text", text: "" }] };
			},
		};
		const builtInDevice: AgentTool = {
			name: "weather",
			label: "Weather",
			description: "Weather for a place.",
			summary: `Gets the weather ${multiByteTail}`,
			parameters: type({ query: "string" }),
			async execute() {
				return { content: [{ type: "text", text: "" }] };
			},
		};
		const xdev = createTestXdevState([builtInDevice, dynamicDevice], ["weather"]);
		const entries = new Map(xdevEntries(xdev).map(entry => [entry.name, entry]));

		const dynamic = entries.get("mcp__weather__forecast");
		if (!dynamic) throw new Error("expected the dynamic device entry");
		expect(dynamic.dynamic).toBe(true);
		// Control characters and Unicode line separators collapse to a space
		// instead of reaching the prompt.
		expect(dynamic.summary.startsWith("Napoved vremena ")).toBe(true);
		expect(dynamic.summary.endsWith("…")).toBe(true);

		const body = dynamic.summary.slice(0, -1);
		const bodyBytes = Buffer.byteLength(body, "utf-8");
		const summaryBytes = Buffer.byteLength(dynamic.summary, "utf-8");
		expect(summaryBytes).toBeLessThanOrEqual(XDEV_EXTERNAL_DESCRIPTION_CAP);
		// The ellipsis is inside the byte budget, and the cut backs off at most
		// one code point rather than splitting the character at the boundary.
		expect(bodyBytes).toBeLessThanOrEqual(XDEV_EXTERNAL_DESCRIPTION_CAP - Buffer.byteLength("…", "utf-8"));
		expect(bodyBytes).toBeGreaterThan(XDEV_EXTERNAL_DESCRIPTION_CAP - 6);
		expect(body.endsWith("あ")).toBe(true);
		// A split code point would decode to U+FFFD and fail the round trip.
		expect(Buffer.from(body, "utf-8").toString("utf-8")).toBe(body);

		// The same boolean drives the cap and the flag, so a built-in device is
		// never capped and never reported as untrusted.
		const builtIn = entries.get("weather");
		if (!builtIn) throw new Error("expected the built-in device entry");
		expect(builtIn.dynamic).toBe(false);
		expect(builtIn.summary).toBe(`Gets the weather ${multiByteTail}`);
	});

	it("docsAll inlines small device docs and falls back to a listing past the caps", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-docs-"));
		try {
			const session = xdevSession(tempDir);
			expect(session.settings.get("tools.xdevDocs")).toBe("builtins");
			await createTools(session);
			const xdev = session.xdev;
			if (!xdev) throw new Error("expected xdev state");
			const mounted = listXdevTools(xdev);
			expect(mounted.length).toBeGreaterThan(0);

			// One device with a pathological description must fall back to the
			// listing without starving the rest of the catalog.
			const giant = Object.create(mounted[0]!) as (typeof mounted)[number];
			Object.defineProperty(giant, "name", { value: "giant_mcp_tool" });
			Object.defineProperty(giant, "description", { value: "x".repeat(XDEV_DOCS_PER_DEVICE_CAP + 1) });
			xdev.tools.set(giant.name, giant);
			xdev.mountedNames.add(giant.name);
			xdev.builtInNames.add(giant.name);

			const docs = xdevDocsAll(xdev);
			expect(docs.length).toBeLessThan(XDEV_DOCS_TOTAL_BUDGET + XDEV_DOCS_PER_DEVICE_CAP);
			expect(docs).toContain(`## ${mounted[0]!.name}`);
			expect(docs).toContain("## Additional devices (docs on demand)");
			expect(docs).toContain("- xd://giant_mcp_tool —");
			expect(docs).not.toContain("## giant_mcp_tool");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("docsAll supports inline, builtins, and catalog prompt modes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-external-"));
		try {
			const session = xdevSession(tempDir);
			expect(session.settings.get("tools.xdevDocs")).toBe("builtins");
			await createTools(session);
			const xdev = session.xdev;
			if (!xdev) throw new Error("expected xdev state");
			const mounted = listXdevTools(xdev);
			const builtInMountedNames = [...xdev.mountedNames];

			const longDescription = `LEDE ${"y".repeat(XDEV_EXTERNAL_DESCRIPTION_CAP * 3)} TAIL`;
			const external = Object.create(mounted[0]!) as (typeof mounted)[number];
			Object.defineProperty(external, "name", { value: "mcp_external_tool" });
			Object.defineProperty(external, "description", { value: longDescription });
			Object.defineProperty(external, "summary", {
				value: `SUMMARY ${"z".repeat(XDEV_EXTERNAL_DESCRIPTION_CAP * 3)} TAIL`,
			});
			xdev.tools.set(external.name, external);
			xdev.mountedNames.add(external.name);

			const inlineDocs = xdevDocsAll(xdev, "inline");
			expect(inlineDocs).toContain("## mcp_external_tool");
			expect(inlineDocs).toContain("LEDE ");
			expect(inlineDocs).not.toContain("TAIL");
			expect(inlineDocs).toContain("… (full docs: read xd://mcp_external_tool)");

			const builtinsDocs = xdevDocsAll(xdev, "builtins");
			expect(builtinsDocs).toContain("## ");
			expect(builtinsDocs).not.toContain("## mcp_external_tool");
			expect(builtinsDocs).toContain("- xd://mcp_external_tool —");
			expect(builtinsDocs).not.toContain("TAIL");
			const catalogDocs = xdevDocsAll(xdev, "catalog");
			expect(catalogDocs).not.toContain(`## ${mounted[0]!.name}`);
			expect(catalogDocs).toContain("- xd://");
			expect(catalogDocs).toContain("- xd://mcp_external_tool —");
			expect(xdevDocs(xdev, "mcp_external_tool")).toContain("TAIL");

			const contextMode = Object.create(mounted[0]!) as (typeof mounted)[number];
			Object.defineProperty(contextMode, "name", { value: "mcp__context_mode_ctx_execute" });
			const unrelatedMcp = Object.create(mounted[0]!) as (typeof mounted)[number];
			Object.defineProperty(unrelatedMcp, "name", { value: "mcp__other_server_execute" });
			xdev.tools.set(contextMode.name, contextMode);
			xdev.tools.set(unrelatedMcp.name, unrelatedMcp);
			xdev.mountedNames.clear();
			for (const name of [...builtInMountedNames, contextMode.name, unrelatedMcp.name]) xdev.mountedNames.add(name);

			const allowlistedDocs = xdevDocsAll(xdev, "builtins", ["mcp__context_mode_*"]);
			expect(allowlistedDocs).toContain("## mcp__context_mode_ctx_execute");
			expect(allowlistedDocs).not.toContain("## mcp__other_server_execute");
			expect(allowlistedDocs).toContain("- xd://mcp__other_server_execute —");

			const catalogWithAllowlistDocs = xdevDocsAll(xdev, "catalog", ["mcp__context_mode_*"]);
			expect(catalogWithAllowlistDocs).not.toContain("## mcp__context_mode_ctx_execute");

			// Malformed user config (scalar or non-string entries reach the
			// registry unvalidated) degrades to the catalog listing instead of
			// throwing while the system prompt is built.
			const scalarAllowlistDocs = xdevDocsAll(xdev, "builtins", "mcp__context_mode_*" as never);
			expect(scalarAllowlistDocs).toContain("- xd://mcp__context_mode_ctx_execute —");
			const nonStringAllowlistDocs = xdevDocsAll(xdev, "builtins", [123] as never);
			expect(nonStringAllowlistDocs).toContain("- xd://mcp__context_mode_ctx_execute —");
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});

describe("web_search stays top-level under xdev", () => {
	it("keeps web_search direct and out of the mounted-name set with default config", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-websearch-"));
		try {
			const session = xdevSession(tempDir);
			// Default config: tools.xdev is on.
			expect(session.settings.get("tools.xdev")).toBe(true);
			const tools = await createTools(session);
			// Regression for #5973: models call web_search directly, so it must
			// remain a top-level function and never mount behind the xd:// device.
			expect(tools.some(entry => entry.name === "web_search")).toBe(true);
			const mounted = session.xdev ? [...session.xdev.mountedNames] : [];
			expect(mounted).not.toContain("web_search");

			const write = tools.find(tool => tool.name === "write");
			const read = tools.find(tool => tool.name === "read");
			expect(write).toBeDefined();
			expect(read).toBeDefined();

			const docs = await read!.execute("read-xdev-web-search", { path: "xd://web_search" });
			expect(docs.content.find(entry => entry.type === "text")?.text).toContain("# web_search");

			// Missing required args fails schema validation after routing to web_search,
			// rather than failing lookup because the tool is top-level.
			const dispatched = await write!.execute("write-xdev-web-search", {
				path: "xd://web_search",
				content: "{}",
			});
			expect(dispatched.isError).toBe(true);
			expect(dispatched.details?.xdev?.tool).toBe("web_search");
			expect(dispatched.content.find(entry => entry.type === "text")?.text).not.toContain("No such tool");
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});

describe("xd:// and top-level calls share the canonical tool map", () => {
	it("dispatches and documents an unmounted top-level tool, and still rejects unknown names", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-fallback-"));
		try {
			await Bun.write(path.join(tempDir, "haystack.txt"), "alpha\nfallback-needle\nomega\n");
			const session = xdevSession(tempDir);
			const tools = await createTools(session);
			const write = tools.find(entry => entry.name === "write");
			const read = tools.find(entry => entry.name === "read");
			expect(write).toBeDefined();
			expect(read).toBeDefined();

			// grep is kept top-level (XDEV_KEEP_TOP_LEVEL) and thus not a mounted
			// device — the unified namespace must still dispatch it via xd://.
			const mounted = [...session.xdev!.mountedNames];
			expect(mounted).not.toContain("grep");

			const dispatched = await write!.execute("write-xdev-fallback-grep", {
				path: "xd://grep",
				content: JSON.stringify({ pattern: "fallback-needle", path: tempDir }),
			});
			expect(dispatched.isError).toBeUndefined();
			expect(dispatched.details?.xdev?.tool).toBe("grep");
			expect(dispatched.content.find(entry => entry.type === "text")?.text).toContain("fallback-needle");

			// Docs resolve through the same fallback.
			const docs = await read!.execute("read-xdev-fallback-grep", { path: "xd://grep" });
			expect(docs.content.find(entry => entry.type === "text")?.text).toContain("# grep");

			// Genuinely unknown names still fail with the catalog error.
			const unknown = await write!.execute("write-xdev-fallback-unknown", {
				path: "xd://no_such_tool",
				content: "{}",
			});
			expect(unknown.isError).toBe(true);
			expect(unknown.content.find(entry => entry.type === "text")?.text).toContain(
				"No such tool: xd://no_such_tool",
			);
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});

describe("device-only write transport for explicit lists omitting write", () => {
	it("grants a device-only write so xd:// state is allocated, and rejects filesystem writes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-device-only-"));
		try {
			const session = xdevSession(tempDir);
			const tools = await createTools(session, ["read", "grep"]);

			// The device-only grant: write joins the set purely as the xd://
			// execution transport, and xd:// state is allocated for mounting.
			const write = tools.find(entry => entry.name === "write");
			expect(write).toBeDefined();
			expect(session.deviceOnlyWrite).toBe(true);
			expect(session.xdev).toBeDefined();

			// Filesystem writes are rejected before any handler or guard runs.
			await expect(
				write!.execute("write-device-only-fs", { path: path.join(tempDir, "nope.txt"), content: "x" }),
			).rejects.toThrow("Filesystem writes are not available");

			// Device dispatch still flows: an unknown device reaches the router and
			// fails there, not at the transport guard.
			const unknown = await write!.execute("write-device-only-unknown", {
				path: "xd://no_such_tool",
				content: "{}",
			});
			expect(unknown.isError).toBe(true);
			expect(unknown.details?.xdev?.tool).toBe("no_such_tool");
			expect(unknown.content.find(entry => entry.type === "text")?.text).toContain(
				"No such tool: xd://no_such_tool",
			);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("previews the full-write description without relaxing device-only execution", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-pending-full-"));
		try {
			const session = xdevSession(tempDir);
			const tools = await createTools(session, ["read"]);
			const write = tools.find(entry => entry.name === "write");
			expect(write).toBeDefined();

			const restrictedDescription = write!.description;
			session.pendingFullWriteDescription = true;
			expect(write!.description).not.toBe(restrictedDescription);
			await expect(
				write!.execute("write-pending-full-fs", { path: path.join(tempDir, "nope.txt"), content: "x" }),
			).rejects.toThrow("Filesystem writes are not available");
			expect(await Bun.file(path.join(tempDir, "nope.txt")).exists()).toBe(false);

			session.pendingFullWriteDescription = undefined;
			expect(write!.description).toBe(restrictedDescription);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("allows only the local sandbox while plan mode is active", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-plan-guard-"));
		try {
			const getArtifactsDir = () => path.join(tempDir, "artifacts");
			const getSessionId = () => "device-only-plan";
			const session = xdevSession(tempDir, {
				enableLsp: false,
				getArtifactsDir,
				getSessionId,
				localProtocolOptions: { getArtifactsDir, getSessionId },
				getPlanModeState: () => ({ enabled: true, planFilePath: "local://review-plan.md" }),
			});
			const tools = await createTools(session, ["read"]);
			const read = tools.find(entry => entry.name === "read");
			const write = tools.find(entry => entry.name === "write");
			expect(read).toBeDefined();
			expect(write).toBeDefined();

			const planWrite = await write!.execute("write-device-only-plan-local", {
				path: "local://review-plan.md",
				content: "plan draft\n",
			});
			expect(planWrite.isError).toBeUndefined();
			const planRead = await read!.execute("read-device-only-plan-local", {
				path: "local://review-plan.md",
			});
			expect(planRead.content.find(entry => entry.type === "text")?.text).toContain("plan draft");

			// conflict:// resolves to a recorded working-tree file. Device-only
			// access must reject it before the conflict resolver can mutate it.
			await expect(
				write!.execute("write-device-only-plan-conflict", {
					path: "conflict://1",
					content: "@ours",
				}),
			).rejects.toThrow("Filesystem writes are not available");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("keeps a real write grant full-access (no device-only restriction)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-full-grant-"));
		try {
			const session = xdevSession(tempDir);
			const tools = await createTools(session, ["read", "grep", "write"]);
			expect(session.deviceOnlyWrite).toBeUndefined();
			const write = tools.find(entry => entry.name === "write");

			const filePath = path.join(tempDir, "ok.txt");
			const result = await write!.execute("write-full-grant", { path: filePath, content: "hello\n" });
			expect(result.isError).toBeUndefined();
			expect(await Bun.file(filePath).text()).toBe("hello\n");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("upgrades a device-only transport when a later call explicitly grants write", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-upgrade-grant-"));
		try {
			const session = xdevSession(tempDir);
			await createTools(session, ["read"]);
			expect(session.deviceOnlyWrite).toBe(true);

			const tools = await createTools(session, ["write"]);
			expect(session.deviceOnlyWrite).toBeUndefined();
			const write = tools.find(entry => entry.name === "write");

			const filePath = path.join(tempDir, "upgraded.txt");
			await write!.execute("write-upgraded-grant", { path: filePath, content: "upgraded\n" });
			expect(await Bun.file(filePath).text()).toBe("upgraded\n");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("does not grant a transport write when read is also omitted", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-no-transport-"));
		try {
			const session = xdevSession(tempDir);
			const tools = await createTools(session, ["grep", "glob"]);
			expect(tools.some(entry => entry.name === "write")).toBe(false);
			expect(session.deviceOnlyWrite).toBeUndefined();
			expect(session.xdev).toBeUndefined();
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
