/**
 * Skill-description compression starts while the SDK first builds the system prompt, before the
 * session it belongs to exists. Its requests must still stop when that session begins disposing:
 * the lifetime they carry has to exist before the first one starts, not be looked up afterwards.
 * Counted at a local endpoint, with the compression's credential held across SDK construction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ApiKeyResolveContext, ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ApiKeyResolverModel } from "@oh-my-pi/pi-coding-agent/config/api-key-resolver";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as skillDescriptions from "@oh-my-pi/pi-coding-agent/extensibility/skill-descriptions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/** One Anthropic streaming response whose text is `text`. */
function anthropicText(text: string): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_skill",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

describe("SDK startup skill-description compression at disposal", () => {
	let tempDir: TempDir;
	let server: Bun.Server<undefined>;
	let authStorage: AuthStorage;
	let store: skillDescriptions.SkillDescriptionStore;
	let session: AgentSession | undefined;
	/** For each request the endpoint received, whether the session was disposing. */
	let requests: boolean[];
	let credentialReached: PromiseWithResolvers<void>;
	let releaseCredential: PromiseWithResolvers<void>;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-dispose-skill-compression-");
		requests = [];
		session = undefined;
		credentialReached = Promise.withResolvers<void>();
		releaseCredential = Promise.withResolvers<void>();
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				await request.json();
				requests.push(session?.isDisposed === true);
				return anthropicText("Investigate request ownership at disposal.");
			},
		});
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		// Bun tests run without the skill-description store; this case needs the real one.
		store = skillDescriptions.SkillDescriptionStore.open(path.join(tempDir.path(), "skills.db"));
		vi.spyOn(skillDescriptions, "openSessionSkillDescriptionStore").mockReturnValue(store);
	});

	afterEach(async () => {
		releaseCredential.resolve();
		await session?.dispose();
		await store.close();
		authStorage.close();
		server.stop(true);
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	/** Create a session whose initial prompt schedules one compression, its credential held. */
	async function createWithHeldCompression(): Promise<AgentSession> {
		const model: Model<Api> = { ...getBundledModel("anthropic", "claude-sonnet-4-5")!, baseUrl: server.url.origin };
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([model]);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model]);
		vi.spyOn(modelRegistry, "getAvailableForProviders").mockReturnValue([model]);
		const resolve = modelRegistry.resolver.bind(modelRegistry) as (
			target: ApiKeyResolverModel,
			sessionId?: string,
		) => ApiKeyResolver;
		vi.spyOn(modelRegistry, "resolver").mockImplementation(((
			target: ApiKeyResolverModel,
			sessionId?: string,
		): ApiKeyResolver => {
			const real = resolve(target, sessionId);
			return async (context: ApiKeyResolveContext) => {
				credentialReached.resolve();
				await releaseCredential.promise;
				return real(context);
			};
		}) as typeof modelRegistry.resolver);
		const created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			model,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"modelRoles.smol": "anthropic/claude-sonnet-4-5",
				"modelRoles.tiny": "anthropic/claude-sonnet-4-5",
				skillful: true,
				"memory.backend": "off",
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			contextFiles: [],
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			bindProcessState: false,
			skills: [
				{
					name: "lifecycle-review",
					description: "Use this skill to investigate request ownership and lifecycle disposal. ".repeat(10),
					filePath: path.join(tempDir.path(), "skill.md"),
					baseDir: tempDir.path(),
					source: "custom",
				},
			],
		});
		session = created.session;
		return created.session;
	}

	// `store.close()` waits (bounded) for the compression to finish or be refused.
	it("sends the compression on a live session", async () => {
		await createWithHeldCompression();
		await credentialReached.promise;
		releaseCredential.resolve();
		await store.close();

		expect(requests).toEqual([false]);
	});

	it("sends no compression once the session begins disposing, though it started before the session existed", async () => {
		const created = await createWithHeldCompression();
		await credentialReached.promise;
		created.beginDispose();
		releaseCredential.resolve();
		await store.close();

		expect(requests).toEqual([]);
	});
});
