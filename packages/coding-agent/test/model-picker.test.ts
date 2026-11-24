import { afterEach, describe, expect, type Mock, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ModelPickerOptions } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/model-picker";
import type { ResolvedRoleModel } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { createModelBrowserSource } from "../src/modes/model-browser-source";
import { ModelPicker } from "../src/ui/overlays/pickers/model-picker";
import { segmentPalette } from "../src/ui/styles/pickers/model-browser";
import { type LayerTerminal, mountLayer, paintedIn } from "./helpers/layer-terminal";

function normalize(lines: readonly string[]): string {
	return stripVTControlCharacters(lines.join("\n")).replace(/\s+/g, " ").trim();
}

function makeModel(provider: string, id: string, contextWindow = 128_000, kind?: Model["kind"]): Model {
	return buildModel({
		id,
		name: id,
		api: kind === "image" ? "openai-images" : "ollama-chat",
		...(kind ? { kind } : {}),
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 1024,
	});
}

interface RegistryOverrides {
	refreshIfStale?: () => Promise<boolean>;
}

interface PickerHarness {
	picker: LayerTerminal;
	onPick: Mock<(model: Model, selector: string, meta: { overContext: boolean }) => void>;
	onPickRole: Mock<(entry: ResolvedRoleModel) => void>;
	onCancel: Mock<() => void>;
}

const openPickers: LayerTerminal[] = [];

function createPicker(options: {
	models: Model[] | (() => Model[]);
	scoped?: boolean;
	settings?: Settings;
	registry?: RegistryOverrides;
	picker?: ModelPickerOptions;
	onCatalogRefreshed?: () => Promise<ReadonlyArray<{ model: Model }>>;
}): PickerHarness {
	const modelsFn = typeof options.models === "function" ? options.models : () => options.models as Model[];
	const settings = options.settings ?? Settings.isolated({});
	const registry = {
		refreshIfStale: options.registry?.refreshIfStale ?? (async () => false),
		getError: () => undefined,
		getAvailable: modelsFn,
		getAll: modelsFn,
	} as unknown as ModelRegistry;
	const onPick = vi.fn();
	const onPickRole = vi.fn();
	const onCancel = vi.fn();
	const picker = mountLayer(
		() =>
			ModelPicker({
				source: createModelBrowserSource(settings),
				registry,
				scopedModels: options.scoped ? modelsFn().map(model => ({ model })) : [],
				callbacks: {
					onPick,
					onPickRole,
					onCancel,
					onCatalogRefreshed: options.onCatalogRefreshed,
				},
				options: options.picker ?? {},
				terminalRows: () => 40,
			}),
		{ columns: 220, rows: 40 },
	);
	openPickers.push(picker);
	return { picker, onPick, onPickRole, onCancel };
}

/** Drain the catalog catch-up's continuation chain. */
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

const DOWN = "\x1b[B";
const ESC = "\x1b";

