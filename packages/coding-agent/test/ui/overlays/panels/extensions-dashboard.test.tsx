/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal, type UiEvent } from "@oh-my-pi/pi-tui";
import { corpusEnvironment } from "@oh-my-pi/pi-tui/testing/corpus";
import type { ExtensionDashboardRuntime } from "../../../../src/extensibility/inventory/extension-dashboard";
import type {
	MCPConnectionDisplay,
	MCPRuntimeSource,
	MCPServerDisplay,
} from "../../../../src/extensibility/inventory/mcp-runtime";
import type { Extension, ExtensionProvider } from "../../../../src/extensibility/inventory/types";
import { ExtensionInspectorModel } from "../../../../src/ui/overlays/panels/extension-inspector-model";
import { ExtensionListModel } from "../../../../src/ui/overlays/panels/extension-list-model";
import type { ToolRuntimeSource } from "../../../../src/ui/overlays/panels/extensions-data";
import {
	ExtensionDashboard,
	ExtensionInspectorView,
	ExtensionListView,
} from "../../../../src/ui/overlays/panels/extensions-dashboard";
import { ExtensionDashboardModel } from "../../../../src/ui/overlays/panels/extensions-dashboard-model";
import { type Driver, type Mounted, panelSuite } from "./harness";

// ─── Fixtures (the corpus builder's inventory) ──────────────────────────────

const src = (provider = "native", providerName = "OMP", level: "user" | "project" | "native" = "user") => ({
	provider,
	providerName,
	level,
});

const githubServer = {
	name: "github",
	command: "/usr/bin/github-mcp-server",
	args: ["stdio"],
	transport: "stdio",
	_source: {
		provider: "native",
		providerName: "OMP (User)",
		path: "/home/sf/.omp/agent/mcp.json",
		level: "user" as const,
	},
} satisfies MCPServerDisplay;

function mcpExt(state: Extension["state"] = "active", name = "github"): Extension {
	return {
		id: `mcp:${name}`,
		kind: "mcp",
		name,
		displayName: name,
		path: githubServer._source.path,
		source: { provider: "native", providerName: "OMP (User)", level: "user" },
		state,
		raw: { ...githubServer, name },
	};
}

function mcpSource(status: "connected" | "connecting" | "disconnected" = "connected", many = false): MCPRuntimeSource {
	const tools = [
		{
			name: "search_code",
			description: "Search code across GitHub repositories.\nSecond line of description.",
			inputSchema: {
				type: "object",
				required: ["query"],
				properties: {
					query: { type: "string", description: "Search query" },
					language: { type: "string" },
					page: { type: "number" },
					perPage: { type: "number" },
				},
			},
		},
		{
			name: "create_issue",
			title: "Create Issue",
			description: "Create a new issue in a repository.",
			inputSchema: {
				type: "object",
				required: ["title"],
				properties: { title: { type: "string", description: "Issue title" } },
			},
		},
		...(many
			? Array.from({ length: 12 }, (_, i) => ({
					name: `tool_${i}`,
					description: `Tool ${i}`,
					inputSchema: { type: "object", properties: {} },
				}))
			: []),
	];
	const prompts = many ? Array.from({ length: 7 }, (_, i) => ({ name: `prompt_${i}` })) : [];
	const conn = {
		name: "github",
		config: { command: "/usr/bin/github-mcp-server", args: ["stdio"], env: { A: "1", B: "2" } },
		serverInfo: {
			name: "github-mcp-server",
			title: "GitHub MCP Server",
			version: "0.19.0",
			description:
				"Access GitHub repositories, issues, and pull requests. This description is long enough to wrap over several lines when the inspector is narrow, and then some more words.",
			websiteUrl: "https://github.com/github/github-mcp-server",
		},
		tools,
		resources: Array.from({ length: many ? 9 : 1 }, (_, i) => ({ uri: `github://repo${i}`, name: `repo${i}` })),
		prompts,
		instructions: "Prefer search_code over cloning.",
	} as unknown as MCPConnectionDisplay;
	return {
		getConnectionStatus: () => status,
		getConnection: () => (status === "connected" ? conn : undefined),
		getTools: () =>
			tools.map(tool => ({ mcpServerName: "github", mcpToolName: tool.name, description: tool.description })),
		getServerResources: () => ({ resources: conn.resources ?? [], templates: [] }),
		getServerPrompts: () => prompts,
	};
}

const toolSource: ToolRuntimeSource = {
	getLiveTool: (name: string) =>
		name === "gmail_send"
			? {
					name: "gmail_send",
					hidden: true,
					parameters: {
						type: "object",
						required: ["to"],
						properties: { to: { type: "string", description: "Recipient" }, subject: { type: "string" } },
					},
				}
			: undefined,
	listLiveTools: () => [{ name: "gmail_send", hidden: true }],
};

