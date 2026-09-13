/**
 * `refresh('settings')` must apply the reloaded values to the LIVE session, not
 * just to the `Settings` instance. Two surfaces read their value from somewhere
 * other than `settings.get(...)` at use time, so a reload alone leaves them
 * frozen at construction while the refresh reports success:
 *
 *   - The queue modes (`steeringMode`/`followUpMode`/`interruptMode`) live in
 *     `Agent` state and move only through `setSteeringMode`/`setFollowUpMode`/
 *     `setInterruptMode`. The interactive settings selector calls those
 *     explicitly for exactly this reason.
 *   - The system prompt is a rendered artifact. `personality` and
 *     `tools.xdevDocs` feed `rebuildSystemPrompt`, and the interactive selector
 *     calls `refreshBaseSystemPrompt()` when either changes — but a
 *     settings-only refresh with no roster change and no model swap left
 *     `rosterChanged` false and skipped the sole rebuild.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./session-manager/helpers";

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "refresh-live-settings-model",
		name: "Refresh Live Settings Model",
		api,
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
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

async function makeHarness(
	initialConfig: string,
	opts?: {
		persist?: boolean;
		/** Host hook main.ts supplies; records the patterns each reconcile saw. */
		reconcileScopedModels?: () => Promise<Array<{ model: Model; thinkingLevel?: ThinkingLevel }> | undefined>;
	},
): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-refresh-live-settings-");
	const cwd = tempDir.path();
	await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
	const settingsPath = path.join(cwd, "config.yml");
	// Staged BEFORE construction so the session starts from these values and the
	// test observes a real transition rather than a first-time application.
	await fs.writeFile(settingsPath, initialConfig);
	const api = `refresh-live-settings-${Bun.nanoseconds().toString(36)}`;
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("managed-primary", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		// A persisted manager when the test needs the session header's async write
		// to be observable; `inMemory` applies roots synchronously.
		sessionManager: opts?.persist
			? SessionManager.create(cwd, path.join(cwd, "sessions"))
			: SessionManager.inMemory(cwd),
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
		reconcileScopedModels: opts?.reconcileScopedModels,
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

describe("AgentSession refresh('settings'): live queue modes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("applies reloaded queue modes to the live agent", async () => {
		const h = await makeHarness(
			"compaction:\n  enabled: false\nsteeringMode: one-at-a-time\nfollowUpMode: one-at-a-time\ninterruptMode: immediate\n",
		);
		try {
			expect(h.session.steeringMode).toBe("one-at-a-time");
			expect(h.session.followUpMode).toBe("one-at-a-time");
			expect(h.session.interruptMode).toBe("immediate");

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nsteeringMode: all\nfollowUpMode: all\ninterruptMode: wait\n",
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the reload updated only the `Settings` instance. These read
			// from `Agent` state, which moves only through the setters, so queuing
			// kept running under the construction-time modes.
			expect(h.session.steeringMode).toBe("all");
			expect(h.session.followUpMode).toBe("all");
			expect(h.session.interruptMode).toBe("wait");
		} finally {
			await h.dispose();
		}
	});

	it("leaves the live queue modes alone when the reload does not move them", async () => {
		// Guard against a blind re-apply: an unrelated settings edit must not
		// reset a mode an RPC/ACP client or the selector set this session. Those
		// setters persist to settings, so a value the session holds but the file
		// does not is exactly the shape a runtime override takes.
		const h = await makeHarness("compaction:\n  enabled: false\n");
		try {
			h.session.setSteeringMode("all");
			expect(h.session.steeringMode).toBe("all");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nincludeModelInPrompt: false\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.steeringMode).toBe("all");
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): prompt-affecting settings", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rebuilds the system prompt when reloaded personality changes", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\npersonality: default\n");
		try {
			await h.session.refreshBaseSystemPrompt();
			const before = h.session.systemPrompt.join("\n");

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\npersonality: friendly\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: no roster change and no model swap left `rosterChanged`
			// false, so the sole `refreshBaseSystemPrompt()` was skipped and the
			// prompt kept advertising the launch-time personality block.
			expect(h.session.systemPrompt.join("\n")).not.toBe(before);
		} finally {
			await h.dispose();
		}
	});

	it("keeps the system prompt byte-identical when no prompt-affecting setting moved", async () => {
		// The no-op guard that keeps provider prompt caching hitting: an
		// unrelated settings edit must not re-render the prompt.
		const h = await makeHarness("compaction:\n  enabled: false\npersonality: default\n");
		try {
			await h.session.refreshBaseSystemPrompt();
			const before = h.session.systemPrompt.join("\n");

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\npersonality: default\nautoCompact: false\n",
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.systemPrompt.join("\n")).toBe(before);
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): live request-generation settings", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("applies reloaded sampling and reasoning settings to the live agent", async () => {
		const h = await makeHarness(
			[
				"compaction:",
				"  enabled: false",
				"temperature: 0.1",
				"topP: 0.2",
				"topK: 3",
				"minP: 0.04",
				"presencePenalty: 0.5",
				"repetitionPenalty: 0.6",
				"omitThinking: false",
				"thinkingBudgets:",
				"  low: 2048",
				"",
			].join("\n"),
		);
		try {
			expect(h.session.agent.temperature).toBe(0.1);
			expect(h.session.agent.topP).toBe(0.2);
			expect(h.session.agent.topK).toBe(3);
			expect(h.session.agent.minP).toBe(0.04);
			expect(h.session.agent.presencePenalty).toBe(0.5);
			expect(h.session.agent.repetitionPenalty).toBe(0.6);
			expect(h.session.agent.hideThinkingSummary).toBe(false);
			expect(h.session.agent.thinkingBudgets?.low).toBe(2048);

			await fs.writeFile(
				h.settingsPath,
				[
					"compaction:",
					"  enabled: false",
					"temperature: 0.9",
					"topP: 0.8",
					"topK: 7",
					"minP: 0.07",
					"presencePenalty: 1.5",
					"repetitionPenalty: 1.6",
					"omitThinking: true",
					"thinkingBudgets:",
					"  low: 4096",
					"",
				].join("\n"),
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: these were copied into mutable `Agent` fields at
			// construction (sdk.ts) and request generation reads the FIELDS, not
			// the reloaded `Settings`, so every subsequent model call kept the
			// launch-time sampling and reasoning configuration.
			expect(h.session.agent.temperature).toBe(0.9);
			expect(h.session.agent.topP).toBe(0.8);
			expect(h.session.agent.topK).toBe(7);
			expect(h.session.agent.minP).toBe(0.07);
			expect(h.session.agent.presencePenalty).toBe(1.5);
			expect(h.session.agent.repetitionPenalty).toBe(1.6);
			expect(h.session.agent.hideThinkingSummary).toBe(true);
			expect(h.session.agent.thinkingBudgets?.low).toBe(4096);
		} finally {
			await h.dispose();
		}
	});

	it("clears a sampling field back to the provider default when its setting is removed", async () => {
		// The sentinel is `-1` (schema default), meaning "provider default", and
		// must map to `undefined` — not to the literal -1, which would ride onto
		// the wire as a real sampling value.
		const h = await makeHarness("compaction:\n  enabled: false\ntemperature: 0.3\n");
		try {
			expect(h.session.agent.temperature).toBe(0.3);

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.agent.temperature).toBeUndefined();
		} finally {
			await h.dispose();
		}
	});

	it("leaves a runtime-overridden sampling field alone when the reload does not move it", async () => {
		// Same guard as the queue modes: the interactive selector writes straight
		// onto the live agent, so a blind unconditional re-apply would clobber a
		// selection this session made.
		const h = await makeHarness("compaction:\n  enabled: false\n");
		try {
			h.session.agent.temperature = 0.42;

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nincludeModelInPrompt: false\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.agent.temperature).toBe(0.42);
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): live intent tracing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("applies a reloaded tools.intentTracing to the live agent", async () => {
		// The value decides whether the required intent field is injected into
		// every tool schema. Captured at construction, a refresh left request
		// assembly and the prompt guidance on the launch-time policy while the
		// reloaded settings view reported the new one.
		const h = await makeHarness("compaction:\n  enabled: false\ntools:\n  intentTracing: false\n");
		try {
			expect(h.session.agent.intentTracing).toBe(false);

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\ntools:\n  intentTracing: true\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.agent.intentTracing).toBe(true);
		} finally {
			await h.dispose();
		}
	});

	it("applies a reloaded tools.intentTracing turning it back off", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\ntools:\n  intentTracing: true\n");
		try {
			expect(h.session.agent.intentTracing).toBe(true);

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\ntools:\n  intentTracing: false\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.agent.intentTracing).toBe(false);
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): live model scope", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("re-resolves the Ctrl+P cycle scope when enabledModels moves", async () => {
		// The scope is copied OUT of settings into `ModelControls` at
		// construction, and the only later write is the one-time post-discovery
		// rebuild — so Ctrl+P and `/models` kept offering the launch-time
		// allowlist indefinitely after an edit, including a clear.
		//
		// Resolution itself is the HOST's job (an explicit `--models` pin outranks
		// the setting, and the SDK cannot see that flag), so the hook here stands
		// in for main.ts and reports what the reload actually exposed.
		const seen: string[][] = [];
		const h = await makeHarness("compaction:\n  enabled: false\n", {
			reconcileScopedModels: async () => {
				const patterns = [...h.session.settings.get("enabledModels")];
				seen.push(patterns);
				// An empty edit is a real answer: the scope was CLEARED.
				if (patterns.length === 0) return [];
				// The session's own model stands in for a resolved scope entry; the
				// harness registry has no discoverable models of its own.
				const model = h.session.model;
				return model ? [{ model }] : [];
			},
		});
		try {
			expect(h.session.scopedModels).toEqual([]);

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\nenabledModels:\n  - '*'\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			// Pre-fix nothing re-read the setting, so this never ran at all.
			expect(seen).toEqual([["*"]]);
			expect(h.session.scopedModels.length).toBe(1);

			// And the clear direction, which a naive "only widen" reconcile misses.
			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);
			expect(seen).toHaveLength(2);
			expect(h.session.scopedModels).toEqual([]);
		} finally {
			await h.dispose();
		}
	});

	it("leaves the scope alone when enabledModels did not move", async () => {
		// The no-op guard: the resolver can hit the model registry, so an
		// unrelated settings edit must not re-run it on every refresh.
		let calls = 0;
		const h = await makeHarness("compaction:\n  enabled: false\nenabledModels:\n  - '*'\n", {
			reconcileScopedModels: async () => {
				calls++;
				return [];
			},
		});
		try {
			// An unrelated edit: the scope value itself is untouched.
			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nenabledModels:\n  - '*'\ntools:\n  intentTracing: true\n",
			);
			await h.session.refresh("settings");

			expect(calls).toBe(0);
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): live workspace roots", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("has persisted the reconciled roots to the session header by the time refresh returns", async () => {
		// The listener starts persistence + prompt rebuild and returns; a settings
		// listener's return value is discarded, so without a registered join handle
		// the refresh reports completion while the work is still in flight.
		//
		// Uses a PERSISTED session manager deliberately. `setAdditionalDirectories`
		// mutates its in-memory field synchronously, so an `inMemory` session shows
		// the new roots even fire-and-forget — the header write is the step that
		// actually only lands after the promise resolves.
		const h = await makeHarness("compaction:\n  enabled: false\n", { persist: true });
		try {
			const added = path.join(h.cwd, "extra-root");
			await fs.mkdir(added, { recursive: true });
			// Persistence is lazy: the header only reaches disk once the session has
			// durable output, so seeding roots never materializes an empty session.
			h.session.sessionManager.appendMessage(makeAssistantMessage());
			await h.session.sessionManager.flush();

			await fs.writeFile(
				h.settingsPath,
				`compaction:\n  enabled: false\nworkspace:\n  additionalDirectories:\n    - ${added}\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// No intervening await: a fire-and-forget reconcile is still in flight.
			const sessionFile = h.session.sessionManager.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(await fs.readFile(sessionFile as string, "utf8")).toContain(added);
		} finally {
			await h.dispose();
		}
	});

	it("revokes a root removed from settings by the time refresh returns", async () => {
		const h = await makeHarness("compaction:\n  enabled: false\n");
		try {
			const added = path.join(h.cwd, "extra-root");
			await fs.mkdir(added, { recursive: true });
			await fs.writeFile(
				h.settingsPath,
				`compaction:\n  enabled: false\nworkspace:\n  additionalDirectories:\n    - ${added}\n`,
			);
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);
			expect(h.session.sessionManager.getAdditionalDirectories()).toEqual([added]);

			await fs.writeFile(h.settingsPath, "compaction:\n  enabled: false\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			expect(h.session.sessionManager.getAdditionalDirectories()).toEqual([]);
		} finally {
			await h.dispose();
		}
	});

	it("revokes a settings root removed while the session was stopped", async () => {
		// The live reconcile above only catches an edit the RUNNING session
		// observes. Across a stop the ownership set was rebuilt from the roots
		// current settings configure — and the removed root is, by definition,
		// absent from that value. So the set started empty, the reconcile saw no
		// change, and the header kept granting a directory config no longer named.
		const tempDir = TempDir.createSync("@pi-refresh-offline-root-");
		const cwd = tempDir.path();
		await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
		const settingsPath = path.join(cwd, "config.yml");
		const added = path.join(cwd, "extra-root");
		await fs.mkdir(added, { recursive: true });
		const sessionFile = path.join(cwd, "sessions", "session.jsonl");
		const api = `refresh-offline-root-${Bun.nanoseconds().toString(36)}`;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const common = {
			cwd,
			agentDir: cwd,
			authStorage,
			modelRegistry,
			model: buildLocalModel(api),
			disableExtensionDiscovery: true,
			contextFiles: [],
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		};
		try {
			await fs.writeFile(
				settingsPath,
				`compaction:\n  enabled: false\nworkspace:\n  additionalDirectories:\n    - ${added}\n`,
			);
			const firstManager = await SessionManager.open(sessionFile, cwd);
			const { session: first } = await createAgentSession({
				...common,
				sessionManager: firstManager,
				settings: await Settings.loadIsolated({ cwd, agentDir: cwd }),
			});
			expect(first.sessionManager.getAdditionalDirectories()).toEqual([added]);
			// Durable output, so the header (and its provenance) actually persists.
			first.sessionManager.appendMessage(makeAssistantMessage());
			await first.sessionManager.flush();
			await first.dispose();

			// Offline edit: the root is gone from config while nothing is running.
			await fs.writeFile(settingsPath, "compaction:\n  enabled: false\n");

			const resumedManager = await SessionManager.open(sessionFile, cwd);
			expect(resumedManager.getAdditionalDirectories()).toEqual([added]);
			const { session: resumed } = await createAgentSession({
				...common,
				sessionManager: resumedManager,
				settings: await Settings.loadIsolated({ cwd, agentDir: cwd }),
			});
			try {
				// Pre-fix the header kept granting `added`, and no later refresh
				// could ever revoke it.
				expect(resumed.sessionManager.getAdditionalDirectories()).toEqual([]);
			} finally {
				await resumed.dispose();
			}
		} finally {
			authStorage.close();
			await tempDir.remove();
		}
	});

	it("resolves a relative configured root against the session's CURRENT directory after a move", async () => {
		// The construction-time `cwd` and `sessionManager.getCwd()` agree until the
		// session moves, so this has to actually relocate: otherwise either cwd
		// source passes and the test proves nothing.
		const h = await makeHarness("compaction:\n  enabled: false\n");
		try {
			const destination = path.join(h.cwd, "destination");
			await fs.mkdir(path.join(destination, ".git"), { recursive: true });
			// The relative root resolves under the DESTINATION, not the launch cwd.
			const wanted = path.join(destination, "sibling-root");
			const stale = path.join(h.cwd, "sibling-root");
			await fs.mkdir(wanted, { recursive: true });
			await fs.mkdir(stale, { recursive: true });

			await h.session.sessionManager.moveTo(destination);
			expect(h.session.sessionManager.getCwd()).toBe(destination);

			await fs.writeFile(
				h.settingsPath,
				"compaction:\n  enabled: false\nworkspace:\n  additionalDirectories:\n    - sibling-root\n",
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.sessionManager.getAdditionalDirectories()).toEqual([wanted]);
		} finally {
			await h.dispose();
		}
	});
});

// `AgentSessionConfig.onBeforeRefresh` documents itself as "wired from
// `CreateAgentSessionOptions.onBeforeRefresh`", but the public factory neither
// declared the option nor forwarded it: a JS caller's hook was silently
// ignored, and a TS caller could not pass it at all.
describe("createAgentSession: onBeforeRefresh", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("runs a host's pre-refresh hook before the refresh re-reads config", async () => {
		const tempDir = TempDir.createSync("@pi-refresh-before-hook-");
		const cwd = tempDir.path();
		await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
		const settingsPath = path.join(cwd, "config.yml");
		await fs.writeFile(settingsPath, "compaction:\n  enabled: false\n");
		const api = `refresh-before-hook-${Bun.nanoseconds().toString(36)}`;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

		const scopes: string[] = [];
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
			// The hook stages config the refresh must then pick up, which is the
			// documented purpose — so this asserts the ORDERING, not just the call.
			onBeforeRefresh: async scope => {
				scopes.push(scope);
				await fs.writeFile(settingsPath, "compaction:\n  enabled: true\n");
			},
		});
		try {
			expect(session.settings.get("compaction.enabled")).toBe(false);

			const result = await session.refresh("settings");

			expect(scopes).toEqual(["settings"]);
			// Staged INSIDE the hook, so seeing it proves the hook ran first.
			expect(result.settingsChanged).toBe(true);
			expect(session.settings.get("compaction.enabled")).toBe(true);
		} finally {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		}
	});
});
