import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager, setKeyHintPlatform } from "@oh-my-pi/pi-tui/app-keybindings";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { MCPAddWizard, type MCPAddWizardConfig, type MCPAddWizardDeps } from "@oh-my-pi/pi-tui/overlays/mcp-add-wizard";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

const CX: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
const ENTER = "\r";
const DOWN = "\x1b[B";

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child && typeof child.k === "string";
}

/** Every described node under `root`, depth first. */
function nodes(root: NativeNode): NativeNode[] {
	const out: NativeNode[] = [root];
	for (const child of root.c ?? []) if (isNode(child)) out.push(...nodes(child));
	return out;
}

/** A described prop, whatever the node's kind. */
function prop(node: NativeNode | undefined, key: string): unknown {
	const props: unknown = node?.p;
	if (!props || typeof props !== "object") return undefined;
	const value: unknown = Reflect.get(props, key);
	return value;
}

function byRole(wizard: MCPAddWizard, role: string): NativeNode[] {
	return nodes(wizard.describe(CX)).filter(n => prop(n, "role") === role);
}

/** Plain text of a string or a span list. */
function plain(text: unknown): string {
	if (typeof text === "string") return text;
	if (!Array.isArray(text)) return "";
	return text.map(span => (span && typeof span === "object" && "t" in span ? String(span.t) : "")).join("");
}

function title(wizard: MCPAddWizard): string {
	const [node] = byRole(wizard, "omp.mcpAdd.title");
	return plain(prop(node, "text") ?? prop(node, "spans"));
}

/** Footer buttons by their tooltips (`Label  key`). */
function buttons(wizard: MCPAddWizard): unknown[] {
	return byRole(wizard, "omp.btn").map(b => prop(b, "title"));
}

/** Phase tones of the progress strip, in order. */
function phases(wizard: MCPAddWizard): unknown[] {
	return byRole(wizard, "omp.mcpAdd.phase").map(p => prop(p, "tone"));
}

function act(wizard: MCPAddWizard, name: string): void {
	wizard.handleNativeEvent({ type: "action", key: `sheet/actions/${name}`, act: name, mods: [] });
}

function type(wizard: MCPAddWizard, text: string): void {
	for (const ch of text) wizard.handleInput(ch);
}

const deps: MCPAddWizardDeps = {
	validateServerName: name => (/^[\w.:-]+$/.test(name) ? undefined : "Use letters, numbers, dash or underscore"),
	analyzeAuthError: () => ({ requiresAuth: false }),
	discoverOAuthEndpoints: async () => null,
	fetchResourceMetadataScopes: async () => undefined,
};

