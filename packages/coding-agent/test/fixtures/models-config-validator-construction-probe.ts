import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { YAML } from "bun";

interface HeapSnapshot {
	nodes: number[];
	snapshot: { meta: { node_fields: string[] } };
}

interface ProbeResult {
	retainedHeapNodes: number;
	schemaIdentityStable?: boolean;
	model?: {
		provider: string;
		id: string;
		baseUrl: string;
		api: string;
		thinking?: unknown;
	};
}

const root = process.argv[2];
if (!root) {
	throw new Error("Expected an isolated config root");
}

function retainedHeapNodes(): number {
	Bun.gc(true);
	const snapshot = JSON.parse(Bun.generateHeapSnapshot("v8")) as HeapSnapshot;
	return snapshot.nodes.length / snapshot.snapshot.meta.node_fields.length;
}

async function measureMissing(): Promise<ProbeResult> {
	let model: ProbeResult["model"];
	{
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const registry = new ModelRegistry(authStorage, path.join(root, "missing", "models.yml"));
			const found = registry.find("anthropic", "claude-sonnet-4-5");
			model = found && {
				provider: found.provider,
				id: found.id,
				baseUrl: found.baseUrl,
				api: found.api,
				thinking: found.thinking,
			};
		} finally {
			authStorage.close();
		}
	}
	return { retainedHeapNodes: retainedHeapNodes(), model };
}

async function writeCustomConfig(): Promise<string> {
	const configPath = path.join(root, "custom", "models.yml");
	await Bun.write(
		configPath,
		YAML.stringify(
			{
				providers: {
					"lazy-models": {
						baseUrl: "https://lazy.example/v1",
						api: "openai-responses",
						auth: "none",
						models: [
							{
								id: "lazy-model",
								reasoning: true,
								thinking: {
									mode: "effort",
									minLevel: "low",
									maxLevel: "high",
									defaultLevel: "medium",
									requiresEffort: false,
								},
							},
						],
					},
				},
			},
			null,
			2,
		),
	);
	return configPath;
}

async function measureCustom(configPath: string): Promise<ProbeResult> {
	let model: ProbeResult["model"];
	let schemaIdentityStable = false;
	{
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const registry = new ModelRegistry(authStorage, configPath);
			const found = registry.find("lazy-models", "lazy-model");
			model = found && {
				provider: found.provider,
				id: found.id,
				baseUrl: found.baseUrl,
				api: found.api,
				thinking: found.thinking,
			};
			const firstSchema = ModelsConfigFile.relocate(configPath).schema;
			const secondSchema = ModelsConfigFile.relocate(path.join(root, "second", "models.yml")).schema;
			schemaIdentityStable = firstSchema === secondSchema;
		} finally {
			authStorage.close();
		}
	}
	return {
		retainedHeapNodes: retainedHeapNodes(),
		schemaIdentityStable,
		model,
	};
}

const missing = await measureMissing();
const custom = await measureCustom(await writeCustomConfig());
process.stdout.write(JSON.stringify({ missing, custom }));
