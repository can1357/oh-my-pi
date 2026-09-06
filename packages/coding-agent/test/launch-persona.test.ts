import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { readPersistedAgentPersona } from "@oh-my-pi/pi-coding-agent/session/persisted-persona";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { DiscoveredAgent } from "@oh-my-pi/pi-coding-agent/session/tool-policy";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Observable `--agent <name>` launch-as-switch contract (plan §2, PR 9510 stage 2):
 * the persona must be active on the session BEFORE the first user turn — tools
 * narrowed, model applied, identity prompt riding the append channel — and
 * explicit CLI flags must still win. Tests drive the real pipeline:
 * buildSessionOptions (CLI parse → pendingPersonaAgent) → createAgentSession
 * (PersonaRuntime.enter).
 */

const READER_AGENT_MD = `---
name: fixture-reader
description: Read-only fixture persona
tools:
  - read
spawns: []
---

You are the fixture reader persona.`;

const MODELED_AGENT_MD = `---
name: fixture-modeled
description: Persona declaring a model
model:
  - anthropic/claude-sonnet-4-5
---

You are the modeled persona.`;

let workspace: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(() => {
	workspace = TempDir.createSync("@omp-launch-persona-");
	authStorage = createInMemoryAuthStorage();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	modelRegistry = new ModelRegistry(authStorage);
});

afterAll(async () => {
	authStorage.close();
	await workspace.remove();
});

let session: AgentSession | undefined;

afterEach(async () => {
	if (session) {
		await session.dispose();
		session = undefined;
	}
});

async function writeFixtureAgents(...files: Array<{ name: string; content: string }>): Promise<void> {
	const agentsDir = path.join(workspace.path(), ".omp", "agents");
	await fs.mkdir(agentsDir, { recursive: true });
	for (const file of files) {
		await fs.writeFile(path.join(agentsDir, file.name), file.content, "utf-8");
	}
}

interface SessionOpts {
	args: string[];
	extraOptions?: Record<string, unknown>;
}

/** Full launch path: parseArgs → buildSessionOptions → createAgentSession. */
async function launch({ args, extraOptions }: SessionOpts): Promise<AgentSession> {
	const parsed = parseArgs(["--cwd", workspace.path(), ...args]);
	const settings = Settings.isolated({ "async.enabled": false });
	const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings);
	Object.assign(options, {
		authStorage,
		modelRegistry,
		settings,
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		...extraOptions,
	});
	const result = await createAgentSession(options as Parameters<typeof createAgentSession>[0]);
	session = result.session;
	return session;
}

