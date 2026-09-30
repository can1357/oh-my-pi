import { afterEach, beforeAll, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { TspPickerGroup, TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { ModelHubComponent, type ModelHubRegistry, type ModelHubSource } from "../src/overlays/model-hub";
import { ModelPickerComponent } from "../src/overlays/model-picker";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/tui";

const withPicker: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
const withoutPicker: DescribeContext = { ...withPicker, supports: kind => kind !== "picker" };

beforeAll(async () => {
	await initTheme(false);
});

function model(provider: string, id: string, extra: Partial<Model> = {}): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://127.0.0.1/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		...extra,
	} as Parameters<typeof buildModel>[0]);
}

const MODELS = [
	model("anthropic", "claude-sonnet-5-5", { int: 60 }),
	model("anthropic", "claude-opus-5"),
	model("demo", "demo"),
	model("openai", "gpt-5.6"),
	model("openai", "gpt-5.6-mini", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
];

function source(roles: Record<string, string>, mru: string[]): ModelHubSource {
	return {
		revision: 0,
		defaultThinkingLevel: "off",
		modelProviderOrder: [],
		knownRoleIds: ["default", "smol"],
		mruOrder: mru,
		modelPerf: new Map(),
		getRoleInfo: role => ({ tag: role, name: `${role} role`, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: (value, models) => ({
			model: models.find(candidate => `${candidate.provider}/${candidate.id}` === value),
			explicitThinkingLevel: false,
		}),
		getModelRole: role => roles[role],
		disabledProviders: [],
		fallbackChains: { default: ["openai/gpt-5.6"] },
		modelRoleStorage: "global",
		cycleOrder: [],
		getProjectModelRole: () => undefined,
		getGlobalModelRole: role => roles[role],
		getModelRoleSource: () => "global",
	};
}

function registry(models: Model[]): ModelHubRegistry {
	return {
		getError: () => undefined,
		getAvailable: () => models,
		getAll: () => models,
		authStorage: { keys: { source: () => "env" } },
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		find: (provider: string, id: string) =>
			models.find(candidate => candidate.provider === provider && candidate.id === id),
		refresh: async () => {},
		refreshProvider: async () => {},
	} as unknown as ModelHubRegistry;
}

const ui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
const hubs: ModelHubComponent[] = [];
afterEach(() => {
	for (const hub of hubs.splice(0)) hub.dispose();
});

function openHub(calls: { assign: string[]; cancel: number }): ModelHubComponent {
	const hub = new ModelHubComponent(
		ui,
		source({ default: "demo/demo" }, ["demo/demo"]),
		registry(MODELS),
		// A `--models` scope skips the background online refresh.
		MODELS.map(entry => ({ model: entry })),
		{
			onAssign: (_model, role, _level, selector) => {
				calls.assign.push(`${role}=${selector}`);
			},
			onUnassign: () => {},
			onCancel: () => {
				calls.cancel++;
			},
		},
		{ currentSelector: "demo/demo" },
	);
	hubs.push(hub);
	return hub;
}

function props(root: NativeNode): TspPickerProps {
	expect(root.k).toBe("picker");
	return root.p as TspPickerProps;
}

function groups(p: TspPickerProps): string[] {
	return (p.order ?? [])
		.filter((entry): entry is TspPickerGroup => typeof entry !== "string")
		.map(g => String(g.label));
}

/** A described child's prop, when the child is a node carrying it. */
function prop(child: NativeChild, name: string): unknown {
	return "k" in child && child.p ? Reflect.get(child.p, name) : undefined;
}

function titleOf(children: readonly NativeChild[] | undefined): unknown {
	const title = children?.find(child => prop(child, "role") === "omp.picker.title");
	return title ? prop(title, "text") : undefined;
}

test("the model hub describes a data-first picker when the terminal has the kind, else its generic frame", () => {
	const hub = openHub({ assign: [], cancel: 0 });
	expect(hub.nativeSheet(withPicker)).toBe(true);
	expect(hub.nativeSheet(withoutPicker)).toBe(false);
	expect(hub.describe(withoutPicker).k).not.toBe("picker");

	const root = hub.describe(withPicker);
	const p = props(root);
	expect(p).toMatchObject({ size: "lg", layout: "rows", preview: "side", icon: "cpu", title: "Models", scope: "all" });
	expect(p.scopes?.map(scope => [scope.id, scope.count, scope.group])).toEqual([
		["roles", 2, undefined],
		["all", 5, undefined],
		["provider:anthropic", 2, "Providers"],
		["provider:demo", 1, "Providers"],
		["provider:openai", 2, "Providers"],
	]);
	expect(p.scopes?.find(scope => scope.id === "provider:anthropic")?.mark).toEqual({ text: "An", seed: "anthropic" });
	// The recent/role block, then one group per provider.
	expect(groups(p)).toEqual(["Recent", "anthropic", "openai"]);
	expect(p.current).toEqual(["demo/demo"]);
	expect(p.total).toBe(5);
	const demo = p.items?.find(entry => entry.id === "demo/demo");
	// The default role runs with thinking off (`defaultThinkingLevel`): its chip carries that level's dot.
	expect(demo?.chips).toEqual([{ text: "default", on: true, dot: "thinkingOff" }]);
	expect(p.items?.find(entry => entry.id === "anthropic/claude-sonnet-5-5")?.facts?.int).toBe("60");
	expect(p.items?.find(entry => entry.id === "openai/gpt-5.6-mini")?.badges).toEqual([
		{ text: "free", tone: "success" },
	]);
	expect(titleOf(root.c)).toBe("demo");
	// Unchanged state keeps the node.
	expect(hub.describe(withPicker)).toBe(root);
});

test("typing changes the order, hits, counts and head total but never the catalogue", () => {
	const hub = openHub({ assign: [], cancel: 0 });
	const before = props(hub.describe(withPicker));
	for (const ch of "sonnet") hub.handleInput(ch);
	const after = props(hub.describe(withPicker));
	expect(after.items).toBe(before.items);
	expect(after.query).toBe("sonnet");
	expect(after.order).toEqual(["anthropic/claude-sonnet-5-5"]);
	expect(after.hits?.["anthropic/claude-sonnet-5-5"]).toEqual([[17, 23]]);
	expect(after.total).toBe(5);
	expect(after.scopes?.find(scope => scope.id === "all")?.count).toBe(1);
	expect(after.scopes?.find(scope => scope.id === "provider:openai")?.count).toBe(0);
	expect(after.selected).toBe("anthropic/claude-sonnet-5-5");
});

test("a re-sync that moves a role patches the catalogue instead of resending it", () => {
	const models = [...MODELS, ...Array.from({ length: 30 }, (_, i) => model("bulk", `m-${i}`))];
	const roles: Record<string, string> = { default: "demo/demo" };
	const hub = new ModelHubComponent(
		ui,
		source(roles, []),
		registry(models),
		models.map(entry => ({ model: entry })),
		{
			onAssign: () => {},
			onUnassign: () => {},
			onCancel: () => {},
		},
	);
	hubs.push(hub);
	const first = props(hub.describe(withPicker));
	expect(first.itemsAdd).toBeUndefined();

	roles.default = "openai/gpt-5.6";
	hub.refreshAfterExternalMutation();
	const moved = props(hub.describe(withPicker));
	expect(moved.items).toBe(first.items);
	expect(moved.itemsAdd?.map(row => [row.id, row.chips?.map(chip => chip.text)]).sort()).toEqual([
		["demo/demo", undefined],
		["openai/gpt-5.6", ["default"]],
	]);

	// Back to the original: the terminal kept the patch, so the reverted rows are still sent.
	roles.default = "demo/demo";
	hub.refreshAfterExternalMutation();
	const reverted = props(hub.describe(withPicker));
	expect(reverted.items).toBe(first.items);
	expect(reverted.itemsAdd?.map(row => [row.id, row.chips?.map(chip => chip.text)]).sort()).toEqual([
		["demo/demo", ["default"]],
		["openai/gpt-5.6", undefined],
	]);
});

test("pointer events drive the hub through the same paths as its keys", () => {
	const calls = { assign: [] as string[], cancel: 0 };
	const hub = openHub(calls);
	const act = (act: string, value?: string) =>
		hub.handleNativeEvent({ type: "action", key: "", act, value, mods: [] });

	hub.handleNativeEvent({ type: "select", key: "", item: "openai/gpt-5.6" });
	let p = props(hub.describe(withPicker));
	expect(p.selected).toBe("openai/gpt-5.6");
	expect(p.focus).toBe("list");
	expect(titleOf(hub.describe(withPicker).c)).toBe("gpt-5.6");

	// Activate = Enter: the role-assignment strip opens and takes the focus.
	hub.handleNativeEvent({ type: "activate", key: "", item: "openai/gpt-5.6" });
	p = props(hub.describe(withPicker));
	expect(p.focus).toBe("strip");
	expect(p.strip?.items.map(chip => chip.label).slice(0, 2)).toEqual(["default", "smol"]);
	act("strip", "1");
	expect(calls.assign).toEqual(["smol=openai/gpt-5.6"]);

	// The kind tab and scope clicks land where alt+→ and the sidebar do.
	act("close");
	act("tab", "image");
	expect(props(hub.describe(withPicker)).tab).toBe("image");
	act("tab", "all");
	act("scope", "provider:openai");
	p = props(hub.describe(withPicker));
	expect(p.scope).toBe("provider:openai");
	expect(p.order?.filter(entry => typeof entry === "string")).toEqual(["openai/gpt-5.6", "openai/gpt-5.6-mini"]);
	expect(p.actions?.map(action => action.id)).toContain("refresh");

	// Roles scope: roles with their fallback chain one level deep.
	act("scope", "roles");
	p = props(hub.describe(withPicker));
	expect(p.items?.find(entry => entry.id === "fallback:default:0")).toMatchObject({
		label: "openai/gpt-5.6",
		depth: 1,
	});
	expect(p.items?.find(entry => entry.id === "role:default")?.facts).toEqual({ model: "demo/demo", thinking: "off" });
	expect(groups(p)).toContain("Model fallback chains");
	// The head's total counts the rows Tern counts as shown (fallbacks, chains, "New …" rows), so All reads no "N of M".
	expect(p.total).toBe(p.order?.filter(entry => typeof entry === "string").length);

	// Esc ladder: close leaves the hub only when nothing else is open.
	act("scope", "all");
	hub.handleInput("x");
	act("close");
	expect(props(hub.describe(withPicker)).query).toBe("");
	expect(calls.cancel).toBe(0);
	act("close");
	expect(calls.cancel).toBe(1);
});

test("the quick picker is an md sheet with the summary below and a task-model toggle", () => {
	const picked: string[] = [];
	const picker = new ModelPickerComponent(
		ui,
		source({ default: "demo/demo" }, ["demo/demo"]),
		{ ...registry(MODELS), refreshIfStale: async () => false },
		MODELS.map(entry => ({ model: entry })),
		{
			onPick: (_model, selector) => picked.push(`session:${selector}`),
			onPickTask: (_model, selector) => picked.push(`task:${selector}`),
			onCancel: () => {},
		},
		{ currentSelector: "demo/demo", taskModeKeys: ["alt+p"] },
	);
	expect(picker.describe(withoutPicker).k).not.toBe("picker");
	let root = picker.describe(withPicker);
	let p = props(root);
	expect(p).toMatchObject({ size: "md", preview: "below", title: "Switch model", selected: "demo/demo" });
	expect(p.scopes).toBeUndefined();
	expect(groups(p)).toEqual(["Recent", "All"]);
	expect(root.c?.some(child => prop(child, "layout") === "inline")).toBe(true);

	picker.handleNativeEvent({ type: "action", key: "", act: "task", mods: [] });
	root = picker.describe(withPicker);
	p = props(root);
	expect(p.title).toBe("Switch task model");
	expect(p.actions?.find(action => action.id === "task")?.on).toBe(true);
	picker.handleNativeEvent({ type: "activate", key: "", item: "openai/gpt-5.6" });
	expect(picked).toEqual(["task:openai/gpt-5.6"]);
});
