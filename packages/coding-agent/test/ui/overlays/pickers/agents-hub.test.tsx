/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import { fullscreenMenuView } from "../../../../src/modes/controllers/selector-views";
import { nativeShell } from "../../../helpers/native-shell";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { UiEvent } from "@oh-my-pi/pi-tui";
import { bubbleEvent } from "@oh-my-pi/pi-tui/dispatch";
import type { ModelBrowserSource } from "../../../../src/modes/view-model/overlays/model-browser";
import { AgentsHub, type AgentsHubDeps, type HubAgent } from "../../../../src/ui/overlays/pickers/agents-hub";
import { type Driver, pickerSuite } from "./harness";

const sonnet = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium, Effort.High] },
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 8192,
} as Parameters<typeof buildModel>[0]);

const SPEC = JSON.stringify({
	identifier: "code-reviewer",
	whenToUse: "Use this agent when reviewing diffs for regressions and style",
	systemPrompt: `You review code.\n\n- Be strict\n- Be kind\n日本語 line\n${"long line ".repeat(30)}`,
});

function deps(variant: "normal" | "empty" | "error"): AgentsHubDeps {
	const agents = (): HubAgent[] => [
		{
			name: "dev",
			description: "Development agent",
			systemPrompt: "Do dev things",
			source: "project",
			disabled: false,
			filePath: "/home/u/.omp/agents/dev.md",
		},
		{
			name: "scout",
			description: "Read-only research with a very long description that overflows narrow panes 日本語",
			systemPrompt: "",
			source: "bundled",
			disabled: true,
			overrideModel: "anthropic/claude-sonnet-4-5",
		},
		{
			name: "task",
			description: "Generic task agent",
			systemPrompt: "",
			source: "bundled",
			disabled: false,
			advisorOverride: "on",
			prewalkOverride: "off",
		},
		{ name: "ü-user", description: "User agent", systemPrompt: "Prompt", source: "user", disabled: false },
	];
	const browserSource = {
		revision: 0,
		defaultThinkingLevel: "high",
		modelProviderOrder: [],
		knownRoleIds: [],
		mruOrder: [],
		modelPerf: new Map(),
		getModelRole: () => undefined,
		getRoleInfo: (role: string) => ({ name: role, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
	} as unknown as ModelBrowserSource;
	return {
		browserSource,
		loadAgents: async () => {
			if (variant === "error") throw new Error("agents dir unreadable");
			return variant === "empty" ? [] : agents();
		},
		getAvailableModels: () => [sonnet],
		effectiveModelPatterns: agent => (agent.overrideModel ? [agent.overrideModel] : []),
		resolvePatterns: patterns => (patterns.length ? "anthropic/claude-sonnet-4-5" : undefined),
		effectivePrewalkPattern: agent => (agent.prewalkOverride === "on" ? "@smol" : undefined),
		effectiveAdvisorPattern: agent => (agent.advisorOverride === "on" ? "@advisor" : undefined),
		setAgentDisabled: () => {},
		setAgentOverride: () => {},
		generateAgent: async (_description, onText) => {
			onText('{"identifier":');
			onText(' "code-reviewer" …');
			return SPEC;
		},
		saveAgent: async () => "/home/u/.omp/agents/code-reviewer.md",
	};
}

const VARIANTS: Record<string, { variant: "normal" | "empty" | "error"; rows: number }> = {
	"normal-keys": { variant: "normal", rows: 30 },
	"empty-keys": { variant: "empty", rows: 20 },
	"error-keys": { variant: "error", rows: 40 },
	mouse: { variant: "normal", rows: 30 },
	native: { variant: "normal", rows: 30 },
};

const tick = () => Bun.sleep(5);

/** A native event as a Tern terminal sends it (its key names the node it came from). */
const native = (event: Record<string, unknown>) => (d: Driver) =>
	void bubbleEvent([d.root], { key: "", mods: [], ...event } as unknown as UiEvent);
const key = (raw: string) => (d: Driver) => d.press(raw);

test("native /agents selection targets the clicked agent in its fullscreen menu", async () => {
	await using ui = await nativeShell();
	const changed: string[] = [];
	const host = deps("normal");
	host.setAgentDisabled = (name, { disabled }) => changed.push(`${name}:${disabled}`);
	let loaded!: Promise<void>;
	ui.shell.overlays.show(() =>
		fullscreenMenuView(
			"agents-dashboard",
			<AgentsHub
				deps={host}
				rows={() => 30}
				onCancel={() => {}}
				ref={hub => {
					loaded = hub.reload();
				}}
			/>,
		),
	);
	await loaded;
	const picker = ui.node("picker");
	const props = (): TspPickerProps => ui.node("picker").p;
	const target = props().items!.find(item => item.id === "agent:bundled:scout")!;
	ui.send({ ev: "select", sf: ui.sf, id: picker.id, item: target.id });
	expect(props().selected).toBe(target.id);
	expect(props().strip).toBeFalsy();
	const toggle = props().actions!.find(action => action.label === "Toggle")!;
	ui.send({ ev: "action", sf: ui.sf, id: picker.id, act: toggle.id });
	expect(changed).toEqual(["scout:false"]);
	ui.send({ ev: "activate", sf: ui.sf, id: picker.id, item: target.id });
	expect(props().strip?.label).toBe("scout");
});

test("model preview reuses only the current selection and settings revision, including unresolved models", async () => {
	await using ui = await nativeShell();
	const host = deps("normal");
	let revision = 0;
	host.browserSource = {
		...host.browserSource,
		get revision() {
			return revision;
		},
	};
	const resolved: string[] = [];
	host.effectiveModelPatterns = agent => [agent.name];
	host.resolvePatterns = patterns => {
		resolved.push(...patterns);
		return undefined;
	};
	let reload!: () => Promise<void>;
	ui.shell.overlays.show(() =>
		fullscreenMenuView(
			"agents-dashboard",
			<AgentsHub
				deps={host}
				rows={() => 30}
				onCancel={() => {}}
				ref={hub => {
					reload = hub.reload;
				}}
			/>,
		),
	);
	await reload();
	const { id } = ui.node("picker");
	const select = (item: string) => ui.send({ ev: "select", sf: ui.sf, id, item });
	select("agent:bundled:scout");
	select("agent:bundled:scout");
	expect(resolved).toEqual(["dev", "scout"]);
	revision++;
	select("agent:bundled:scout");
	select("agent:project:dev");
	select("agent:bundled:scout");
	await reload();
	ui.node("picker");
	expect(resolved).toEqual(["dev", "scout", "scout", "dev", "scout", "scout"]);
});

pickerSuite({
	dir: "overlays/agents-hub",
	mount(caseName) {
		const { variant, rows } = VARIANTS[caseName]!;
		let loaded: Promise<void> = Promise.resolve();
		return {
			view: () => (
				<AgentsHub
					deps={deps(variant)}
					rows={() => rows}
					onCancel={() => {}}
					ref={hub => {
						loaded = hub.reload();
					}}
				/>
			),
			ready: () => loaded,
			focus: d => d.root,
			steps: {
				"select agent": native({ type: "select", key: "split/body/agents", item: "agent:bundled:scout" }),
				"activate agent": native({ type: "activate", key: "split/body/agents", item: "agent:bundled:task" }),
				"strip select": native({ type: "select", key: "footer/strip", item: "2" }),
				"strip activate": native({ type: "activate", key: "footer/strip", item: "1" }),
				"strip back": key("\x1b"),
				"strip close": key("\x1b"),
				"scope select": native({ type: "select", key: "split/scopes", item: "source:bundled" }),
				"scope activate": native({ type: "activate", key: "split/scopes", item: "all" }),
				"picker select": native({ type: "select", item: "agent:project:dev" }),
				"picker model": native({ type: "action", act: "model" }),
				"picker strip": native({ type: "action", act: "strip", value: "1" }),
				"picker back": native({ type: "action", act: "back" }),
				"picker scope": native({ type: "action", act: "scope", value: "source:user" }),
				"picker toggle": native({ type: "action", act: "toggle" }),
				"picker configure": native({ type: "action", act: "configure" }),
				"picker apply": native({ type: "action", act: "apply" }),
				"pattern open": native({ type: "action", act: "strip", value: "4" }),
				"pattern type": key("x"),
				"pattern submit": key("\r"),
				"new agent": native({ type: "action", act: "new" }),
				"type description": d => {
					d.press("r");
					d.press("e");
					d.press("v");
				},
				"scope tab": key("\t"),
				generate: async d => {
					d.press("\x11");
					await tick();
				},
				"toggle prompt": native({ type: "toggle", key: "split/body/prompt", collapsed: false }),
				"scope tab again": key("\t"),
				regenerate: async d => {
					d.press("r");
					await tick();
				},
				save: async d => {
					d.press("\r");
					await tick();
					await tick();
				},
				"picker pick model": d => {
					native({ type: "action", act: "model" })(d);
					native({ type: "action", act: "strip", value: "0" })(d);
				},
				"browser down": key("\x1b[B"),
				"browser type": key("s"),
				"browser cancel": key("\x1b"),
				reload: async d => {
					native({ type: "action", act: "reload" })(d);
					await tick();
				},
			},
		};
	},
});
