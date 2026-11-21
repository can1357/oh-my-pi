import { afterEach, beforeAll, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { TspPickerGroup, TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { ModelHubComponent, type ModelHubRegistry, type ModelHubSource } from "../src/overlays/model-hub";
import { providerMark } from "../src/overlays/model-browser";
import { ModelPickerComponent, type ModelPickerOptions } from "../src/overlays/model-picker";
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

function openHub(calls: { assign: string[]; cancel: number }, models: Model[] = MODELS): ModelHubComponent {
	const hub = new ModelHubComponent(
		ui,
		source({ default: "demo/demo" }, ["demo/demo"]),
		registry(models),
		// A `--models` scope skips the background online refresh.
		models.map(entry => ({ model: entry })),
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
	expect(p.scopes?.find(scope => scope.id === "provider:anthropic")?.mark).toEqual({
		text: "An",
		seed: "anthropic",
		icon: "provider:anthropic",
	});
	// The recent/role block, then one group per provider.
	expect(groups(p)).toEqual(["Recent", "anthropic", "openai"]);
	expect(p.current).toEqual(["demo/demo"]);
	expect(p.total).toBe(5);
	const demo = p.items?.find(entry => entry.id === "demo/demo");
	// Model rows lead with their provider's mark too.
	expect(demo?.mark).toEqual({ text: "De", seed: "demo", icon: "provider:demo" });
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

test("Factory Droid rows carry the base credit rate and a credit-only model is never free", () => {
	const priced = { ...model("factory-droid", "claude-opus-5"), factoryDroidCredits: 2 };
	const creditOnly = {
		...model("factory-droid", "preview-credit-model", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		factoryDroidCredits: 0.5,
	};
	const hub = openHub({ assign: [], cancel: 0 }, [...MODELS, priced, creditOnly]);
	const items = props(hub.describe(withPicker)).items ?? [];
	const row = (id: string) => items.find(entry => entry.id === `factory-droid/${id}`);
	expect(row("claude-opus-5")?.facts?.price).toBe("$3·15 2×");
	expect(row("preview-credit-model")?.facts?.price).toBe("0.5×");
	expect(row("preview-credit-model")?.badges ?? []).not.toContainEqual({ text: "free", tone: "success" });
});

test("a dated Factory Droid credit rate keeps the narrow price column to the rate alone", () => {
	const promoted = {
		...model("factory-droid", "gpt-5.6-sol"),
		factoryDroidCredits: 2,
		factoryDroidCreditCards: [
			{ effectiveFrom: Date.now() - 86_400_000, input: 1.6 },
			{ effectiveFrom: Date.parse("2099-11-22T00:00:00Z"), input: 2 },
		],
	};
	const hub = openHub({ assign: [], cancel: 0 }, [...MODELS, promoted]);
	const items = props(hub.describe(withPicker)).items ?? [];
	expect(items.find(entry => entry.id === "factory-droid/gpt-5.6-sol")?.facts?.price).toBe("$3·15 1.6×");
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

test("the Roles view picker names the active preset and ctrl+←/→ switches it", () => {
	const presets = { names: ["fast", "slow"], active: "fast" as string | undefined };
	let revision = 0;
	const switched: string[] = [];
	const base = source({ default: "demo/demo" }, []);
	const hub = new ModelHubComponent(
		ui,
		Object.defineProperty({ ...base, getModelPresets: () => presets }, "revision", { get: () => revision }),
		registry(MODELS),
		MODELS.map(entry => ({ model: entry })),
		{
			onAssign: () => {},
			onUnassign: () => {},
			onCancel: () => {},
			onSwitchPreset: name => {
				switched.push(name);
				presets.active = name;
				revision++;
			},
		},
	);
	hubs.push(hub);
	const subtitleText = () => {
		const subtitle = props(hub.describe(withPicker)).subtitle;
		return Array.isArray(subtitle) ? subtitle.map(part => part.t).join("") : subtitle;
	};

	hub.handleInput("\x1b[A"); // All models → Roles
	expect(subtitleText()).toStartWith("Preset fast");
	hub.handleInput("\x1b[1;5C");
	expect(switched).toEqual(["slow"]);
	expect(subtitleText()).toStartWith("Preset slow");
	hub.handleInput("\x1b[1;5D");
	expect(switched).toEqual(["slow", "fast"]);
});

const QUICK_MODELS = [
	...MODELS,
	model("demo", "demo-lite", { thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium] } }),
	model("local", "tiny", { reasoning: false }),
];

function openQuickPicker(picked: string[], options: ModelPickerOptions = {}): ModelPickerComponent {
	return new ModelPickerComponent(
		ui,
		source({ default: "demo/demo" }, ["demo/demo"]),
		{ ...registry(QUICK_MODELS), refreshIfStale: async () => false },
		QUICK_MODELS.map(entry => ({ model: entry })),
		{
			onPick: (_model, selector, meta) =>
				picked.push(`session:${selector}${meta.thinkingLevel ? `:${meta.thinkingLevel}` : ""}`),
			onPickTask: (_model, selector) => picked.push(`task:${selector}`),
			onKeepThinking: level => picked.push(`keep:${level}`),
			onCancel: () => picked.push("cancel"),
		},
		{ currentSelector: "demo/demo", taskModeKeys: ["alt+p"], thinkingLevelFor: () => Effort.High, ...options },
	);
}

function quickAct(picker: ModelPickerComponent, act: string, value?: string): void {
	picker.handleNativeEvent({ type: "action", key: "", act, mods: [], ...(value !== undefined ? { value } : {}) });
}

/** Item ids the picker lists, group heads dropped. */
function rowIds(p: TspPickerProps): string[] {
	return (p.order ?? []).filter((entry): entry is string => typeof entry === "string");
}

test("plan execution picker defaults to the selected target and retains the planning model outside the catalog", () => {
	const selected = model("local", "execution-model");
	const planning = model("local", "planning-model");
	const picked: string[] = [];
	const picker = new ModelPickerComponent(
		ui,
		source({}, []),
		{ ...registry(QUICK_MODELS), refreshIfStale: async () => false },
		QUICK_MODELS.map(entry => ({ model: entry })),
		{
			onPick: (_model, selector) => picked.push(selector),
			onCancel: () => picked.push("cancel"),
		},
		{ planExecution: { extraModels: [selected, planning] }, currentSelector: "local/execution-model" },
	);
	const view = props(picker.describe(withPicker));
	expect(rowIds(view)).toContain("local/planning-model");
	expect(view.placeholder).toBe("Search models…");
	expect(view.actions ?? []).toEqual([]);
	picker.handleInput("\r");
	expect(picked).toEqual(["local/execution-model"]);
});

test("the quick picker is a composer drop-up with a provider rail, a thinking slider and a task-model toggle", () => {
	const picked: string[] = [];
	const picker = openQuickPicker(picked);
	expect(picker.describe(withoutPicker).k).not.toBe("picker");
	let root = picker.describe(withPicker);
	let p = props(root);
	expect(p).toMatchObject({
		size: "md",
		anchor: "composer",
		search: "list",
		density: "snug",
		preview: "none",
		scopeStyle: "rail",
		scope: "all",
		placeholder: "Search, @ for roles…",
		selected: "demo/demo",
	});
	expect(p.title).toBeUndefined();
	expect(p.subtitle).toBeUndefined();
	expect(root.c ?? []).toEqual([]);
	// The rail lists providers only: none active is all models.
	expect(p.scopes).toEqual([
		{ id: "provider:anthropic", label: "anthropic", mark: providerMark("anthropic"), count: 2 },
		{ id: "provider:demo", label: "demo", mark: providerMark("demo"), count: 2 },
		{ id: "provider:local", label: "local", mark: providerMark("local"), count: 1 },
		{ id: "provider:openai", label: "openai", mark: providerMark("openai"), count: 2 },
	]);
	expect(groups(p)).toEqual(["Recent", "All"]);
	// No action bar: only the Task / Main toggle, drawn atop the rail.
	expect(p.actions).toEqual([
		{ id: "task", label: "Task / Main", keys: ["alt", "p"], on: false, head: true, icon: "users" },
	]);
	expect(p.level).toEqual({
		label: "Thinking",
		steps: [
			{ id: "auto", label: "Auto" },
			{ id: "off", label: "Off" },
			{ id: "minimal", label: "Min" },
			{ id: "low", label: "Low" },
			{ id: "medium", label: "Med" },
			{ id: "high", label: "High" },
			{ id: "xhigh", label: "XHigh" },
		],
		value: "high",
		detail: "demo",
		icon: "brain",
		keys: ["left", "right"],
	});

	// A model without reasoning freezes the slider at Off.
	picker.handleNativeEvent({ type: "select", key: "", item: "local/tiny" });
	expect(props(picker.describe(withPicker)).level).toMatchObject({
		steps: ["off", "minimal", "low", "medium", "high"].map(id => expect.objectContaining({ id })),
		value: "off",
		detail: "local",
		disabled: "tiny does not reason",
	});

	quickAct(picker, "task");
	root = picker.describe(withPicker);
	p = props(root);
	expect(p.placeholder).toBe("Search Task models…");
	expect(p.actions).toEqual([
		{ id: "task", label: "Task / Main", keys: ["alt", "p"], on: true, head: true, icon: "users" },
	]);
	picker.handleNativeEvent({ type: "activate", key: "", item: "openai/gpt-5.6" });
	expect(picked).toEqual(["task:openai/gpt-5.6"]);
});

test("a provider scope lists only its models, Tab cycles scopes, and the active provider again restores all", () => {
	const picker = openQuickPicker([]);
	const all = rowIds(props(picker.describe(withPicker)));
	expect(all).toHaveLength(QUICK_MODELS.length);

	quickAct(picker, "scope", "provider:openai");
	let p = props(picker.describe(withPicker));
	expect(p.scope).toBe("provider:openai");
	expect(rowIds(p).toSorted()).toEqual(["openai/gpt-5.6", "openai/gpt-5.6-mini"]);
	expect(p.total).toBe(2);

	// Search applies within the scope.
	for (const char of "mini") picker.handleInput(char);
	const searched = props(picker.describe(withPicker));
	expect(rowIds(searched)).toEqual(["openai/gpt-5.6-mini"]);
	// The row shows the model id alone (its provider in the tooltip); the hit marks the id.
	const label = "gpt-5.6-mini";
	const row = searched.items?.find(item => item.id === "openai/gpt-5.6-mini");
	expect(row?.label).toBe(label);
	expect(row?.title?.startsWith("openai")).toBe(true);
	const [[from, to]] = searched.hits?.["openai/gpt-5.6-mini"] ?? [[0, 0]];
	expect(label.slice(from, to)).toBe("mini");
	quickAct(picker, "clear");

	quickAct(picker, "scope", "provider:openai");
	p = props(picker.describe(withPicker));
	expect(p.scope).toBe("all");
	expect(rowIds(p).toSorted()).toEqual(all.toSorted());

	picker.handleInput("\t");
	expect(props(picker.describe(withPicker)).scope).toBe("provider:anthropic");
	picker.handleInput("\x1b[Z");
	picker.handleInput("\x1b[Z");
	expect(props(picker.describe(withPicker)).scope).toBe("provider:openai");

	// `@` quick roles drop the scopes and come back to All.
	picker.handleInput("@");
	expect(props(picker.describe(withPicker)).scopes).toBeUndefined();
	picker.handleInput("\x7f");
	expect(props(picker.describe(withPicker)).scope).toBe("all");
});

test("←/→ and the slider set the thinking level a pick applies, clamped to the picked model", () => {
	const picked: string[] = [];
	const picker = openQuickPicker(picked);
	const level = () => props(picker.describe(withPicker)).level;

	// Untouched, a pick leaves the level to the host.
	picker.handleInput("\r");
	expect(picked).toEqual(["session:demo/demo"]);

	picker.handleInput("\x1b[C"); // →
	expect(level()?.value).toBe("xhigh");
	picker.handleInput("\x1b[C"); // stops at the top step
	expect(level()?.value).toBe("xhigh");
	picker.handleInput("\x1b[D"); // ←
	picker.handleInput("\x1b[D");
	expect(level()?.value).toBe("medium");
	quickAct(picker, "level", "low");
	expect(level()?.value).toBe("low");
	quickAct(picker, "level", "bogus");
	expect(level()?.value).toBe("low");
	picker.handleInput("\r");
	expect(picked.at(-1)).toBe("session:demo/demo:low");

	// The pending level clamps to the highlighted model's ladder.
	quickAct(picker, "level", "xhigh");
	picker.handleNativeEvent({ type: "select", key: "", item: "demo/demo-lite" });
	expect(level()?.value).toBe("medium");
	picker.handleNativeEvent({ type: "activate", key: "", item: "demo/demo-lite" });
	expect(picked.at(-1)).toBe("session:demo/demo-lite:medium");

	// A model without reasoning gets no level.
	picker.handleNativeEvent({ type: "activate", key: "", item: "local/tiny" });
	expect(picked.at(-1)).toBe("session:local/tiny");
});

test("Esc keeps a level moved on the current model's row and drops one moved elsewhere", () => {
	const picked: string[] = [];
	const picker = openQuickPicker(picked);

	// Untouched: Esc only closes.
	picker.handleInput("\x1b");
	expect(picked).toEqual(["cancel"]);

	picker.handleInput("\x1b[D"); // ← on demo/demo (current)
	picker.handleInput("\x1b");
	expect(picked.slice(1)).toEqual(["keep:medium", "cancel"]);

	// Moved while another model is highlighted: Esc leaves the session's level alone.
	const other = openQuickPicker(picked);
	picked.length = 0;
	other.handleNativeEvent({ type: "select", key: "", item: "demo/demo-lite" });
	quickAct(other, "level", "low");
	other.handleInput("\x1b");
	expect(picked).toEqual(["cancel"]);
});

test("the thinking slider is session-only: none in task mode or among quick roles", () => {
	const picker = openQuickPicker([]);
	expect(props(picker.describe(withPicker)).level).not.toBeNull();
	quickAct(picker, "task");
	expect(props(picker.describe(withPicker)).level).toBeNull();
	quickAct(picker, "task");
	picker.handleInput("@");
	const p = props(picker.describe(withPicker));
	expect(p.level).toBeNull();
	expect(p.scopes).toBeUndefined();
	expect(p.actions).toEqual([]);
});

test("shows a non-default service tier's own speed aggregate", () => {
	const perf = new Map([
		["openai/gpt-5.6", { samples: 4, tps: 25, ttftMs: 500 }],
		["openai/gpt-5.6@ultrafast", { samples: 2, tps: 300, ttftMs: 120 }],
		["anthropic/claude-opus-5", { samples: 3, tps: 40, ttftMs: 300 }],
		["openai/gpt-5.6-mini@priority", { samples: 1, tps: 90, ttftMs: 200 }],
	]);
	const hub = new ModelHubComponent(
		ui,
		{
			...source({ default: "demo/demo" }, ["demo/demo"]),
			modelPerf: perf,
			serviceTierFor: model => (model.provider === "openai" ? "ultrafast" : undefined),
		},
		registry(MODELS),
		MODELS.map(entry => ({ model: entry })),
		{ onAssign: () => {}, onUnassign: () => {}, onCancel: () => {} },
		{ currentSelector: "demo/demo" },
	);
	hubs.push(hub);
	const items = props(hub.describe(withPicker)).items ?? [];
	const speed = (id: string) => items.find(entry => entry.id === id)?.facts?.speed;
	// The tier the host would send wins over the standard aggregate.
	expect(speed("openai/gpt-5.6")).toBe("300 ultrafast");
	// No tier configured for the family: the standard aggregate, unlabeled.
	expect(speed("anthropic/claude-opus-5")).toBe("40");
	// Only a tier aggregate exists: show it rather than nothing.
	expect(speed("openai/gpt-5.6-mini")).toBe("90 priority");
});