function extensions(): Extension[] {
	const longDesc =
		"A very long description that goes on and on — 日本語のテキスト and emoji 🎉 — to exercise wrapping and truncation at narrow widths.";
	return [
		{
			id: "skill:alpha",
			kind: "skill",
			name: "alpha",
			displayName: "alpha",
			description: longDesc,
			path: "/home/u/.omp/skills/alpha/SKILL.md",
			source: src(),
			state: "active",
			raw: {
				content: `# Alpha\n\n- one\n- two\n1. first\n\`\`\`ts\ncode\n\`\`\`\n${"line\n".repeat(40)}`,
				frontmatter: { globs: ["src/**/*.ts"], alwaysApply: true },
			},
		},
		{
			id: "skill:beta",
			kind: "skill",
			name: "beta",
			displayName: "béta ünïcode 名前",
			path: "/home/u/.omp/skills/beta/SKILL.md",
			source: src("claude", "Claude Code", "project"),
			state: "disabled",
			disabledReason: "item-disabled",
			raw: { content: "", frontmatter: { hide: true } },
		},
		{
			id: "rule:dirty",
			kind: "rule",
			name: "dirty",
			displayName: "dirty",
			path: "/tmp/dirty.md",
			trigger: "src/**/*.ts\nextra",
			source: src("native", "Native", "native"),
			state: "active",
			raw: {
				content: "rule body",
				condition: ["a", "b", "c", "d", "e", "f"],
				globs: ["*.ts", "*.tsx"],
				scope: ["x"],
				alwaysApply: false,
			},
		},
		{
			id: "slash-command:deploy",
			kind: "slash-command",
			name: "deploy",
			displayName: "deploy",
			description: "Deploy things",
			path: "/home/u/.omp/commands/deploy.md",
			source: src("claude", "Claude Code"),
			state: "active",
			raw: { content: "---\nargument-hint: <env>\n---\nDeploy $ARGUMENTS now" },
		},
		{
			id: "tool:gmail_send",
			kind: "tool",
			name: "gmail_send",
			displayName: "gmail_send",
			description: "gmail_send custom tool",
			path: "/home/u/.omp/tools/gmail_send.ts",
			source: src(),
			state: "active",
			raw: { name: "gmail_send", path: "/home/u/.omp/tools/gmail_send.ts" },
		},
		{
			id: "hook:pre",
			kind: "hook",
			name: "pre",
			displayName: "pre",
			path: "/home/u/.omp/hooks/pre.ts",
			source: src(),
			state: "shadowed",
			shadowedBy: "claude",
			raw: { type: "pre", tool: "bash" },
		},
		{
			id: "prompt:p",
			kind: "prompt",
			name: "p",
			displayName: "p",
			description: "a prompt",
			path: "/home/u/.omp/prompts/p.md",
			source: src(),
			state: "active",
			raw: { content: "prompt text\n\tindented" },
		},
		{
			id: "context-file:agents",
			kind: "context-file",
			name: "AGENTS.md",
			displayName: "AGENTS.md",
			path: "/home/u/AGENTS.md",
			source: src(),
			state: "active",
			raw: { content: "# Agents\ncontext" },
		},
		{
			id: "instruction:i",
			kind: "instruction",
			name: "i",
			displayName: "i",
			path: "/home/u/.github/i.instructions.md",
			source: src(),
			state: "active",
			raw: { content: "do this", applyTo: "**/*.py" },
		},
		{
			id: "extension-module:m",
			kind: "extension-module",
			name: "m",
			displayName: "module m",
			path: "/home/u/.omp/extensions/m",
			trigger: "on load",
			source: src(),
			state: "active",
			raw: {},
		},
		mcpExt(),
		{ ...mcpExt("shadowed"), shadowedBy: "claude", path: "/home/u/.claude/mcp.json" },
	];
}

function providers(): ExtensionProvider[] {
	return [
		{ id: "native", displayName: "OMP", enabled: true, userSourceEnabled: true, foreignUserSource: false },
		{ id: "claude", displayName: "Claude Code", enabled: false, userSourceEnabled: false, foreignUserSource: true },
	];
}

const slug = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const mouse = (b: number, col: number, row: number) => `\x1b[<${b};${col};${row}M`;
const settle = async () => {
	for (let i = 0; i < 6; i++) await Bun.sleep(0);
};

// ─── List ───────────────────────────────────────────────────────────────────

