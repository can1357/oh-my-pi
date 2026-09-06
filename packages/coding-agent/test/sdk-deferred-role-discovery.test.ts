import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Regression for #8863: a deferred `--model @<role>` whose role maps to a model
// on a discovery-backed provider (ollama/oMLX/llama-swap) must trigger the
// online-if-uncached discovery refresh. Before the fix the deferred guard in
// sdk.ts treated the role's expanded `configuredPatterns` as a resolved runtime
// match, so `runtimeResolved` was `true`, the fallback refresh was skipped, and
// resolution failed with `Model "@<role>" not found`.
describe("createAgentSession deferred role alias on discoverable provider (#8863)", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	const savedOllamaEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		for (const key of ["OLLAMA_BASE_URL", "OLLAMA_HOST", "OLLAMA_CONTEXT_LENGTH"] as const) {
			savedOllamaEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
		tempDir = path.join(os.tmpdir(), `pi-test-sdk-deferred-role-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		for (const key of ["OLLAMA_BASE_URL", "OLLAMA_HOST", "OLLAMA_CONTEXT_LENGTH"] as const) {
			const original = savedOllamaEnv[key];
			if (original === undefined) delete Bun.env[key];
			else Bun.env[key] = original;
		}
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	const mockOllamaDiscovery = (modelNames: string[], endpoint = "http://127.0.0.1:11434"): FetchImpl => {
		return async input => {
			const url = String(input);
			if (url === `${endpoint}/api/tags`) {
				return new Response(JSON.stringify({ models: modelNames.map(name => ({ name })) }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === `${endpoint}/api/show`) {
				return new Response(JSON.stringify({ capabilities: ["completion"] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
	};

	it("refreshes discoverable providers so @smol resolves to the discovered model", async () => {
		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					ollama: {
						baseUrl: "http://127.0.0.1:11434/v1",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "ollama" },
					},
				},
			}),
		);
		// Fresh registry with no discovery cache: the ollama model is only
		// reachable through a refresh, which the deferred path must perform.
		const modelRegistry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: mockOllamaDiscovery(["phi3"]),
		});
		const settings = Settings.isolated({
			modelRoles: { smol: "ollama/phi3" },
			"compaction.enabled": false,
		});

		let session: AgentSession | undefined;
		try {
			const result = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(tempDir),
				authStorage,
				modelRegistry,
				settings,
				modelPattern: "@smol",
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				taskDepth: 1,
				agentId: "SubAgent",
			});
			session = result.session;

			expect(result.session.model?.provider).toBe("ollama");
			expect(result.session.model?.id).toBe("phi3");
		} finally {
			session?.dispose();
		}
	});
});