describe("ModelPicker", () => {
	afterEach(() => {
		for (const picker of openPickers.splice(0)) picker.dispose();
	});

	test("shows kind-role metadata only on accepted model kinds", () => {
		const chat = makeModel("test", "chat-model");
		const image = makeModel("test", "image-model", 128_000, "image");
		const settings = Settings.isolated({
			modelRoles: { image: "test/image-model" },
		});
		const { picker } = createPicker({
			models: [chat, image],
			scoped: true,
			settings,
		});

		picker.handleInput("image");

		expect(normalize(picker.render())).toContain("● image");
	});

	test("flags over-context models but keeps them selectable, reporting overContext on pick", () => {
		const small = makeModel("test", "a-small", 4096);
		const large = makeModel("test", "b-large", 128_000);
		const { picker, onPick } = createPicker({
			models: [small, large],
			scoped: true,
			picker: { currentContextTokens: 6000 },
		});

		expect(normalize(picker.render())).toContain("Session-only switch");

		picker.handleInput("small");
		const rendered = normalize(picker.render());
		expect(rendered).toContain("context>4.1k");
		expect(rendered).toContain("compacts with current model");

		picker.handleInput("\n");
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]?.[0]).toBe(small);
		expect(onPick.mock.calls[0]?.[2]).toEqual({ overContext: true });
	});

	test("picking a model that fits reports overContext false", () => {
		const small = makeModel("test", "a-small", 4096);
		const large = makeModel("test", "b-large", 128_000);
		const { picker, onPick } = createPicker({
			models: [small, large],
			scoped: true,
			picker: { currentContextTokens: 6000 },
		});

		picker.handleInput("large");
		picker.handleInput("\n");
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]?.[0]).toBe(large);
		expect(onPick.mock.calls[0]?.[2]).toEqual({ overContext: false });
	});

	test("uses cached models for Enter while the catalog catch-up is still pending", () => {
		const cached = makeModel("test", "cached-fast");
		const refreshGate = Promise.withResolvers<boolean>();
		const refreshIfStale = vi.fn(() => refreshGate.promise);
		const { picker, onPick } = createPicker({
			models: [cached],
			registry: { refreshIfStale },
		});

		picker.handleInput("\n");
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]?.[0]).toBe(cached);
		expect(refreshIfStale).toHaveBeenCalledTimes(1);
		refreshGate.resolve(true);
	});

	test("keeps the highlighted model when a background refresh reorders the list", async () => {
		const modelBb = makeModel("test", "bb-model");
		const modelCc = makeModel("test", "cc-model");
		const modelAa = makeModel("test", "aa-model");
		let available = [modelBb, modelCc];
		const refreshGate = Promise.withResolvers<boolean>();
		const { picker, onPick } = createPicker({
			models: () => available,
			registry: { refreshIfStale: () => refreshGate.promise },
		});

		picker.handleInput(DOWN); // highlight cc-model
		available = [modelAa, modelBb, modelCc];
		refreshGate.resolve(true);
		// Not a tuned delay: one zero-length tick drains the component's
		// refreshIfStale().then(...) continuation chain deterministically.
		await Bun.sleep(0);
		picker.handleInput("\n");
		expect(onPick.mock.calls[0]?.[0]?.id).toBe("cc-model");
	});

	test("a --models scope lists a model the catalog refresh found", async () => {
		const old = makeModel("devin", "old-model");
		const added = makeModel("devin", "new-model");
		const refreshGate = Promise.withResolvers<boolean>();
		const { picker, onPick } = createPicker({
			models: [old],
			scoped: true,
			registry: { refreshIfStale: () => refreshGate.promise },
			onCatalogRefreshed: async () => [{ model: old }, { model: added }],
		});

		refreshGate.resolve(true);
		await settle();
		picker.handleInput("new-model");
		picker.handleInput("\n");
		expect(onPick.mock.calls[0]?.[0]).toBe(added);
	});

	test("highlights and preselects the session's current model", () => {
		const models = [makeModel("test", "aa-model"), makeModel("test", "bb-model"), makeModel("test", "cc-model")];
		const { picker, onPick } = createPicker({
			models,
			scoped: true,
			picker: { currentSelector: "test/bb-model" },
		});

		// The detail block tags the selected (= current) model.
		expect(normalize(picker.render())).toContain("current");

		// Enter without navigation picks the preselected current model.
		picker.handleInput("\n");
		expect(onPick.mock.calls[0]?.[0]?.id).toBe("bb-model");
	});

	test("search jumps to the first result when choices through the current model change", () => {
		const models = [makeModel("test", "aa-unrelated"), makeModel("test", "bb-match"), makeModel("test", "cc-match")];
		const { picker, onPick } = createPicker({
			models,
			scoped: true,
			picker: { currentSelector: "test/cc-match" },
		});

		picker.handleInput("match");
		picker.handleInput("\n");

		expect(onPick.mock.calls[0]?.[0]?.id).toBe("bb-match");
	});

	test("search keeps the selection when every choice through it stays unchanged", () => {
		const models = [makeModel("test", "aa-shared"), makeModel("test", "bb-shared"), makeModel("test", "cc-shared")];
		const { picker, onPick } = createPicker({
			models,
			scoped: true,
			picker: { currentSelector: "test/cc-shared" },
		});

		picker.handleInput("shared");
		picker.handleInput("\n");

		expect(onPick.mock.calls[0]?.[0]?.id).toBe("cc-shared");
	});

	test("shows and applies ctrl+p quick roles when search starts with @", () => {
		const smol = makeModel("test", "smol-model");
		const slow = makeModel("test", "slow-model");
		const quickRoles: ResolvedRoleModel[] = [
			{ role: "smol", model: smol, explicitThinkingLevel: false },
			{ role: "slow", model: slow, explicitThinkingLevel: false },
		];
		const { picker, onPick, onPickRole } = createPicker({
			models: [smol, slow],
			scoped: true,
			picker: {
				quickRoles,
				quickRoleOrder: ["smol", "slow"],
				currentQuickRole: "slow",
			},
		});

		picker.handleInput("@");
		const rendered = picker.render();
		const frame = rendered.join("\n");
		expect(normalize(rendered)).toContain("@smol");
		expect(normalize(rendered)).toContain("@slow");
		const palette = segmentPalette(currentTheme(), 2);
		expect(paintedIn(frame, currentTheme().fgSgr(palette[0]!), "@smol")).toBe(true);
		expect(paintedIn(frame, currentTheme().fgSgr(palette[1]!), "@slow")).toBe(true);

		picker.handleInput("\n");
		expect(onPickRole).toHaveBeenCalledWith(quickRoles[1]);
		expect(onPick).not.toHaveBeenCalled();
	});

	test("Esc clears an active query first, then cancels", () => {
		const { picker, onCancel } = createPicker({
			models: [makeModel("test", "test-model")],
			scoped: true,
		});

		picker.handleInput("q");
		picker.handleInput(ESC);
		expect(onCancel).not.toHaveBeenCalled();

		picker.handleInput(ESC);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