function mountList(caseName: string): Mounted {
	const setups: Record<string, [string | null, number | undefined]> = {
		"list-all-view": [null, undefined],
		"list-all-view-small": [null, 5],
		"list-provider-claude": ["claude", 6],
		"list-provider-native": ["native", 3],
		"list-empty-initial": [null, undefined],
		"list-exact-legacy-rows-wide-widths-only": [null, undefined],
	};
	const [master, max] = setups[caseName]!;
	const provs = providers();
	const list = new ExtensionListModel(
		caseName === "list-empty-initial" ? [] : extensions(),
		{
			getProviders: () => provs,
			onMasterToggle: id => {
				const provider = provs.find(entry => entry.id === id);
				if (provider) provider.enabled = !provider.enabled;
			},
			masterSwitchProvider: master,
			mcpSource: mcpSource(),
			toolSource,
		},
		max,
	);
	const step = (fn: () => void) => () => fn();
	return {
		view: () => <ExtensionListView list={list} />,
		steps: {
			focus: step(() => list.setFocused(true)),
			"down x3": d => ["", "", ""].forEach(() => d.press(DOWN)),
			"hover 2": step(() => list.setHoverIndex(2)),
			"hover hit": step(() => list.setHoverIndex(list.hitTest(4))),
			"wheel down": step(() => list.handleWheel(1)),
			"click 5": step(() => list.handleClick(5)),
			"click 5 again (activate)": step(() => list.handleClick(5)),
			space: d => d.press(" "),
			"maxVisible 4": step(() => list.setMaxVisible(4)),
			"down x6": d => {
				for (let i = 0; i < 6; i++) d.press(DOWN);
			},
			up: d => d.press(UP),
			"mcp connecting": step(() => list.setMcpSource(mcpSource("connecting"))),
			"tool source off": step(() => list.setToolSource(undefined)),
			"type g": d => d.press("g"),
			"type i": d => d.press("i"),
			"caret left": d => d.press("\x1b[D"),
			"search query alpha": step(() => list.setSearchQuery("alpha")),
			"search nomatch": step(() => list.setSearchQuery("zzzzqqq")),
			clear: step(() => list.clearSearch()),
			"setExtensions fewer": step(() => list.setExtensions(extensions().slice(2, 5))),
			"master claude": step(() => list.setMasterSwitchProvider("claude")),
			"activate master": step(() => list.activateSelected()),
			"down + activate": d => {
				d.press(DOWN);
				list.activateSelected();
			},
			"master native": step(() => list.setMasterSwitchProvider("native")),
			reset: step(() => list.resetSelection()),
			"native pick": step(() => void list.pickNative(list.pickerView().items[2]!.id, false)),
			"maxVisible 30": step(() => list.setMaxVisible(30)),
			"mcp disconnected": step(() => list.setMcpSource(mcpSource("disconnected"))),
			unfocus: step(() => list.setFocused(false)),
			empty: step(() => list.setExtensions([])),
			"master null empty": step(() => list.setMasterSwitchProvider(null)),
			type: d => d.press("a"),
		},
	};
}

// ─── Inspector ──────────────────────────────────────────────────────────────

