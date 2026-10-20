/**
 * Mnemopi provider credentials: a configured embedding key may name an
 * environment variable (like a provider `apiKey` in models.yml), and an
 * explicitly disabled LLM must stay disabled even when the environment
 * advertises a remote LLM endpoint.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { getMnemopiSessionState, loadMnemopi, loadMnemopiCore } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { TempDir } from "@oh-my-pi/pi-utils";

// Mnemopi is lazy-loaded at runtime; preload it so the backend can construct its instances.
await Promise.all([loadMnemopi(), loadMnemopiCore()]);

const SESSION_ID = "mnemopi-provider-credentials-test";

let tempDbDir: TempDir | undefined;
let startedState: { dispose: (options?: { consolidate?: boolean }) => Promise<void> } | undefined;

afterEach(async () => {
	await startedState?.dispose();
	startedState = undefined;
	resetMemoryForTests();
	await tempDbDir?.remove().catch(() => {});
	tempDbDir = undefined;
});

function makeDbPath(): string {
	tempDbDir = TempDir.createSync(`@mnemopi-provider-credentials-${Date.now()}-`);
	return tempDbDir.join("mnemopi.db");
}

function makeSession(settings: Settings): { session: never; modelRegistry: never } {
	const modelRegistry = {
		getApiKeyForProvider: async () => undefined,
		resolver: () => async () => undefined,
	};
	const session = {
		sessionId: SESSION_ID,
		settings,
		modelRegistry,
		sessionManager: { getEntries: () => [], getCwd: () => "/tmp" },
		emitNotice: () => {},
		getHindsightSessionState: () => undefined,
		subscribe: () => () => {},
	} as never;
	return { session, modelRegistry: modelRegistry as never };
}

async function startBackend(settings: Settings): Promise<NonNullable<ReturnType<typeof getMnemopiSessionState>>> {
	const { session, modelRegistry } = makeSession(settings);
	await mnemopiBackend.start({
		session,
		settings,
		modelRegistry,
		agentDir: tempDbDir?.path() ?? "/tmp",
		taskDepth: 0,
	});
	const state = getMnemopiSessionState(session);
	if (!state) throw new Error("Mnemopi backend did not start");
	startedState = state;
	return state;
}

describe("Mnemopi provider credentials", () => {
	it("sends the resolved embedding key when the setting names an environment variable (issue #16334)", async () => {
		const previousKey = Bun.env.OMP_MNEMOPI_TEST_EMBED_KEY;
		Bun.env.OMP_MNEMOPI_TEST_EMBED_KEY = "sk-embedding-test";
		const authorizations: (string | null)[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const authorization = request.headers.get("authorization");
				authorizations.push(authorization);
				if (authorization !== "Bearer sk-embedding-test") return new Response("unauthorized", { status: 401 });
				return Response.json({ data: [{ embedding: [0.25, 0.75] }] });
			},
		});

		try {
			const settings = Settings.isolated({
				"memory.backend": "mnemopi",
				"mnemopi.noEmbeddings": false,
				"mnemopi.llmMode": "none",
				"mnemopi.scoping": "global",
				"mnemopi.bank": "default",
				"mnemopi.dbPath": makeDbPath(),
				"mnemopi.embeddingModel": "bge-m3",
				"mnemopi.embeddingApiUrl": `http://127.0.0.1:${server.port}/v1`,
				"mnemopi.embeddingApiKey": "OMP_MNEMOPI_TEST_EMBED_KEY",
			});
			const state = await startBackend(settings);

			await state.getScopedRetainTarget().memory.recall("embedding authentication");

			// The endpoint sees the secret, not the variable name that named it.
			expect(authorizations).toEqual(["Bearer sk-embedding-test"]);
		} finally {
			server.stop(true);
			if (previousKey === undefined) delete Bun.env.OMP_MNEMOPI_TEST_EMBED_KEY;
			else Bun.env.OMP_MNEMOPI_TEST_EMBED_KEY = previousKey;
		}
	});

	it("keeps the LLM disabled for llmMode none, so an ambient MNEMOPI_LLM_BASE_URL is never called", async () => {
		const previousBaseUrl = Bun.env.MNEMOPI_LLM_BASE_URL;
		const previousEnabled = Bun.env.MNEMOPI_LLM_ENABLED;
		delete Bun.env.MNEMOPI_LLM_ENABLED;
		const requestedUrls: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				requestedUrls.push(request.url);
				return Response.json({ choices: [{ message: { content: "leaked" } }] });
			},
		});
		Bun.env.MNEMOPI_LLM_BASE_URL = `http://127.0.0.1:${server.port}/v1`;

		try {
			const settings = Settings.isolated({
				"memory.backend": "mnemopi",
				"mnemopi.noEmbeddings": true,
				"mnemopi.llmMode": "none",
				"mnemopi.scoping": "global",
				"mnemopi.bank": "default",
				"mnemopi.dbPath": makeDbPath(),
			});
			const state = await startBackend(settings);
			const memory = state.getScopedRetainTarget().memory;

			memory.remember("the deploy key rotates every friday", { extract: true });
			await memory.flushExtractions();

			// An explicitly disabled LLM must not reach an ambient endpoint with
			// the stored memory content.
			expect(requestedUrls).toEqual([]);
		} finally {
			server.stop(true);
			if (previousBaseUrl === undefined) delete Bun.env.MNEMOPI_LLM_BASE_URL;
			else Bun.env.MNEMOPI_LLM_BASE_URL = previousBaseUrl;
			if (previousEnabled === undefined) delete Bun.env.MNEMOPI_LLM_ENABLED;
			else Bun.env.MNEMOPI_LLM_ENABLED = previousEnabled;
		}
	});
});
