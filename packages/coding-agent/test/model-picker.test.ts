import { beforeAll, describe, expect, type Mock, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelPickerComponent, type ModelPickerOptions } from "@oh-my-pi/pi-coding-agent/modes/components/model-picker";
import { resolveSegmentPalette } from "@oh-my-pi/pi-coding-agent/modes/components/segment-track";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ResolvedRoleModel } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { TUI } from "@oh-my-pi/pi-tui";

function normalize(lines: readonly string[]): string {
	return stripVTControlCharacters(lines.join("\n")).replace(/\s+/g, " ").trim();
}

function makeModel(provider: string, id: string, contextWindow = 128_000): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 1024,
	});
}

let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for ModelPicker tests");
	}
	setThemeInstance(testTheme);
}

interface RegistryOverrides {
	refresh?: (mode: string) => Promise<void>;
}

interface PickerHarness {
	picker: ModelPickerComponent;
	onPick: Mock<(model: Model, selector: string, meta: { overContext: boolean }) => void>;
	onPickRole: Mock<(entry: ResolvedRoleModel) => void>;
	onCancel: Mock<() => void>;
}

function createPicker(options: {
	models: Model[] | (() => Model[]);
	scoped?: boolean;
	settings?: Settings;
	registry?: RegistryOverrides;
	picker?: ModelPickerOptions;
}): PickerHarness {
	installTestTheme();
	const modelsFn = typeof options.models === "function" ? options.models : () => options.models as Model[];
	const settings = options.settings ?? Settings.isolated({});
	const registry = {
		refresh: options.registry?.refresh ?? (async () => {}),
		getError: () => undefined,
		getAvailable: modelsFn,
		getAll: modelsFn,
	} as unknown as ModelRegistry;
	const ui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
	const onPick = vi.fn();
	const onPickRole = vi.fn();
	const onCancel = vi.fn();
	const picker = new ModelPickerComponent(
		ui,
		settings,
		registry,
		options.scoped ? modelsFn().map(model => ({ model })) : [],
		{ onPick, onPickRole, onCancel },
		options.picker ?? {},
	);
	return { picker, onPick, onPickRole, onCancel };
}

const DOWN = "\x1b[B";
const ESC = "\x1b";

describe("ModelPicker", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for ModelPicker tests");
		}
	});

	test("flags over-context models but keeps them selectable, reporting overContext on pick", () => {
		const small = makeModel("test", "a-small", 4096);
		const large = makeModel("test", "b-large", 128_000);
		const { picker, onPick } = createPicker({
			models: [small, large],
			scoped: true,
			picker: { currentContextTokens: 6000 },
		});

		expect(normalize(picker.render(220))).toContain("Session-only switch");

		picker.handleInput("small");
		const rendered = normalize(picker.render(220));
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

	test("uses cached models for Enter while the offline refresh is still pending", () => {
		const cached = makeModel("test", "cached-fast");
		const refreshGate = Promise.withResolvers<void>();
		const refresh = vi.fn(() => refreshGate.promise);
		const { picker, onPick } = createPicker({
			models: [cached],
			registry: { refresh },
		});

		picker.handleInput("\n");
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]?.[0]).toBe(cached);
		expect(refresh).toHaveBeenCalledTimes(1);
		refreshGate.resolve();
	});

	test("keeps the highlighted model when a background refresh reorders the list", async () => {
		const modelBb = makeModel("test", "bb-model");
		const modelCc = makeModel("test", "cc-model");
		const modelAa = makeModel("test", "aa-model");
		let available = [modelBb, modelCc];
		const refreshGate = Promise.withResolvers<void>();
		const { picker, onPick } = createPicker({
			models: () => available,
			registry: { refresh: () => refreshGate.promise },
		});

		picker.handleInput(DOWN); // highlight cc-model
		available = [modelAa, modelBb, modelCc];
		refreshGate.resolve();
		// Not a tuned delay: one zero-length tick drains the component's
		// refresh().then(...) continuation chain deterministically.
		await Bun.sleep(0);
		picker.handleInput("\n");
		expect(onPick.mock.calls[0]?.[0]?.id).toBe("cc-model");
	});

	test("highlights and preselects the session's current model", () => {
		const models = [makeModel("test", "aa-model"), makeModel("test", "bb-model"), makeModel("test", "cc-model")];
		const { picker, onPick } = createPicker({
			models,
			scoped: true,
			picker: { currentSelector: "test/bb-model" },
		});

		// The detail block tags the selected (= current) model.
		expect(normalize(picker.render(220))).toContain("current");

		// Enter without navigation picks the preselected current model.
		picker.handleInput("\n");
		expect(onPick.mock.calls[0]?.[0]?.id).toBe("bb-model");
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
		const rendered = picker.render(220);
		const frame = rendered.join("\n");
		expect(normalize(rendered)).toContain("@smol");
		expect(normalize(rendered)).toContain("@slow");
		const palette = resolveSegmentPalette(2);
		expect(frame).toContain(`${theme.getFgAnsi(palette[0])}@smol`);
		expect(frame).toContain(`${theme.getFgAnsi(palette[1])}@slow`);

		picker.handleInput("\n");
		expect(onPickRole).toHaveBeenCalledWith(quickRoles[1]);
		expect(onPick).not.toHaveBeenCalled();
	});

	test("Esc clears an active query first, then cancels", () => {
		const { picker, onCancel } = createPicker({ models: [makeModel("test", "test-model")], scoped: true });

		picker.handleInput("q");
		picker.handleInput(ESC);
		expect(onCancel).not.toHaveBeenCalled();

		picker.handleInput(ESC);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
