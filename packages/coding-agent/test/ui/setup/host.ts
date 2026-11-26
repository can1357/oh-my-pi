/**
 * A setup host for corpus cases: configured values from the case's inputs,
 * every side effect recorded in `events` (the stage notes of the capture).
 */
import type { AuthStorage, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { signal } from "@oh-my-pi/pi-tui";
import type { ModelBrowserSource } from "../../../src/modes/view-model/overlays/model-browser";
import type { GlyphPreset, SceneContext, SceneResult, SetupHost, ThemeLook } from "../../../src/ui/setup";

export function corpusModel(provider: string, id: string): Model {
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

/** Model preferences of the corpus: every role accepts every model, none assigned; no recency, no perf data. */
export const MODEL_SOURCE = {
	revision: 0,
	defaultThinkingLevel: "off",
	modelProviderOrder: [],
	knownRoleIds: ["default"],
	mruOrder: [],
	modelPerf: new Map(),
	getRoleInfo: (role: string) => ({ tag: role, name: `${role} role`, section: "chat", accepts: () => true }),
	defaultRoleChain: () => [],
	resolveRoleValue: (value: string, models: Model[]) => ({
		model: models.find(candidate => `${candidate.provider}/${candidate.id}` === value),
		explicitThinkingLevel: false,
	}),
	getModelRole: () => undefined,
} as unknown as ModelBrowserSource;

export interface FakeHostOptions {
	models?: Model[];
	current?: Model;
	composerShape?: string;
	autoUpdate?: boolean;
	refreshModels?: () => Promise<void>;
	selectModel?: (model: Model, selector: string) => Promise<void>;
	login?: (provider: string, callbacks: unknown) => Promise<void>;
	previewSymbolPreset?: (preset: GlyphPreset | null) => void;
	previewTheme?: (look: ThemeLook | null) => Promise<void> | void;
	listThemes?: () => Promise<readonly string[]>;
}

export interface FakeHost extends SetupHost {
	readonly events: string[];
}

export function fakeHost(options: FakeHostOptions = {}): FakeHost {
	const events: string[] = [];
	const models = options.models ?? [];
	const signedIn = new Set<string>();
	const authStorage = {
		credentials: { has: (id: string) => signedIn.has(id) },
		keys: { source: (id: string) => (signedIn.has(id) ? { kind: "oauth" } : undefined) },
		oauth: {
			async login(provider: string, callbacks: unknown): Promise<void> {
				events.push(`login ${provider}`);
				await (options.login ?? (async () => {}))(provider, callbacks);
				signedIn.add(provider);
			},
		},
	} as unknown as AuthStorage;
	return {
		events,
		composerShape: options.composerShape ?? "band",
		symbolPreset: "unicode",
		colorBlindMode: false,
		themeName: "dark",
		autoUpdate: options.autoUpdate ?? true,
		disabledProviders: [],
		authStorage,
		agentDir: "/corpus-home/.omp/agent",
		previewSymbolPreset: options.previewSymbolPreset,
		saveSymbolPreset: preset => void events.push(`saveSymbolPreset ${preset}`),
		saveComposerShape: async shape => void events.push(`saveComposerShape ${shape}`),
		saveAutoUpdate: async enabled => void events.push(`saveAutoUpdate ${enabled}`),
		previewTheme: options.previewTheme,
		saveTheme: (slot, name) => void events.push(`saveTheme ${slot} ${name}`),
		applyTheme: options.previewTheme,
		saveColorBlindMode: enabled => void events.push(`saveColorBlindMode ${enabled}`),
		listThemes: options.listThemes,
		modelSource: MODEL_SOURCE,
		getModels: () => ({ available: models, all: models, current: options.current }),
		refreshModels: async () => {
			events.push("refreshModels");
			await (options.refreshModels ?? (async () => {}))();
		},
		selectModel: async (model, selector) => {
			events.push(`selectModel ${selector}`);
			await (options.selectModel ?? (async () => {}))(model, selector);
		},
		refreshProvider: async provider => void events.push(`refreshProvider ${provider}`),
		openInBrowser: url => void events.push(`openInBrowser ${url}`),
	};
}

/** A scene context over `host` with a fixed body budget. */
export function sceneContext(host: FakeHost, maxLines: number | undefined): SceneContext {
	const budget = signal(maxLines);
	return {
		host,
		finish: (result: SceneResult) => void host.events.push(`finish ${result}`),
		maxLines: budget,
	};
}