function mountInspector(caseName: string): Mounted {
	const all = extensions();
	const name = caseName.slice("inspector-".length);
	let ext = all.find(entry => slug(`${entry.kind} ${entry.id} ${entry.state}`) === name);
	let source = mcpSource();
	if (name === "mcp-many") [ext, source] = [mcpExt(), mcpSource("connected", true)];
	else if (name === "mcp-connecting") [ext, source] = [mcpExt(), mcpSource("connecting")];
	else if (name === "mcp-disabled") [ext, source] = [mcpExt("disabled"), mcpSource("disconnected")];
	else if (name === "skill-exact-wide") ext = all[0];
	const inspector = new ExtensionInspectorModel();
	inspector.setMcpSource(source);
	inspector.setToolSource(toolSource);
	const target = ext ?? all[0]!;
	return {
		view: () => <ExtensionInspectorView inspector={inspector} />,
		steps: {
			set: () => inspector.setExtension(target),
			"height 12": () => inspector.setHeight(12),
			expand: () => void inspector.toggleExpanded(),
			"height 0": () => inspector.setHeight(0),
			"same key new object": () => inspector.setExtension({ ...target }),
			collapse: () => void inspector.toggleExpanded(),
			"expand again": () => void inspector.toggleExpanded(),
			"other ext resets expand": () => inspector.setExtension(all[(all.indexOf(target) + 1) % all.length]!),
			back: () => inspector.setExtension(target),
			"height NaN": () => inspector.setHeight(Number.NaN),
			clear: () => inspector.setExtension(null),
			"set mcp": () => inspector.setExtension(mcpExt()),
			"mcp source change": () => inspector.setMcpSource(mcpSource("connected", true)),
			tool: () => inspector.setExtension(all[4]!),
			"tool source off": () => inspector.setToolSource(undefined),
		},
	};
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

function runtime(all: () => Extension[]): ExtensionDashboardRuntime {
	const disabled: string[] = [];
	const provs = providers();
	return {
		getDisabledExtensions: () => disabled,
		setDisabledExtensions: ids => void disabled.splice(0, disabled.length, ...ids),
		getProviders: () => provs,
		loadExtensions: async ids =>
			all().map(ext =>
				ids.includes(ext.id) ? { ...ext, state: "disabled", disabledReason: "item-disabled" } : ext,
			),
		toggleProvider: id => {
			const provider = provs.find(entry => entry.id === id)!;
			provider.enabled = !provider.enabled;
			return provider.enabled;
		},
		toggleUserSource: id => {
			const provider = provs.find(entry => entry.id === id)!;
			provider.userSourceEnabled = !provider.userSourceEnabled;
			return provider.userSourceEnabled;
		},
		persistMcpToggle: async () => {},
		applyMcpToggle: async () => {},
		subscribeMcpChanges: () => [],
		mcpSource: mcpSource(),
	};
}

function mountDashboard(caseName: string, widths: readonly number[]): Mounted {
	// The recording drew every case on a 30-row terminal.
	const rows = 30;
	const [all, tools] =
		caseName === "full"
			? [extensions, true]
			: caseName === "empty"
				? [() => [] as Extension[], true]
				: [extensions, false];
	const env = corpusEnvironment("dark");
	let model!: ExtensionDashboardModel;
	const created = signal(false);
	const ready = ExtensionDashboardModel.create({
		runtime: runtime(all),
		terminal: { theme: env.theme, size: () => ({ columns: widths.at(-1)!, rows }) },
		toolSource: tools ? toolSource : undefined,
	}).then(dashboard => {
		model = dashboard;
		created.set(true);
	});
	const key = (data: string) => async (d: Driver) => {
		d.press(data);
		await settle();
	};
	const emit = (event: Record<string, unknown>) => async (d: Driver) => {
		d.emit({ mods: [], ...event } as unknown as UiEvent);
		await settle();
	};
	const item = (n: number) => model.list.pickerView().items[n]?.id ?? "";
	return {
		ready,
		view: () => () => (created() ? <ExtensionDashboard model={model} /> : <col />),
		steps: {
			down: key(DOWN),
			expand: key("\x0f"),
			"page down": key("\x1b[6~"),
			"page up": key("\x1b[5~"),
			"space toggle": key(" "),
			"tab provider": key("\t"),
			"right provider": key("\x1b[C"),
			"left provider": key("\x1b[D"),
			"type d": key("d"),
			"type e": key("e"),
			"escape clears search": key("\x1b"),
			"mouse motion over tabs": key(mouse(35, 10, 2)),
			"mouse motion over list": key(mouse(35, 10, 7)),
			"mouse click list row": key(mouse(0, 10, 7)),
			"mouse click again (activate)": key(mouse(0, 10, 7)),
			"mouse wheel list": key(mouse(65, 10, 8)),
			"mouse wheel inspector": key(mouse(65, 200, 8)),
			"mouse wheel inspector up": key(mouse(64, 200, 8)),
			"mouse click tab": key(mouse(0, 20, 2)),
			"native scope claude": emit({ type: "action", key: "", act: "scope", value: "claude" }),
			"native toggle (master)": emit({ type: "action", key: "", act: "toggle" }),
			"native toggle back": emit({ type: "action", key: "", act: "toggle" }),
			"native scope all": emit({ type: "action", key: "", act: "scope", value: "all" }),
			"native select item": d => emit({ type: "select", key: "", item: item(3) })(d),
			"native activate item": d => emit({ type: "activate", key: "", item: item(3) })(d),
			"native expand": emit({ type: "action", key: "", act: "expand" }),
			"native list select (page)": d => emit({ type: "select", key: "body/list", item: item(5) })(d),
			"type x search + native clear": async d => {
				d.press("x");
				await emit({ type: "action", key: "", act: "clear" })(d);
			},
			invalidate: () => {},
		},
	};
}

panelSuite({
	dir: "overlays/extensions-dashboard",
	mount(caseName, corpusCase) {
		if (caseName.startsWith("list-")) return mountList(caseName);
		if (caseName.startsWith("inspector-")) return mountInspector(caseName);
		return mountDashboard(caseName, corpusCase.widths);
	},
	nativeOnly: () => false,
});
