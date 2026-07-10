import * as fs from "node:fs/promises";
import { cloneDefaultConfig } from "./defaults.js";
import type { ModelProfile, RouterConfig, TaskSpawnConfig, TaskSpawnLabelMappings } from "./types.js";
import { validateTaskSpawnConfig } from "./validation.js";

export interface LoadedConfig {
	config: RouterConfig;
	path?: string;
	warnings: string[];
}

export async function loadRouterConfig(
	options: { cwd?: string; path?: string; env?: Record<string, string | undefined> } = {},
): Promise<LoadedConfig> {
	const env = options.env ?? getProcessEnv();
	const candidates = candidatePaths(
		options.cwd ?? getCwd(),
		options.path ?? env.LLM_ROUTER_CONFIG,
		env.HOME ?? env.USERPROFILE,
	);
	const warnings: string[] = [];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const exists = await fileExists(candidate);
		if (!exists) continue;
		try {
			const raw = await readText(candidate);
			const partial = JSON.parse(raw) as Partial<RouterConfig>;
			const config = mergeConfig(cloneDefaultConfig(), partial);
			normalizeConfig(config, warnings);
			return { config, path: candidate, warnings };
		} catch (error) {
			warnings.push(`Failed to load ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const config = cloneDefaultConfig();
	normalizeConfig(config, warnings);
	return { config, warnings };
}

export function mergeConfig(base: RouterConfig, override: Partial<RouterConfig>): RouterConfig {
	const merged: RouterConfig = {
		...base,
		...override,
		objectives: { ...base.objectives, ...(override.objectives ?? {}) },
		models: mergeModelProfiles(base.models, override.models ?? {}),
		rules: override.rules ?? base.rules,
		learned: { ...(base.learned ?? { enabled: false }), ...(override.learned ?? {}) },
		telemetry: { ...(base.telemetry ?? { enabled: false }), ...(override.telemetry ?? {}) },
		toolCapture: { ...(base.toolCapture ?? { enabled: false }), ...(override.toolCapture ?? {}) },
		extension: {
			...(base.extension ?? {
				mode: "recommend",
				routeOnInput: true,
				notifyOnInput: false,
				exposeTools: true,
				exposeCommand: true,
			}),
			...(override.extension ?? {}),
		},
		validation: { ...(base.validation ?? {}), ...(override.validation ?? {}) },
		taskSpawn: mergeTaskSpawnConfig(base.taskSpawn, override.taskSpawn),
	};
	return merged;
}

export function normalizeConfig(config: RouterConfig, warnings: string[] = []): RouterConfig {
	const total =
		config.objectives.quality + config.objectives.latency + config.objectives.cost + config.objectives.safety;
	if (total <= 0) {
		warnings.push("Objective weights summed to zero; using balanced defaults.");
		config.objectives = { quality: 0.45, latency: 0.2, cost: 0.2, safety: 0.15 };
	} else if (Math.abs(total - 1) > 0.001) {
		config.objectives = {
			quality: config.objectives.quality / total,
			latency: config.objectives.latency / total,
			cost: config.objectives.cost / total,
			safety: config.objectives.safety / total,
		};
	}
	for (const [id, model] of Object.entries(config.models)) {
		model.id = model.id || id;
		if (!model.selector) {
			warnings.push(`Model ${id} had no selector; using id as selector.`);
			model.selector = id;
		}
		model.quality = clamp01(model.quality);
		model.safety = clamp01(model.safety);
		model.latencyMsP95 = Math.max(1, model.latencyMsP95);
		model.costPerMillionTokens = Math.max(0, model.costPerMillionTokens);
		model.contextWindow = Math.max(1_000, model.contextWindow);
	}
	config.rules = [...config.rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
	config.taskSpawn = normalizeTaskSpawnConfig(config.taskSpawn);
	return config;
}

export function validateRouterConfig(config: RouterConfig): string[] {
	const errors: string[] = [];
	if (!config.version) errors.push("version is required");
	if (Object.keys(config.models).length === 0) errors.push("at least one model profile is required");
	for (const [id, model] of Object.entries(config.models)) {
		if (!model.selector) errors.push(`models.${id}.selector is required`);
		if (model.quality < 0 || model.quality > 1) errors.push(`models.${id}.quality must be 0..1`);
		if (model.safety < 0 || model.safety > 1) errors.push(`models.${id}.safety must be 0..1`);
	}
	for (const rule of config.rules) {
		if (!config.models[rule.route.model])
			errors.push(`rule ${rule.name} routes to unknown model ${rule.route.model}`);
		for (const fallback of rule.route.fallback ?? []) {
			if (!config.models[fallback]) errors.push(`rule ${rule.name} has unknown fallback ${fallback}`);
		}
	}
	errors.push(...validateTaskSpawnConfig(config.taskSpawn));
	return errors;
}

function mergeModelProfiles(
	base: Record<string, ModelProfile>,
	override: Record<string, ModelProfile>,
): Record<string, ModelProfile> {
	const merged: Record<string, ModelProfile> = JSON.parse(JSON.stringify(base)) as Record<string, ModelProfile>;
	for (const [id, profile] of Object.entries(override)) {
		merged[id] = { ...(merged[id] ?? {}), ...profile, id } as ModelProfile;
	}
	return merged;
}

function candidatePaths(cwd: string, explicit?: string, home?: string): string[] {
	const paths = [];
	if (explicit) paths.push(resolvePath(explicit, cwd));
	paths.push(resolvePath(".llm-router/config.json", cwd));
	paths.push(resolvePath(".llm-router.json", cwd));
	if (home) paths.push(resolvePath(".omp/agent/llm-router.json", home));
	return paths;
}

const DEFAULT_TASK_SPAWN_LABEL_MAPPINGS: TaskSpawnLabelMappings = {
	light: "light",
	mid: "mid",
	heavy: "frontier",
};

const DEFAULT_TASK_SPAWN_TIMEOUT_MS = 3_000;
const DEFAULT_TASK_SPAWN_ENDPOINT = "http://127.0.0.1:8901/v1/chat/completions";
const DEFAULT_TASK_SPAWN_SYSTEM_PROMPT =
	"You are a routing classifier. Read the user request and output ONLY one word — the minimum model tier needed to answer it well:\n" +
	"light = trivial/one-step/factual/simple rewrite (an 8B model suffices)\n" +
	"mid = standard work: single-file code, moderate reasoning, summaries, normal Q&A\n" +
	"heavy = hard multi-step reasoning, multi-file/architectural code, deep debugging, proofs, long-context synthesis, open-ended design\n" +
	"Answer with exactly one of: light, mid, heavy.";

function mergeTaskSpawnConfig(
	base: TaskSpawnConfig | undefined,
	override: TaskSpawnConfig | undefined,
): TaskSpawnConfig {
	const merged: TaskSpawnConfig = {
		enabled: false,
		...(base ?? {}),
		...(override ?? {}),
		labelMappings: {
			...DEFAULT_TASK_SPAWN_LABEL_MAPPINGS,
			...(base?.labelMappings ?? {}),
			...(override?.labelMappings ?? {}),
		},
	};
	return merged;
}

function normalizeTaskSpawnConfig(config: TaskSpawnConfig | undefined): TaskSpawnConfig {
	const labelMappings: TaskSpawnLabelMappings = {
		...DEFAULT_TASK_SPAWN_LABEL_MAPPINGS,
		...(config?.labelMappings ?? {}),
	};
	return {
		enabled: config?.enabled === true,
		endpoint: config?.endpoint?.trim() || DEFAULT_TASK_SPAWN_ENDPOINT,
		timeoutMs:
			typeof config?.timeoutMs === "number" && Number.isFinite(config.timeoutMs)
				? config.timeoutMs
				: DEFAULT_TASK_SPAWN_TIMEOUT_MS,
		systemPrompt: config?.systemPrompt?.trim() || DEFAULT_TASK_SPAWN_SYSTEM_PROMPT,
		model: config?.model?.trim() || "qwen3-router-q8_0",
		labelMappings,
	};
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

async function readText(path: string): Promise<string> {
	return fs.readFile(path, "utf8");
}

function resolvePath(path: string, cwd: string): string {
	if (path.startsWith("~/")) {
		const home = getProcessEnv().HOME ?? getProcessEnv().USERPROFILE ?? cwd;
		return `${home}${path.slice(1)}`;
	}
	if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
	return `${cwd.replace(/[\\/]$/, "")}/${path}`;
}

function getCwd(): string {
	try {
		return typeof process !== "undefined" && process.cwd ? process.cwd() : ".";
	} catch {
		return ".";
	}
}

function getProcessEnv(): Record<string, string | undefined> {
	return typeof process !== "undefined" ? (process.env ?? {}) : {};
}
