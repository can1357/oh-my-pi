/**
 * Reads a generated `~/.omp/agent` the way the guest omp does and prints what it resolves.
 *
 * Runs as its own process so its environment is exactly the one the harness hands the
 * guest omp. argv[2] is a JSON {@link ConsumerRequest}; stdout is one JSON {@link ConsumerResult}.
 */
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

export interface ConsumerRequest {
	/** Directory holding the generated `models.yml` and `config.yml`. */
	agentDir: string;
	/** Provider ids to resolve an API key and request headers for. */
	providers: string[];
}

export interface ConsumerResult {
	modelsError: string | null;
	keys: Record<string, string | null>;
	headers: Record<string, Record<string, string> | null>;
	settings: Record<string, unknown>;
}

const request = JSON.parse(process.argv[2] ?? "") as ConsumerRequest;
const auth = await AuthStorage.create(":memory:");
try {
	const registry = new ModelRegistry(auth, path.join(request.agentDir, "models.yml"), {
		settings: Settings.isolated({}),
		fetch: () => Promise.reject(new Error("network disabled in config consumer")),
	});
	const result: ConsumerResult = {
		modelsError: registry.getError()?.message ?? null,
		keys: {},
		headers: {},
		settings: (
			await Settings.loadReadOnly({ agentDir: request.agentDir, cwd: request.agentDir })
		).getGlobalSettings(),
	};
	for (const provider of request.providers) {
		result.keys[provider] = (await registry.getApiKeyForProvider(provider)) ?? null;
		const model = registry.getAll("all").find(candidate => candidate.provider === provider);
		result.headers[provider] = model ? ((await registry.resolveModelHeaders(model)) ?? null) : null;
	}
	process.stdout.write(JSON.stringify(result));
} finally {
	auth.close();
}
