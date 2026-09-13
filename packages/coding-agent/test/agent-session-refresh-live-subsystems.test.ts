/**
 * `refresh('settings')` reloads the `Settings` instance, but several live
 * subsystems read their value from somewhere other than `settings.get(...)` at
 * use time. Each is frozen at construction, so a reload alone leaves the
 * running session on its launch-time behavior while the refresh reports
 * success — the same class of staleness the queue modes and generation
 * settings already fixed (see agent-session-refresh-live-settings.test.ts).
 *
 *   - `memory.backend` selects which backend is STARTED and which tools are
 *     installed. The interactive settings controller calls
 *     `applyMemoryBackend()` because the transition disposes the old backend
 *     and replaces its tools; the prompt rebuild alone leaves the model seeing
 *     the new backend's instructions over the old backend's tools.
 *   - `advisor.enabled` lives in `SessionAdvisors.#advisorEnabled` and moves
 *     only through `setAdvisorEnabled`. A true->false refresh otherwise leaves
 *     the advisor running and consuming requests.
 *   - `externalThinking` gates the `think` scratchpad tool, reconciled only
 *     after a model change.
 *   - `tools.format` feeds the live `Agent`'s dialect, which request assembly
 *     reads on every call.
 *   - `providers.openaiWebsockets` / `tools.abortOnFabricatedResult` are copied
 *     into `Agent` fields at construction and forwarded into every later loop.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Api, type Model, type ModelSpec, toolWireSchema } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionTools } from "@oh-my-pi/pi-coding-agent/session/session-tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { resolveProviderCandidates } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { setExcludedSearchProviders, setSearchProviderOrder } from "@oh-my-pi/pi-coding-agent/web/search";

/**
 * `supportsTools: false` so `tools.format: auto` resolves to an OWNED dialect
 * rather than native — the dialect assertions need `auto` and an explicit
 * dialect to differ, which they only do for a model without native tools.
 *
 * `api` is a caller-chosen transport rather than a fixed per-file value: most
 * blocks want an isolated synthetic api, but the `think` block needs a
 * transport `supportsExternalThinking` actually admits (`openai-responses`),
 * or the tool can never be built and its assertion passes vacuously.
 */
function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "refresh-live-subsystems-model",
		name: "Refresh Live Subsystems Model",
		api,
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		supportsTools: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

interface Harness {
	session: AgentSession;
	cwd: string;
	settingsPath: string;
	dispose: () => Promise<void>;
}