describe("--agent launch-as-switch", () => {
	it("narrows the session's active tools to the persona's tools before the first turn", async () => {
		await writeFixtureAgents({ name: "fixture-reader.md", content: READER_AGENT_MD });
		const launched = await launch({ args: ["--agent", "fixture-reader"] });

		expect(launched.getPersonaRuntime()?.policy.isPersonaActive()).toBe(true);
		const enabled = new Set(launched.getEnabledToolNames());
		expect(enabled.has("read")).toBe(true);
		expect(enabled.has("write")).toBe(false);
		expect(enabled.has("bash")).toBe(false);
		expect(enabled.has("edit")).toBe(false);
	});

	it("applies the persona's identity prompt through the append channel", async () => {
		await writeFixtureAgents({ name: "fixture-reader.md", content: READER_AGENT_MD });
		const launched = await launch({ args: ["--agent", "fixture-reader"] });

		expect(launched.getPersonaAppendPrompt()).toContain("fixture reader persona");
		const systemPrompt = launched.systemPrompt.join("\n");
		expect(systemPrompt).toContain("You are the fixture reader persona.");
	});

	it("applies the persona's declared model", async () => {
		await writeFixtureAgents({ name: "fixture-modeled.md", content: MODELED_AGENT_MD });
		const launched = await launch({ args: ["--agent", "fixture-modeled"] });

		expect(launched.model?.provider).toBe("anthropic");
		expect(launched.model?.id).toBe("claude-sonnet-4-5");
	});

	it("explicit --model beats the persona's declared model", async () => {
		await writeFixtureAgents({ name: "fixture-modeled.md", content: MODELED_AGENT_MD });
		const override = getBundledModel("anthropic", "claude-opus-4-5");
		if (!override) throw new Error("Expected built-in anthropic opus model to exist");
		const launched = await launch({
			args: ["--agent", "fixture-modeled", "--model", `${override.provider}/${override.id}`],
		});

		// The explicit CLI model wins over the persona's declared model — distinct
		// ids make the override observable rather than a coincidental identity.
		expect(launched.model?.id).toBe(override.id);
		expect(launched.model?.id).not.toBe("claude-sonnet-4-5");
	});

	it("no --agent flag still installs a persona runtime (no persona active)", async () => {
		const launched = await launch({ args: [] });

		// The runtime is unconditional so `/agent` and resume reconcile work in
		// sessions launched without a persona; only activation is persona-specific.
		const runtime = launched.getPersonaRuntime();
		expect(runtime).toBeDefined();
		expect(runtime?.policy.isPersonaActive()).toBe(false);
		expect(launched.getPersonaAppendPrompt()).toBeUndefined();
		const enabled = launched.getEnabledToolNames();
		expect(enabled).toContain("read");
		expect(enabled).toContain("write");
	});

	it("--agent with a nonexistent name fails session construction", async () => {
		await writeFixtureAgents({ name: "fixture-reader.md", content: READER_AGENT_MD });
		await expect(launch({ args: ["--agent", "does-not-exist"] })).rejects.toThrow(/does-not-exist/);
	});

	it("explicit --tools conflicts with --agent: persona grant wins", async () => {
		await writeFixtureAgents({ name: "fixture-reader.md", content: READER_AGENT_MD });
		const launched = await launch({
			args: ["--agent", "fixture-reader", "--tools", "grep,read"],
		});

		// Persona tools: [read] intersect the CLI grant → only `read` survives.
		const enabled = new Set(launched.getEnabledToolNames());
		expect(enabled.has("read")).toBe(true);
		expect(enabled.has("grep")).toBe(false);
		expect(enabled.has("write")).toBe(false);
	});

	it("buildSessionOptions threads pendingPersonaAgent with explicit CLI overrides", async () => {
		await writeFixtureAgents({ name: "fixture-modeled.md", content: MODELED_AGENT_MD });
		const parsed = parseArgs([
			"--cwd",
			workspace.path(),
			"--agent",
			"fixture-modeled",
			"--model",
			"anthropic/claude-opus-4-1",
		]);
		const options = await buildSessionOptions(
			parsed,
			[],
			SessionManager.inMemory(),
			modelRegistry,
			Settings.isolated(),
		);

		const personaAgent = options.pendingPersonaAgent as DiscoveredAgent | undefined;
		expect(personaAgent?.name).toBe("fixture-modeled");
		expect(options.pendingPersonaExplicit?.model).toBe("anthropic/claude-opus-4-1");
	});

	it("launch appends an agent mode_change journal entry for future resume reconcile", async () => {
		await writeFixtureAgents({ name: "fixture-reader.md", content: READER_AGENT_MD });
		const launched = await launch({ args: ["--agent", "fixture-reader"] });

		const modeChanges = launched.sessionManager
			.getEntries()
			.filter(entry => entry.type === "mode_change" && (entry as { mode?: string }).mode === "agent");
		expect(modeChanges).toHaveLength(1);
		expect((modeChanges[0] as { data?: { name?: string } }).data?.name).toBe("fixture-reader");
	});

	it("persists explicit CLI overrides nested so resume reconcile reads them back", async () => {
		await writeFixtureAgents({ name: "fixture-modeled.md", content: MODELED_AGENT_MD });
		// The shared `launch` helper wires an in-memory manager; this test needs the
		// real JSONL file a stored session carries, so supply a persisting one.
		const launched = await launch({
			args: ["--agent", "fixture-modeled", "--model", "anthropic/claude-sonnet-4-5", "--thinking", "high"],
			extraOptions: {
				sessionManager: SessionManager.create(workspace.path(), path.join(workspace.path(), "sessions")),
			},
		});
		await launched.sessionManager.ensureOnDisk();
		await launched.sessionManager.flush();

		// The journal must carry the nested contract (acp readPersistedAgentPersona
		// narrows `data.explicit`), not a flat spread of the overrides.
		const sessionFile = launched.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file for a persona launch");
		const lines = (await fs.readFile(sessionFile, "utf-8")).split("\n").filter(line => line.trim() !== "");
		const agentEntry = lines
			.map(line => JSON.parse(line) as { type?: string; mode?: string; data?: Record<string, unknown> })
			.filter(entry => entry.type === "mode_change" && entry.mode === "agent")
			.at(-1);
		if (!agentEntry) throw new Error("Expected agent mode_change entry on disk");
		const explicitRaw = agentEntry.data?.explicit;
		expect(explicitRaw).toEqual({ model: "anthropic/claude-sonnet-4-5", thinking: "high", tools: undefined });

		// And the reader narrows it back to the resume shape.
		const desired = readPersistedAgentPersona(
			launched.sessionManager.getEntries().map(entry => entry as { type: unknown; mode?: unknown; data?: unknown }),
		);
		expect(desired?.name).toBe("fixture-modeled");
		expect(desired?.explicit?.model).toBe("anthropic/claude-sonnet-4-5");
		expect(desired?.explicit?.thinking).toBe("high");
	});
});
