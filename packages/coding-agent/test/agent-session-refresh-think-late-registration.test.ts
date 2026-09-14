/**
 * `externalThinking` gates the hidden `think` scratchpad, which starts as a
 * BUILT-IN registry entry when the setting is on. When a `/refresh settings`
 * flips the setting true->false, the reconcile must not just deactivate `think`
 * — it must DROP the session's own built-in entry, exactly as the boolean-gated
 * built-ins do.
 *
 * The failure this defends: a Pi extension that discovers tools asynchronously
 * (from a `session_start` handler) may register a `think` REPLACEMENT after the
 * refresh. sdk.ts's late-registration path (`existingTool && !alreadyEnabled`)
 * treats a retained-but-inactive built-in entry as a user deselection and
 * declines to install the replacement. So a session that turned `externalThinking`
 * off left the extension's `think` INACTIVE — while a session started with
 * `externalThinking` off (no built-in collision) activates the same extension
 * tool. Removing the disabled entry makes late registration behave like a fresh
 * session.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionContext, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * `openai-responses` so `supportsExternalThinking` actually admits the model:
 * otherwise `reconcileThinkTool` never builds `think` at startup and every
 * assertion below passes vacuously.
 */
function buildThinkingModel(): Model<Api> {
	return buildModel({
		id: "refresh-think-late-model",
		name: "Refresh Think Late Model",
		api: "openai-responses",
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

const REPLACEMENT_MARKER = "think-extension-replacement";

/**
 * An extension that does NOT register `think` at load time. It parks its `pi`
 * handle so the test can call `registerLateThink()` AFTER the refresh — the
 * async-discovery timing the sdk late-registration path exists to serve.
 */
function makeDeferredThinkExtension(): {
	factory: ExtensionFactory;
	registerLateThink: () => void;
} {
	let api: ExtensionAPI | undefined;
	const factory: ExtensionFactory = pi => {
		api = pi;
	};
	const registerLateThink = (): void => {
		if (!api) throw new Error("extension factory never ran");
		api.registerTool({
			name: "think",
			label: "Think (extension)",
			description: REPLACEMENT_MARKER,
			parameters: api.arktype({}),
			async execute(_id: string, _params: unknown, _signal: unknown, _onUpdate: unknown, _ctx: ExtensionContext) {
				return { content: [{ type: "text" as const, text: REPLACEMENT_MARKER }], details: {} };
			},
		});
	};
	return { factory, registerLateThink };
}

interface Harness {
	session: AgentSession;
	cwd: string;
	settingsPath: string;
	dispose: () => Promise<void>;
}

async function makeHarness(initialConfig: string, extensions: ExtensionFactory[]): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-refresh-think-late-");
	const cwd = tempDir.path();
	await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
	const settingsPath = path.join(cwd, "config.yml");
	await fs.writeFile(settingsPath, initialConfig);
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("managed-primary", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		sessionManager: SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry,
		settings: await Settings.loadIsolated({ cwd, agentDir: cwd, overrides: { "compaction.enabled": false } }),
		model: buildThinkingModel(),
		disableExtensionDiscovery: true,
		extensions,
		contextFiles: [],
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});

	return {
		session,
		cwd,
		settingsPath,
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		},
	};
}

describe("AgentSession refresh: think entry removed on gate disable frees late registration", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("activates an extension's late think replacement after externalThinking is turned off", async () => {
		const { factory, registerLateThink } = makeDeferredThinkExtension();
		const h = await makeHarness("compaction:\n  enabled: false\nexternalThinking: true\n", [factory]);
		try {
			// Startup: the built-in `think` is present and active.
			expect(h.session.getEnabledToolNames()).toContain("think");

			// Flip the gate off. Post-fix this DROPS the built-in entry; pre-fix it
			// only deactivates and leaves the entry behind.
			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nexternalThinking: false\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);
			expect(h.session.getEnabledToolNames()).not.toContain("think");

			// The extension now registers its `think` replacement, late. Draining an
			// empty mutation behind it lets the serialized sdk activation finish
			// before we assert (the barrier the skill-fanout tests use).
			registerLateThink();
			await h.session.runToolRegistryMutation(async () => {});

			// Post-fix: no leftover built-in entry, so sdk late registration installs
			// AND activates the replacement — a callable, active `think`.
			expect(h.session.getEnabledToolNames()).toContain("think");
			expect(h.session.getToolByName("think")?.description).toBe(REPLACEMENT_MARKER);
			const result = await h.session
				.getToolByName("think")
				?.execute("call-think-late", {}, undefined, undefined as never, undefined as never);
			const text = result?.content.find(block => block.type === "text");
			expect(text?.type === "text" ? text.text : "").toBe(REPLACEMENT_MARKER);
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("control: a session started with externalThinking off activates the same late replacement", async () => {
		// The behaviour the disabled-then-refreshed session must MATCH: no built-in
		// collision at startup, so the extension's late `think` activates.
		const { factory, registerLateThink } = makeDeferredThinkExtension();
		const h = await makeHarness("compaction:\n  enabled: false\nexternalThinking: false\n", [factory]);
		try {
			expect(h.session.getEnabledToolNames()).not.toContain("think");

			registerLateThink();
			await h.session.runToolRegistryMutation(async () => {});

			expect(h.session.getEnabledToolNames()).toContain("think");
			expect(h.session.getToolByName("think")?.description).toBe(REPLACEMENT_MARKER);
		} finally {
			await h.dispose();
		}
	}, 20_000);
});