async function makeHarness(initialConfig: string, apiOverride?: string): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-refresh-live-subsystems-");
	const cwd = tempDir.path();
	await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
	const settingsPath = path.join(cwd, "config.yml");
	// Staged BEFORE construction so the session starts from these values and the
	// test observes a real transition rather than a first-time application.
	await fs.writeFile(settingsPath, initialConfig);
	const api = apiOverride ?? `refresh-live-subsystems-${Bun.nanoseconds().toString(36)}`;
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("managed-primary", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		sessionManager: SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry,
		settings: await Settings.loadIsolated({ cwd, agentDir: cwd }),
		model: buildLocalModel(api),
		disableExtensionDiscovery: true,
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

describe("AgentSession refresh('settings'): live memory backend", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("transitions the live memory backend when the setting moves", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\nmemory:\n  backend: none\n");
		try {
			const applySpy = vi.spyOn(h.session, "applyMemoryBackend");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nmemory:\n  backend: local\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: `memory.backend` only rebuilt the prompt, so the model saw
			// the new backend's instructions while the OLD backend's state and
			// tools stayed installed until restart.
			expect(applySpy).toHaveBeenCalledTimes(1);
		} finally {
			await h.dispose();
		}
	});

	it("does not transition the memory backend when the setting does not move", async () => {
		// The transition disposes backend state and replaces tools, so a blind
		// re-apply on every refresh would tear down a healthy live backend.
		const h = await makeHarness("compaction:\n  enabled: false\nmemory:\n  backend: none\n");
		try {
			const applySpy = vi.spyOn(h.session, "applyMemoryBackend");

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nmemory:\n  backend: none\nincludeModelInPrompt: false\n",
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(applySpy).not.toHaveBeenCalled();
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): live advisor", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("stops a running advisor when the setting is turned off on disk", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\nadvisor:\n  enabled: true\n");
		try {
			expect(h.session.isAdvisorEnabled()).toBe(true);

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nadvisor:\n  enabled: false\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: `SessionAdvisors` kept its construction-time
			// `#advisorEnabled`, so the advisor stayed running and consuming
			// requests while the refresh reported settings updated.
			expect(h.session.isAdvisorEnabled()).toBe(false);
		} finally {
			await h.dispose();
		}
	});

	it("starts the advisor when the setting is turned on on disk", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\nadvisor:\n  enabled: false\n");
		try {
			expect(h.session.isAdvisorEnabled()).toBe(false);

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nadvisor:\n  enabled: true\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.isAdvisorEnabled()).toBe(true);
		} finally {
			await h.dispose();
		}
	});

	it("leaves a session-toggled advisor alone when the reload does not move it", async () => {
		// `/advisor on` sets the value for the session; an unrelated settings
		// edit must not stop it.
		const h = await makeHarness("compaction:\n  enabled: false\nadvisor:\n  enabled: false\n");
		try {
			h.session.setAdvisorEnabled(true);
			expect(h.session.isAdvisorEnabled()).toBe(true);

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nadvisor:\n  enabled: false\nincludeModelInPrompt: false\n",
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.isAdvisorEnabled()).toBe(true);
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): external-thinking tool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reconciles the think tool when externalThinking is turned off on disk", async () => {
		// `openai-responses` so `supportsExternalThinking` admits the model and
		// the tool is genuinely active at startup; on a transport it rejects the
		// tool never exists and the assertion below would hold either way.
		const h = await makeHarness("compaction:\n  enabled: false\nexternalThinking: true\n", "openai-responses");
		try {
			expect(h.session.getEnabledToolNames()).toContain("think");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nexternalThinking: false\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: `reconcileThinkTool` ran only after a model change, so
			// disabling the setting left `think` active and callable.
			expect(h.session.getEnabledToolNames()).not.toContain("think");
		} finally {
			await h.dispose();
		}
	});

	it("installs the think tool when externalThinking is turned on on disk", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\nexternalThinking: false\n", "openai-responses");
		try {
			expect(h.session.getEnabledToolNames()).not.toContain("think");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nexternalThinking: true\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: enabling the setting left `think` absent until the next
			// model switch or restart.
			expect(h.session.getEnabledToolNames()).toContain("think");
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): live tool dialect", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("applies a reloaded tools.format to the live agent dialect", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\ntools:\n  format: auto\n");
		try {
			// `auto` on a model without native tools resolves to an owned dialect.
			expect(h.session.agent.dialect).toBe("glm");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\ntools:\n  format: native\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the refresh rebuilt the prompt for the new value while the
			// agent kept forwarding its construction-time dialect into every
			// request, so the rebuilt prompt omitted the full function catalog
			// while the loop still expected encoded tool calls.
			expect(h.session.agent.dialect).toBeUndefined();
		} finally {
			await h.dispose();
		}
	});

	it("applies a reloaded explicit dialect to the live agent", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\ntools:\n  format: native\n");
		try {
			expect(h.session.agent.dialect).toBeUndefined();

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\ntools:\n  format: qwen3\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.agent.dialect).toBe("qwen3");
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): remaining provider-loop settings", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("applies reloaded websocket transport and fabricated-result handling", async () => {
		const h = await makeHarness(
			"compaction:\n  enabled: false\nproviders:\n  openaiWebsockets: off\ntools:\n  abortOnFabricatedResult: true\n",
		);
		try {
			expect(h.session.agent.preferWebsockets).toBe(false);
			expect(h.session.agent.abortOnFabricatedToolResult).toBe(true);

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nproviders:\n  openaiWebsockets: on\ntools:\n  abortOnFabricatedResult: false\n",
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: sdk.ts copied both at construction and `Agent` forwarded
			// its private snapshots into every later loop, so the refresh
			// reported success while transport selection and fabricated-result
			// handling stayed unchanged.
			expect(h.session.agent.preferWebsockets).toBe(true);
			expect(h.session.agent.abortOnFabricatedToolResult).toBe(false);
		} finally {
			await h.dispose();
		}
	});

	it("maps the auto websocket setting to the provider default", async () => {
		// `auto` means "let the provider/model decide", which reaches the agent
		// as `undefined` — not as a boolean.
		const h = await makeHarness("compaction:\n  enabled: false\nproviders:\n  openaiWebsockets: off\n");
		try {
			expect(h.session.agent.preferWebsockets).toBe(false);

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nproviders:\n  openaiWebsockets: auto\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.agent.preferWebsockets).toBeUndefined();
		} finally {
			await h.dispose();
		}
	});

	it("leaves a runtime-overridden provider-loop field alone when the reload does not move it", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\nproviders:\n  openaiWebsockets: off\n");
		try {
			h.session.agent.preferWebsockets = true;

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nproviders:\n  openaiWebsockets: off\nincludeModelInPrompt: false\n",
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.agent.preferWebsockets).toBe(true);
		} finally {
			await h.dispose();
		}
	});
});

