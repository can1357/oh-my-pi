import * as fs from "node:fs";
import { Effort } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type GeneratedProvider, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { type Model, modelKind } from "@oh-my-pi/pi-catalog/types";
import { createInMemoryAuthStorage } from "./agent-session-setup";

/** Select a bundled chat model by behavior so tests survive catalog roster changes. */
export function getTestModel(provider: GeneratedProvider, matches?: (model: Model) => boolean): Model {
	const model = getBundledModels(provider).find(
		candidate => modelKind(candidate) === "chat" && (matches === undefined || matches(candidate)),
	);
	if (!model) throw new Error(`No bundled chat model matches the ${provider} test fixture`);
	return model;
}

type TaskModelFixtureKey = "parent" | "primary" | "fallback" | "unassigned" | "plain" | "colon";

export interface TaskModelFixture {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	models: Record<TaskModelFixtureKey, Model>;
	selectors: Record<TaskModelFixtureKey, string>;
	getActiveModel(): Model;
	getActiveModelString(): string;
	close(): void;
}

/** Local-only catalog/auth fixture; callers must grant models independently in settings or agent frontmatter. */
export function createTaskModelFixture(
	settings?: Settings,
	options: { authenticated?: boolean } = {},
): TaskModelFixture {
	const directory = TempDir.createSync("@omp-task-models-");
	const authStorage = createInMemoryAuthStorage();
	const provider = "routing-test";
	if (options.authenticated !== false) authStorage.keys.setRuntime(provider, "test-only-key");
	const ids = {
		parent: "parent",
		primary: "primary",
		fallback: "fallback",
		unassigned: "unassigned",
		plain: "plain",
		colon: "colon:model",
	} as const;
	fs.writeFileSync(
		directory.join("models.yml"),
		JSON.stringify({
			providers: {
				[provider]: {
					baseUrl: "http://127.0.0.1:1/v1",
					api: "openai-completions",
					auth: "oauth",
					models: Object.values(ids).map(id => ({
						id,
						name: id,
						reasoning: id !== ids.plain,
						...(id !== ids.plain
							? { thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] } }
							: {}),
						input: ["text", "image"],
						supportsTools: true,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8192,
					})),
				},
			},
		}),
	);
	const modelRegistry = new ModelRegistry(authStorage, directory.join("models.yml"), {
		settings,
		fetch: async () => {
			throw new Error("Routing test fixtures must not contact a provider");
		},
	});
	const models = Object.fromEntries(
		Object.entries(ids).map(([key, id]) => {
			const model = modelRegistry.find(provider, id);
			if (!model) throw new Error(`Missing routing fixture model ${provider}/${id}`);
			return [key, model];
		}),
	) as Record<keyof typeof ids, Model>;
	const selectors = Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, `${provider}/${id}`])) as Record<
		keyof typeof ids,
		string
	>;
	return {
		authStorage,
		modelRegistry,
		models,
		selectors,
		getActiveModel: () => models.parent,
		getActiveModelString: () => `${selectors.parent}:medium`,
		close: () => {
			authStorage.close();
			directory.removeSync();
		},
	};
}
