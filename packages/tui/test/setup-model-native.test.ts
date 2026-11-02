import { beforeAll, describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeNode } from "../src/native/node";
import type { ModelBrowserSource } from "../src/overlays/model-browser";
import { modelSetupScene } from "../src/setup/scenes/model";
import type { SetupHost, SetupSceneController, SetupSceneResult } from "../src/setup/scenes/types";
import { initTheme } from "../src/theme";

const cx: DescribeContext = { cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
const DOWN = "\x1b[B";
const ENTER = "\r";

beforeAll(async () => {
	await initTheme(false);
});

function model(provider: string, id: string): Model {
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
	});
}

const source: ModelBrowserSource = {
	revision: 0,
	defaultThinkingLevel: "off",
	modelProviderOrder: [],
	knownRoleIds: ["default"],
	mruOrder: [],
	modelPerf: new Map(),
	getRoleInfo: role => ({ tag: role, name: `${role} role`, section: "chat", accepts: () => true }),
	defaultRoleChain: () => [],
	resolveRoleValue: (value, models) => ({
		model: models.find(candidate => `${candidate.provider}/${candidate.id}` === value),
		explicitThinkingLevel: false,
	}),
	getModelRole: () => undefined,
};

interface Mounted {
	scene: SetupSceneController;
	results: SetupSceneResult[];
	/** Settles on the scene's first `finish`. */
	finished: Promise<SetupSceneResult>;
}

function mount(models: Model[], selectModel: SetupHost["selectModel"]): Mounted {
	const results: SetupSceneResult[] = [];
	const finished = Promise.withResolvers<SetupSceneResult>();
	const ctx = {
		modelSource: source,
		getModels: () => ({ available: models, all: models, current: undefined }),
		refreshModels: async () => {},
		selectModel,
	} as unknown as SetupHost;
	const scene = modelSetupScene.mount({
		ctx,
		requestRender() {},
		finish: result => {
			results.push(result);
			finished.resolve(result);
		},
		setFocus() {},
		restoreFocus() {},
	});
	return { scene, results, finished: finished.promise };
}

/** The picker sheet the scene presents (hoisted out of its page column by the reconciler). */
function sheet(scene: SetupSceneController): TspPickerProps {
	const root = scene.describe?.(cx);
	const picker = root?.c?.find((child): child is NativeNode => "k" in child && child.k === "picker");
	expect(picker).toBeDefined();
	return picker!.p as TspPickerProps;
}

function rowIds(props: TspPickerProps): string[] {
	return (props.order ?? []).filter((entry): entry is string => typeof entry === "string");
}

describe("setup model scene under native rendering", () => {
	it("keeps the sheet's selection on the row the keyboard moved to, past the first screen", async () => {
		const models = Array.from({ length: 40 }, (_, i) =>
			model(i < 20 ? "alpha" : "beta", `m-${String(i).padStart(2, "0")}`),
		);
		const { scene } = mount(models, async () => {});
		await scene.onMount?.();
		const rows = rowIds(sheet(scene));
		expect(sheet(scene).selected).toBe(rows[0]);

		for (let i = 0; i < 35; i++) scene.handleInput?.(DOWN);

		expect(sheet(scene).selected).toBe(rows[35]);
	});

	it("keeps the scene and its list on a failed save, then saves on the next Enter", async () => {
		const models = [model("alpha", "one"), model("alpha", "two")];
		const failure = Promise.withResolvers<void>();
		const saves = [failure.promise, Promise.resolve()];
		const saved: string[] = [];
		const { scene, results, finished } = mount(models, (_model, selector) => {
			saved.push(selector);
			return saves.shift()!;
		});
		await scene.onMount?.();

		scene.handleInput?.(ENTER);
		failure.reject(new Error("config is read-only"));
		// The scene awaited the save first, so its error handling has run once this settles.
		await failure.promise.catch(() => {});
		const failed = sheet(scene);
		expect(results).toEqual([]);
		expect(rowIds(failed)).toHaveLength(2);
		expect(JSON.stringify(failed.subtitle)).toContain("config is read-only");
		expect(failed.actions?.find(action => action.primary)?.disabled).toBeUndefined();

		scene.handleInput?.(ENTER);
		expect(await finished).toBe("done");
		expect(saved).toEqual([failed.selected!, failed.selected!]);
		expect(results).toEqual(["done"]);
	});
});