// `async.enabled` had the same construction-time-copy shape, one layer deeper
// than a plain boolean: `BashTool` snapshotted it into a readonly field, chose
// `bashSchemaWithAsync` or `bashSchemaBase` from that snapshot ONCE, and
// checked the same stale field at execution time. So a reload left enabling
// unable to accept background execution and — the serious direction — left
// disabling still able to launch background jobs, even though task execution
// already read the setting live.
//
// The reconcile is a live getter rather than a re-registration because the
// agent loop re-derives each tool's wire schema from `tool.parameters` on every
// provider request (`normalizeTools`), so the advertised schema follows the
// setting with no registry churn.
describe("AgentSession refresh('settings'): live Bash async support", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * The `bash` parameter names as the PROVIDER sees them. Asserted through
	 * `toolWireSchema` (the exact conversion `normalizeTools` performs per
	 * request) rather than the ArkType object, whose `props` is a positional
	 * node array that would make a name assertion vacuous.
	 */
	function bashWireParams(session: AgentSession): string[] {
		const tool = session.agent.state.tools.find(entry => entry.name === "bash");
		if (!tool) throw new Error("Expected a live bash tool on the agent");
		const wire = toolWireSchema(tool) as { properties?: Record<string, unknown> };
		return Object.keys(wire.properties ?? {});
	}

	it("advertises and accepts async once async.enabled is turned on on disk", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\nasync:\n  enabled: false\n");
		try {
			// Premise: the launch-time schema omits `async` entirely.
			expect(bashWireParams(h.session)).not.toContain("async");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nasync:\n  enabled: true\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the schema stayed frozen at `bashSchemaBase`, so Bash could
			// not accept background execution however the setting moved.
			expect(bashWireParams(h.session)).toContain("async");
		} finally {
			await h.dispose();
		}
	});

	it("stops advertising async once async.enabled is turned off on disk", async () => {
		// The serious direction: a stale enabled flag leaves existing Bash calls
		// able to launch background jobs after the operator turned async off.
		const h = await makeHarness("compaction:\n  enabled: false\nasync:\n  enabled: true\n");
		try {
			expect(bashWireParams(h.session)).toContain("async");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nasync:\n  enabled: false\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(bashWireParams(h.session)).not.toContain("async");
			// The execution-time guard must move with the schema, or a model still
			// working from the previous turn's tool spec launches a background job
			// the setting now forbids.
			const bash = h.session.agent.state.tools.find(entry => entry.name === "bash");
			if (!bash) throw new Error("Expected a live bash tool on the agent");
			await expect(bash.execute("call-async-disabled", { command: "true", async: true })).rejects.toThrow(
				/[Aa]sync bash execution is disabled/,
			);
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): live Bash auto-background policy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function bashDescription(session: AgentSession): string {
		const tool = session.agent.state.tools.find(entry => entry.name === "bash");
		if (!tool) throw new Error("Expected a live bash tool on the agent");
		return tool.description ?? "";
	}

	// `bash.autoBackground.enabled` and `.thresholdMs` were the same
	// constructor-snapshot shape as `async.enabled`: cached in readonly fields
	// and consulted at execution time, so an edit plus a refresh left Bash
	// backgrounding under the launch-time policy.
	//
	// The ENABLED half is observable through the description, which gates a
	// paragraph on it. The THRESHOLD is not: the template says "the configured
	// threshold" without interpolating the number, so `autoBackgroundThresholdMs`
	// reaches only the execution path. It is a getter for the same reason, but
	// this file can only guard the flag.
	it("stops advertising auto-backgrounding once the policy is turned off on disk", async () => {
		const h = await makeHarness(
			"compaction:\n  enabled: false\nbash:\n  autoBackground:\n    enabled: true\n    thresholdMs: 30000\n",
		);
		try {
			expect(bashDescription(h.session)).toContain("auto-background");

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nbash:\n  autoBackground:\n    enabled: false\n",
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix the readonly field kept the launch-time `true`.
			expect(bashDescription(h.session)).not.toContain("auto-background");
		} finally {
			await h.dispose();
		}
	});

	it("starts advertising auto-backgrounding once the policy is turned on on disk", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\nbash:\n  autoBackground:\n    enabled: false\n");
		try {
			expect(bashDescription(h.session)).not.toContain("auto-background");

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nbash:\n  autoBackground:\n    enabled: true\n    thresholdMs: 30000\n",
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(bashDescription(h.session)).toContain("auto-background");
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): browser/computer prelude reconciliation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not report completion while the prelude reconciliation is still in flight", async () => {
		// `browser.enabled`/`computer.enabled` DO reach a listener, but it starts
		// an async reconcile and returns immediately, so `settings.reload()`
		// resolves with the prompt still unreconciled. The refresh must JOIN that
		// work: gate `refreshBaseSystemPrompt` open and assert the refresh has not
		// resolved, then release it and assert it does.
		const h = await makeHarness("compaction:\n  enabled: false\nbrowser:\n  enabled: false\n");
		try {
			const gate = Promise.withResolvers<void>();
			let promptRebuildStarted = false;
			const realRefresh = h.session.refreshBaseSystemPrompt.bind(h.session);
			vi.spyOn(h.session, "refreshBaseSystemPrompt").mockImplementation(async () => {
				promptRebuildStarted = true;
				await gate.promise;
				await realRefresh();
			});

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nbrowser:\n  enabled: true\n");
			let settled = false;
			const refreshing = h.session.refresh("settings").then(result => {
				settled = true;
				return result;
			});

			// Let the listener start and park in the gated prompt rebuild.
			for (let i = 0; i < 200 && !promptRebuildStarted; i++) await Bun.sleep(1);
			expect(promptRebuildStarted).toBe(true);
			await Bun.sleep(20);
			expect(settled).toBe(false);

			gate.resolve();
			const result = await refreshing;
			expect(settled).toBe(true);
			expect(result.settingsChanged).toBe(true);
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): Kimi wire format", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("applies a reloaded providers.kimiApiFormat to the live agent", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\nproviders:\n  kimiApiFormat: openai\n");
		try {
			expect(h.session.agent.kimiApiFormat).toBe("openai");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nproviders:\n  kimiApiFormat: anthropic\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: sdk.ts resolved the setting once into `Agent.#kimiApiFormat`
			// with no setter, so every later Kimi request kept the launch-time
			// protocol — potentially the wire format the provider no longer speaks.
			expect(h.session.agent.kimiApiFormat).toBe("anthropic");
		} finally {
			await h.dispose();
		}
	});

	it("maps the auto Kimi format to the model's live protocol metadata", async () => {
		// `auto` means "use whatever the model reports" and must reach the agent
		// as `undefined`, not as a literal format.
		const h = await makeHarness("compaction:\n  enabled: false\nproviders:\n  kimiApiFormat: anthropic\n");
		try {
			expect(h.session.agent.kimiApiFormat).toBe("anthropic");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nproviders:\n  kimiApiFormat: auto\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.agent.kimiApiFormat).toBeUndefined();
		} finally {
			await h.dispose();
		}
	});

	it("leaves a runtime-set Kimi format alone when the reload does not move it", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\nproviders:\n  kimiApiFormat: openai\n");
		try {
			h.session.agent.kimiApiFormat = "anthropic";

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nproviders:\n  kimiApiFormat: openai\nincludeModelInPrompt: false\n",
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.agent.kimiApiFormat).toBe("anthropic");
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): side-channel websocket preference", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("moves the session-level preference that side requests read", async () => {
		// `AgentSession.#preferWebsockets` — surfaced by the `preferWebsockets`
		// getter — is what `/btw`, compaction, and the advisor/maintenance hosts
		// use, NOT `agent.preferWebsockets`. Pre-fix the refresh moved only the
		// agent, so primary turns switched transport while every side channel
		// stayed on the construction-time value.
		const h = await makeHarness("compaction:\n  enabled: false\nproviders:\n  openaiWebsockets: off\n");
		try {
			expect(h.session.preferWebsockets).toBe(false);

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nproviders:\n  openaiWebsockets: on\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.preferWebsockets).toBe(true);
			// The primary agent moved too — the two must not diverge.
			expect(h.session.agent.preferWebsockets).toBe(true);
		} finally {
			await h.dispose();
		}
	});

	it("maps the auto setting to the provider default for side requests too", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\nproviders:\n  openaiWebsockets: on\n");
		try {
			expect(h.session.preferWebsockets).toBe(true);

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nproviders:\n  openaiWebsockets: auto\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.preferWebsockets).toBeUndefined();
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): provider ordering globals", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		// The order/exclusion state is process-global module state, so a test that
		// moved it must restore the defaults for whatever runs next.
		setSearchProviderOrder([]);
		setExcludedSearchProviders([]);
	});

	it("reapplies a reloaded web-search order to the module-level provider state", async () => {
		// `getSearchProvider`/the auto chain read module state installed by
		// `applyProviderGlobalsFromSettings`, never `settings.get(...)` at call
		// time. Pre-fix the reload updated only the `Settings` view, so searches
		// after `/refresh settings` kept the launch-time order.
		const h = await makeHarness(
			"compaction:\n  enabled: false\nproviders:\n  webSearchOrder:\n    - brave\n    - exa\n",
		);
		try {
			expect(resolveProviderCandidates().map(candidate => candidate.id)[0]).toBe("brave");

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nproviders:\n  webSearchOrder:\n    - exa\n    - brave\n",
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(resolveProviderCandidates().map(candidate => candidate.id)[0]).toBe("exa");
		} finally {
			await h.dispose();
		}
	});

	it("reapplies a reloaded web-search exclusion", async () => {
		const h = await makeHarness(
			"compaction:\n  enabled: false\nproviders:\n  webSearchOrder:\n    - exa\n    - brave\n",
		);
		try {
			expect(resolveProviderCandidates().map(candidate => candidate.id)).toContain("exa");

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nproviders:\n  webSearchOrder:\n    - exa\n    - brave\n  webSearchExclude:\n    - exa\n",
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix a newly excluded provider kept being used, including as a
			// silent auto-chain fallback.
			expect(resolveProviderCandidates().map(candidate => candidate.id)).not.toContain("exa");
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): live secret obfuscator", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * Writes a project `.omp/secrets.yml` carrying one plain literal secret.
	 * The file is a top-level YAML ARRAY of `{ type, content }` entries
	 * (`loadSecretsFile`), not a mapping.
	 */
	async function writeSecrets(cwd: string, value: string): Promise<void> {
		await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".omp", "secrets.yml"),
			`- type: plain\n  content: "${value}"\n  mode: replace\n  replacement: "[REDACTED]"\n`,
		);
	}

	it("builds the obfuscator when secrets are enabled on disk", async () => {
		const marker = `SEKRIT_${Bun.nanoseconds().toString(36)}`;
		const h = await makeHarness("compaction:\n  enabled: false\nsecrets:\n  enabled: false\n");
		try {
			// Off at construction, so nothing redacts.
			expect(h.session.obfuscator).toBeUndefined();
			await writeSecrets(h.cwd, marker);

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nsecrets:\n  enabled: true\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the obfuscator was built ONCE in sdk.ts and the setting hook
			// only toggled generic credential-pattern redaction, so the configured
			// `secrets.yml` values kept being sent to providers while the refresh
			// reported the privacy setting updated.
			expect(h.session.obfuscator).toBeDefined();
			expect(h.session.obfuscator?.hasSecrets()).toBe(true);
			expect(h.session.obfuscator?.obfuscate(`leading ${marker} trailing`)).not.toContain(marker);
		} finally {
			await h.dispose();
		}
	});

	it("drops the obfuscator when secrets are disabled on disk", async () => {
		const marker = `SEKRIT_${Bun.nanoseconds().toString(36)}`;
		const tempSeed = TempDir.createSync("@pi-refresh-secrets-seed-");
		try {
			const h = await makeHarness("compaction:\n  enabled: false\nsecrets:\n  enabled: true\n");
			try {
				await writeSecrets(h.cwd, marker);
				// Pick the seeded secret up first, so the disable below is a real
				// transition away from an obfuscator that WAS redacting.
				await h.session.refresh("settings");
				expect(h.session.obfuscator?.hasSecrets()).toBe(true);

				await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nsecrets:\n  enabled: false\n");
				const result = await h.session.refresh("settings");

				expect(result.settingsChanged).toBe(true);
				expect(h.session.obfuscator).toBeUndefined();
			} finally {
				await h.dispose();
			}
		} finally {
			await tempSeed.remove();
		}
	});

	it("picks up an edited secrets.yml while the setting stays enabled", async () => {
		// `secrets.yml` is a disk surface the refresh re-reads, so an edited
		// secret set must take effect even though the gating flag never moved.
		const first = `FIRST_${Bun.nanoseconds().toString(36)}`;
		const second = `SECOND_${Bun.nanoseconds().toString(36)}`;
		const h = await makeHarness("compaction:\n  enabled: false\nsecrets:\n  enabled: true\n");
		try {
			await writeSecrets(h.cwd, first);
			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nsecrets:\n  enabled: true\nincludeModelInPrompt: false\n",
			);
			await h.session.refresh("settings");
			expect(h.session.obfuscator?.obfuscate(`x ${first} y`)).not.toContain(first);

			await writeSecrets(h.cwd, second);
			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nsecrets:\n  enabled: true\nincludeModelInPrompt: true\n",
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.obfuscator?.obfuscate(`x ${second} y`)).not.toContain(second);
		} finally {
			await h.dispose();
		}
	});
	it("re-reads secrets.yml when no merged setting changed", async () => {
		// `secrets.yml` is a disk surface the refresh re-reads but `Settings`
		// never merges, so editing ONLY that file leaves `settings.reload()`
		// reporting no change. Gating the rebuild on that verdict kept a newly
		// added secret going to providers unobfuscated until an unrelated setting
		// moved or the session restarted.
		const first = `FIRST_${Bun.nanoseconds().toString(36)}`;
		const second = `SECOND_${Bun.nanoseconds().toString(36)}`;
		const h = await makeHarness("compaction:\n  enabled: false\nsecrets:\n  enabled: true\n");
		try {
			await writeSecrets(h.cwd, first);
			await h.session.refresh("settings");
			expect(h.session.obfuscator?.obfuscate(`x ${first} y`)).not.toContain(first);

			// Add a second secret and touch NOTHING else — config.yml is left byte
			// identical, so the merged view cannot move.
			await fs.writeFile(
				path.join(h.cwd, ".omp", "secrets.yml"),
				`- type: plain\n  content: "${first}"\n  mode: replace\n  replacement: "[REDACTED]"\n` +
					`- type: plain\n  content: "${second}"\n  mode: replace\n  replacement: "[REDACTED]"\n`,
			);
			const result = await h.session.refresh("settings");

			// Guards the premise: this really is the no-merged-change path.
			expect(result.settingsChanged).toBe(false);
			// The newly added secret must still be obfuscated.
			expect(h.session.obfuscator?.obfuscate(`x ${second} y`)).not.toContain(second);
			// ...and the pre-existing one must survive the rebuild.
			expect(h.session.obfuscator?.obfuscate(`x ${first} y`)).not.toContain(first);
		} finally {
			await h.dispose();
		}
	});

	// `/move` (and a cross-project resume) repoints the session's directory
	// through `SessionManager.moveTo`, and the rest of refresh already follows
	// it via `sessionManager.getCwd()` — the roster reload, the prompt's repo
	// context, the settings reload. The obfuscator rebuild must too: rebuilding
	// from the construction-time cwd reads the ORIGINAL project's secrets.yml,
	// so the destination project's secrets ship to providers unobfuscated while
	// the source project's substitutions keep being applied.
	it("rebuilds from the session's CURRENT cwd after a move", async () => {
		const sourceSecret = `SOURCE_SEKRIT_${Bun.nanoseconds().toString(36)}`;
		const destSecret = `DEST_SEKRIT_${Bun.nanoseconds().toString(36)}`;
		using tempDir = TempDir.createSync("@pi-refresh-secrets-move-");
		const source = tempDir.join("source-project");
		const destination = tempDir.join("destination-project");
		await fs.mkdir(path.join(source, ".git"), { recursive: true });
		await fs.mkdir(path.join(destination, ".git"), { recursive: true });
		await writeSecrets(source, sourceSecret);
		await writeSecrets(destination, destSecret);

		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const sessionManager = SessionManager.inMemory(source);
		// `secrets.enabled` comes from a CONFIG OVERLAY, not a project layer:
		// project settings resolve through a process-lifetime capability cache
		// keyed by directory, so a project-layer value would not be re-read for
		// the destination and the test would prove nothing about the rebuild.
		const { session } = await createAgentSession({
			cwd: source,
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: await Settings.loadIsolated({
				cwd: source,
				agentDir: tempDir.path(),
				overrides: { "compaction.enabled": false, "secrets.enabled": true },
			}),
			model: buildLocalModel(`refresh-secrets-move-${Bun.nanoseconds().toString(36)}`),
			disableExtensionDiscovery: true,
			contextFiles: [],
			skills: [],
			rules: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			// The source project's secret is live, and the destination's is not
			// yet — which also guards the premise that neither marker is matched
			// by the always-appended built-in credential patterns.
			expect(session.obfuscator?.obfuscate(`x ${sourceSecret} y`)).not.toContain(sourceSecret);
			expect(session.obfuscator?.obfuscate(`x ${destSecret} y`)).toContain(destSecret);

			// A real move, the same primitive `/move` and a cross-project resume
			// drive.
			await sessionManager.moveTo(destination);
			expect(sessionManager.getCwd()).toBe(path.resolve(destination));

			await session.refresh("settings");

			// The destination project's secret must now be obfuscated...
			expect(session.obfuscator?.obfuscate(`x ${destSecret} y`)).not.toContain(destSecret);
			// ...and the source project's substitution must no longer apply: the
			// session left that project, so its secrets.yml is not its policy.
			expect(session.obfuscator?.obfuscate(`x ${sourceSecret} y`)).toContain(sourceSecret);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});

describe("AgentSession refresh('settings'): awaited reconciliation tails", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * Resolves after `turns` microtask hops — a deterministic "the event loop has
	 * had plenty of opportunity to settle" marker, with no wall-clock wait.
	 *
	 * Used to prove a refresh is genuinely BLOCKED rather than merely slow: a
	 * refresh awaiting a promise nothing has resolved can never win a race
	 * against this marker however many turns it runs for, while a
	 * fire-and-forget refresh resolves within a handful of hops.
	 */
	async function microtaskMarker(turns = 500): Promise<"marker"> {
		for (let i = 0; i < turns; i++) await Promise.resolve();
		return "marker";
	}

	it("does not report completion while the Code Mode reconciliation is in flight", async () => {
		// The Code Mode signal reaches a listener, but it launched
		// `reconcileCodeMode()` fire-and-forget, so `/refresh settings` could
		// return — and the current tool loop make its next provider request —
		// before the tool partition and prompt were repartitioned.
		//
		// Gated on the SessionTools prototype: the session's own instance is
		// private, and this is the exact method the `onCodeModeChanged` listener
		// invokes. Parking it inside the reconcile is what makes the awaited-vs-
		// fire-and-forget difference observable at all.
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const realReconcile = SessionTools.prototype.reconcileCodeMode;
		const reconcileSpy = vi
			.spyOn(SessionTools.prototype, "reconcileCodeMode")
			.mockImplementation(async function (this: SessionTools) {
				started.resolve();
				await gate.promise;
				await realReconcile.call(this);
			});
		// Construction itself runs a Code Mode pass, so open the gate for it and
		// re-arm only once the session is live — otherwise the harness never
		// finishes building.
		gate.resolve();
		const h = await makeHarness("compaction:\n  enabled: false\nedit:\n  mode: edit\n");
		try {
			const turnGate = Promise.withResolvers<void>();
			const turnStarted = Promise.withResolvers<void>();
			reconcileSpy.mockImplementation(async function (this: SessionTools) {
				turnStarted.resolve();
				await turnGate.promise;
				await realReconcile.call(this);
			});

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nedit:\n  mode: apply_patch\n");
			const refreshing = h.session.refresh("settings").then(() => "refresh" as const);

			// The listener fires synchronously from the reload, so this settles
			// without any wall-clock wait.
			await turnStarted.promise;
			// Parked on `turnGate`, so a refresh that JOINS the reconciliation can
			// never beat the marker. Pre-fix it did not join and resolved first.
			expect(await Promise.race([refreshing, microtaskMarker()])).toBe("marker");

			turnGate.resolve();
			expect(await refreshing).toBe("refresh");
		} finally {
			await h.dispose();
		}
	});

	it("does not report completion while the extended-context reconciliation is in flight", async () => {
		// Same shape: the `extendedContext` subscriber started
		// `#reapplyExtendedContextPolicy()` with `void` and exposed no joinable
		// task, so the next turn could compute compaction limits against the
		// pre-refresh context window. `reapplyModelPolicies` is that
		// reconciliation's first await, so gating it parks the tail.
		const h = await makeHarness("compaction:\n  enabled: false\nextendedContext: false\n");
		try {
			const gate = Promise.withResolvers<void>();
			const started = Promise.withResolvers<void>();
			const registry = h.session.modelRegistry;
			const realReapply = registry.reapplyModelPolicies.bind(registry);
			vi.spyOn(registry, "reapplyModelPolicies").mockImplementation(async () => {
				started.resolve();
				await gate.promise;
				return realReapply();
			});

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nextendedContext: true\n");
			const refreshing = h.session.refresh("settings").then(() => "refresh" as const);

			await started.promise;
			expect(await Promise.race([refreshing, microtaskMarker()])).toBe("marker");

			gate.resolve();
			expect(await refreshing).toBe("refresh");
		} finally {
			await h.dispose();
		}
	});
});