describe("MCP add wizard under a native surface", () => {
	beforeAll(async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("dark theme unavailable");
		setThemeInstance(dark);
	});

	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "escape" }));
		setNativeRendering(true);
		// Tooltip keycaps are platform-aware (`⌃C` on macOS, `Ctrl+C` elsewhere).
		setKeyHintPlatform("darwin");
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		setNativeRendering(false);
		setKeyHintPlatform(undefined);
	});

	it("names the step, lights its phase, and keeps keys in the footer buttons' tooltips", () => {
		const wizard = new MCPAddWizard(deps, vi.fn(), vi.fn());
		expect(title(wizard)).toBe("Name the server");
		expect(phases(wizard)).toEqual(["accent", "muted", "muted", "muted", "muted", "muted"]);
		// The first step has no Back: Esc cancels, so Cancel carries it.
		expect(buttons(wizard)).toEqual(["Cancel  esc", "Continue  ⏎"]);
		for (const button of byRole(wizard, "omp.btn")) {
			expect((button.c ?? []).filter(isNode).map(child => child.k)).toEqual(["text", "kbd"]);
		}
	});

	it("Continue submits the field as Enter does; a refused value stays in the field with the reason", () => {
		const wizard = new MCPAddWizard(deps, vi.fn(), vi.fn());
		type(wizard, "bad name");
		act(wizard, "next");
		expect(title(wizard)).toBe("Name the server");
		const [field] = byRole(wizard, "omp.mcpAdd.field");
		expect(prop(field, "tone")).toBe("error");
		expect(plain(prop(byRole(wizard, "omp.mcpAdd.note")[0], "spans"))).toContain("Use letters");
		const input = field?.c?.[0];
		expect(input && "getValue" in input && typeof input.getValue === "function" ? input.getValue() : "").toBe(
			"bad name",
		);

		for (let i = 0; i < 8; i++) wizard.handleInput("\x7f");
		type(wizard, "linear");
		act(wizard, "next");
		expect(title(wizard)).toBe("How does omp reach it?");
		expect(phases(wizard).slice(0, 2)).toEqual(["success", "accent"]);
		expect(buttons(wizard)).toEqual(["Cancel  ⌃C", "Back  esc", "Continue  ⏎"]);
	});

	it("lists transports with their mono tags; arrows, a click and Continue all choose", () => {
		const wizard = new MCPAddWizard(deps, vi.fn(), vi.fn(), undefined, undefined, undefined, "linear");
		const items = nodes(wizard.describe(CX)).filter(n => n.k === "item");
		expect(items.map(item => plain(prop(item, "value")))).toEqual(["stdio", "http", "sse"]);

		wizard.handleInput(DOWN);
		expect(prop(byRole(wizard, "omp.mcpAdd.choices")[0], "selected")).toBe("1");
		act(wizard, "next");
		expect(title(wizard)).toBe("Server URL");

		act(wizard, "back");
		expect(title(wizard)).toBe("How does omp reach it?");
		wizard.handleNativeEvent({ type: "select", key: "sheet/choices-transport", item: "0" });
		expect(title(wizard)).toBe("Command");
	});

	it("pastes the server URL into the connection test instead of leaving the field empty", () => {
		const onTest = vi.fn(async (_config: MCPAddWizardConfig) => {});
		const wizard = new MCPAddWizard(deps, vi.fn(), vi.fn(), undefined, onTest, undefined, "linear");
		wizard.handleInput(DOWN);
		wizard.handleInput(ENTER);
		wizard.pasteText("https://mcp.linear.app/mcp");
		wizard.handleInput(ENTER);

		expect(onTest).toHaveBeenCalledWith(expect.objectContaining({ type: "http", url: "https://mcp.linear.app/mcp" }));
	});

	it("shows the connection test while it runs and ignores its result once the user stepped back", async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const wizard = new MCPAddWizard(deps, vi.fn(), vi.fn(), undefined, () => promise, undefined, "linear");
		wizard.handleInput(DOWN);
		wizard.handleInput(ENTER);
		type(wizard, "https://mcp.linear.app/mcp");
		wizard.handleInput(ENTER);
		expect(title(wizard)).toBe("Trying the connection");
		expect(byRole(wizard, "omp.mcpAdd.status")).toHaveLength(1);
		expect(buttons(wizard)).toEqual(["Cancel  ⌃C", "Back  esc"]);

		act(wizard, "back");
		resolve();
		// The wizard's continuation was queued on the test before this await's, so it has run.
		await promise;
		expect(title(wizard)).toBe("How does omp reach it?");
	});

	it("reviews the server and saves it on Enter", () => {
		const onComplete = vi.fn<(name: string, config: MCPAddWizardConfig, scope: "user" | "project") => void>();
		const wizard = new MCPAddWizard(deps, onComplete, vi.fn(), undefined, undefined, undefined, "github");
		wizard.handleInput(ENTER); // stdio
		type(wizard, "npx");
		wizard.handleInput(ENTER);
		type(wizard, "-y @modelcontextprotocol/server-github");
		wizard.handleInput(ENTER); // no connection test: on to the scope
		expect(title(wizard)).toBe("Where should it live?");
		wizard.handleInput(DOWN);
		wizard.handleInput(ENTER);

		expect(title(wizard)).toBe("Review and save");
		expect(phases(wizard)).toEqual(["success", "success", "success", "neutral", "success", "accent"]);
		const rows = prop(byRole(wizard, "omp.mcpAdd.summary")[0], "items");
		expect(
			Array.isArray(rows) ? rows.map(row => (row && typeof row === "object" && "k" in row ? row.k : "")) : [],
		).toEqual(["Name", "Transport", "Command", "Arguments", "Auth", "Saved in"]);
		expect(buttons(wizard)).toEqual(["Cancel  ⌃C", "Back  esc", "Save server  ⏎"]);

		const ansi = stripVTControlCharacters(wizard.render(80).join("\n"));
		expect(ansi).toContain("Review  6/6");
		expect(ansi).toContain("Save this configuration?");

		wizard.handleInput(DOWN); // nothing to choose on the review
		wizard.handleInput(ENTER);
		expect(onComplete).toHaveBeenCalledWith(
			"github",
			{ type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
			"project",
		);
	});
});
