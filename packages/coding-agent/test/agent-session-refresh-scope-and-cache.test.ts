/**
 * Three `refresh` contracts that are not about pushing a value onto a live
 * subsystem:
 *
 *   - Scoped roster COUNTS. Skills and rules are one on-disk surface, so
 *     discovery necessarily rescans both, but the documented scoped contract
 *     says the scope selects which count is REPORTED. Populating both made
 *     `/refresh skills` print a rules result and vice versa.
 *   - Capability-cache invalidation on a SETTINGS-only refresh.
 *     `Settings.#readProjectSettings` reloads the foreign project layers
 *     through `loadCapability(settingsCapability.id)`, whose providers read via
 *     the process-lifetime `capability/fs` cache. Only `all` cleared it, so
 *     `refresh('settings')` after editing `.claude/settings.json` re-read the
 *     STARTUP bytes and reported `settings unchanged`.
 *   - The published rule snapshot excludes rules DELETED from disk even while
 *     TTSR is disabled: `retainRules` deliberately preserves the registration
 *     (so injection state survives an enabled flip), but republishing it left
 *     `rule://<deleted-name>` serving deleted content.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getActiveRules } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "refresh-scope-cache-model",
		name: "Refresh Scope Cache Model",
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

async function makeHarness(seed?: (cwd: string) => Promise<void>): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-refresh-scope-cache-");
	const cwd = tempDir.path();
	// A repo root so project-scoped discovery walks up and stops here.
	await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
	// Staged BEFORE construction so the session's initial discovery reads it and
	// the test observes a real transition.
	if (seed) await seed(cwd);
	const api = `refresh-scope-cache-${Bun.nanoseconds().toString(36)}`;
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
		model: buildLocalModel(api),
		disableExtensionDiscovery: true,
		// skills/rules intentionally omitted so discovery runs against disk.
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});

	return {
		session,
		cwd,
		settingsPath: path.join(cwd, "config.yml"),
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		},
	};
}

describe("AgentSession refresh: scoped roster counts", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports only the skills count for refresh('skills')", async () => {
		const h = await makeHarness();
		try {
			const result = await h.session.refresh("skills");

			expect(result.skills).toBeDefined();
			// Pre-fix: both fields were assigned unconditionally, so
			// `summarizeRefresh` printed a rules result for a skills refresh.
			expect(result.rules).toBeUndefined();
		} finally {
			await h.dispose();
		}
	});

	it("reports only the rules count for refresh('rules')", async () => {
		const h = await makeHarness();
		try {
			const result = await h.session.refresh("rules");

			expect(result.rules).toBeDefined();
			expect(result.skills).toBeUndefined();
		} finally {
			await h.dispose();
		}
	});

	it("still reports both counts for refresh('all')", async () => {
		// The scope selects which count is surfaced; `all` asked for both.
		const h = await makeHarness();
		try {
			const result = await h.session.refresh("all");

			expect(result.skills).toBeDefined();
			expect(result.rules).toBeDefined();
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('settings'): capability cache invalidation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("re-reads an edited project settings layer instead of the cached startup bytes", async () => {
		// `.claude/settings.json` is a FOREIGN project layer, reached only through
		// `loadCapability(settingsCapability.id)` — the path that reads via the
		// process-lifetime `capability/fs` cache. Its startup bytes are cached by
		// the session's own construction-time settings load.
		const h = await makeHarness(async cwd => {
			await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".claude", "settings.json"),
				`${JSON.stringify({ includeModelInPrompt: true })}\n`,
			);
		});
		try {
			expect(h.session.settings.get("includeModelInPrompt")).toBe(true);

			await fs.writeFile(
				path.join(h.cwd, ".claude", "settings.json"),
				`${JSON.stringify({ includeModelInPrompt: false })}\n`,
			);
			const result = await h.session.refresh("settings");

			// Pre-fix: `resetCapabilities()` was gated on `doRoster || doMcp`, so a
			// settings-only refresh served the cached startup bytes and reported
			// `settings unchanged`.
			expect(result.settingsChanged).toBe(true);
			expect(h.session.settings.get("includeModelInPrompt")).toBe(false);
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession refresh('rules'): disabled-TTSR published snapshot", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drops a deleted condition rule from the active set while TTSR is disabled", async () => {
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `deleted-cond-${marker}`;
		const trigger = `FORBIDDEN_${marker}`;
		const rulePath = (cwd: string) => path.join(cwd, ".omp", "rules", `${ruleName}.md`);
		// Registered while TTSR is ENABLED, so the manager really holds it; the
		// file is then deleted with TTSR OFF, which is the window where
		// `retainRules` deliberately no-ops.
		const h = await makeHarness(async cwd => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				rulePath(cwd),
				`---\nname: ${ruleName}\ndescription: blocks\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
		});
		try {
			await h.session.refresh("rules");
			expect(h.session.ttsrManager?.hasRule(ruleName)).toBe(true);

			// Turn TTSR off, delete the rule from disk, then refresh the roster.
			await fs.writeFile(h.settingsPath, "ttsr:\n  enabled: false\n");
			await h.session.refresh("settings");
			await fs.rm(rulePath(h.cwd));
			const result = await h.session.refresh("rules");

			// Pre-fix: `retainRules` preserved the registration (correct — the
			// injection state must survive an enabled flip) but the `getRules()`
			// spread republished it, so `rule://<deleted-name>` still served the
			// deleted content and the count still included it.
			expect(getActiveRules().map(r => r.name)).not.toContain(ruleName);
			expect(result.rules).toBe(getActiveRules().length);
		} finally {
			await h.dispose();
		}
	});

	it("keeps publishing a still-present condition rule while TTSR is disabled", async () => {
		// The filter must key on the fresh DISCOVERY, not on the disabled state:
		// a rule still on disk stays reachable via `rule://`.
		const marker = Bun.nanoseconds().toString(36);
		const ruleName = `kept-cond-${marker}`;
		const trigger = `FORBIDDEN_${marker}`;
		const h = await makeHarness(async cwd => {
			await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
			await fs.writeFile(
				path.join(cwd, ".omp", "rules", `${ruleName}.md`),
				`---\nname: ${ruleName}\ndescription: blocks\ncondition: "${trigger}"\nscope: "text"\n---\nbody\n`,
			);
		});
		try {
			await h.session.refresh("rules");
			expect(h.session.ttsrManager?.hasRule(ruleName)).toBe(true);

			await fs.writeFile(h.settingsPath, "ttsr:\n  enabled: false\n");
			await h.session.refresh("settings");
			await h.session.refresh("rules");

			expect(getActiveRules().map(r => r.name)).toContain(ruleName);
		} finally {
			await h.dispose();
		}
	});
});
