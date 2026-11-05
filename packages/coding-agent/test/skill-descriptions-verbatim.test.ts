import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { removeSyncWithRetries, Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { cfgSkillsCompressDescriptions } from "../src/extensibility/settings";
import { SkillDescriptionCatalog, SkillDescriptionStore } from "../src/extensibility/skill-descriptions";
import type { Skill } from "../src/extensibility/skills";
import { createAgentSession } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

const original: Skill = {
	name: "browser-research",
	description:
		"Use when exploring interactive sites with JavaScript execution, authenticated sessions, and multi-step browser actions; do not use for static public web pages that can be read directly.",
	filePath: "/skills/browser-research/SKILL.md",
	baseDir: "/skills/browser-research",
	source: "test",
};
// The part of the description the 100-character preview drops.
const DROPPED_TAIL = "do not use for static public web pages";

describe("skills.compressDescriptions in a session", () => {
	let dir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		dir = path.join(os.tmpdir(), `pi-skill-descriptions-${Snowflake.next()}`);
		fs.mkdirSync(dir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		if (fs.existsSync(dir)) removeSyncWithRetries(dir);
	});

	async function openSession(settings: Settings): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [original],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);
		return session;
	}

	/** The skill's line in the system prompt the provider receives. */
	function promptLine(session: AgentSession): string {
		const line = session.agent.state.systemPrompt
			.join("\n\n")
			.split("\n")
			.find(candidate => candidate.startsWith(`- ${original.name}: `));
		if (!line) throw new Error("the system prompt has no line for the skill");
		return line;
	}

	/** Changes the setting the way `/settings` does, then waits for the coalesced prompt rebuild. */
	async function setCompression(session: AgentSession, enabled: boolean): Promise<void> {
		cfgSkillsCompressDescriptions.override(session.settings, enabled);
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => undefined);
	}

	// Failure mode: the opt-out is not carried from Settings into the session, so the model keeps getting
	// previews cut before the trigger conditions.
	it("sends the authored description from the first prompt when the setting starts off", async () => {
		const authored = await openSession(Settings.isolated({ "skills.compressDescriptions": false }));
		expect(promptLine(authored)).toBe(`- ${original.name}: ${original.description}`);

		// Default: the preview drops the end of the description, where the trigger conditions sit.
		const preview = await openSession(Settings.isolated({}));
		expect(promptLine(preview)).not.toContain(DROPPED_TAIL);
	});

	// Failure mode: a change in /settings leaves an open session, and the descriptions /context counts, on the
	// rendering it started with.
	it("rebuilds the prompt of an open session when the setting changes, in both directions", async () => {
		const session = await openSession(Settings.isolated({}));
		expect(promptLine(session)).not.toContain(DROPPED_TAIL);
		expect(session.renderedSkills[0]?.description).not.toContain(DROPPED_TAIL);

		await setCompression(session, false);
		expect(promptLine(session)).toBe(`- ${original.name}: ${original.description}`);
		expect(session.renderedSkills[0]?.description).toBe(original.description);

		await setCompression(session, true);
		expect(promptLine(session)).not.toContain(DROPPED_TAIL);
		expect(session.renderedSkills[0]?.description).not.toContain(DROPPED_TAIL);
	});

	// Failure mode: /new rebuilds the prompt with the rendering the session started with.
	it("starts a new conversation (/new) with the setting as changed", async () => {
		const session = await openSession(Settings.isolated({}));
		cfgSkillsCompressDescriptions.override(session.settings, false);
		await session.newSession();
		expect(promptLine(session)).toBe(`- ${original.name}: ${original.description}`);
	});

	// Failure mode: an SDK session disposed while a prompt rebuild is under way opens its own description
	// database after its disposer ran, and nothing ever closes that handle.
	it("opens no description store once the session is disposed", async () => {
		const fixture = path.join(import.meta.dir, "fixtures/skill-description-store-dispose.ts");
		const result = await $`${process.execPath} ${fixture}`.quiet().nothrow();
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		expect(JSON.parse(result.stdout.toString())).toEqual({ opened: false });
	});
});

describe("verbatim SkillDescriptionCatalog", () => {
	const changed: Skill = { ...original, description: `${original.description} Also inspect accessibility trees.` };

	// Failure mode: a verbatim session still reads the cache or bills compression calls, or never compresses
	// again once the setting is switched back on.
	it("ignores a warm cache and never compresses while verbatim, and compresses again once re-enabled", async () => {
		using temp = TempDir.createSync("omp-skill-description-verbatim-");
		using store = SkillDescriptionStore.open(temp.join("skills.db"));
		let calls = 0;
		const compress = {
			modelKey: () => "test/fast",
			compress: async () => {
				calls++;
				return "Use for interactive browser tasks.";
			},
		};
		let verbatim = false;
		const warm = new SkillDescriptionCatalog({ store, compress, verbatim: () => verbatim });
		warm.render([original]);
		await warm.waitForPending();
		expect(calls).toBe(1);

		const catalog = new SkillDescriptionCatalog({ store, compress, verbatim: () => verbatim });
		expect(catalog.render([original])[0]?.description).toBe("Use for interactive browser tasks.");

		verbatim = true;
		expect(catalog.render([original, changed]).map(skill => skill.description)).toEqual([
			original.description,
			changed.description,
		]);
		expect(catalog.snapshot([changed])[0]?.description).toBe(changed.description);
		await catalog.waitForPending();
		expect(calls).toBe(1);

		verbatim = false;
		catalog.render([changed]);
		await catalog.waitForPending();
		expect(calls).toBe(2);
	});

	// Failure mode: compressions queued before the switch still go out, and are billed, after opting out.
	it("sends no compression still waiting for a slot once switched to verbatim", async () => {
		using temp = TempDir.createSync("omp-skill-description-verbatim-");
		using store = SkillDescriptionStore.open(temp.join("skills.db"));
		const skills = Array.from({ length: 8 }, (_, index) => ({ ...original, name: `${original.name}-${index}` }));
		const firstSent = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let sent = 0;
		const compress = {
			modelKey: () => "test/fast",
			compress: async () => {
				sent++;
				firstSent.resolve();
				await release.promise;
				return "Use for interactive browser tasks.";
			},
		};
		let verbatim = false;
		const catalog = new SkillDescriptionCatalog({ store, compress, verbatim: () => verbatim });
		catalog.render(skills);
		await firstSent.promise;
		// The requests already sent hold every compression slot; the rest wait for one.
		const sentBeforeSwitch = sent;
		expect(sentBeforeSwitch).toBeLessThan(skills.length);

		verbatim = true;
		release.resolve();
		await catalog.waitForPending();
		expect(sent).toBe(sentBeforeSwitch);
	});

	// Failure mode: a session that renders verbatim still creates skill-descriptions.db.
	it("creates its cache file only when a render compresses", async () => {
		using temp = TempDir.createSync("omp-skill-description-verbatim-");
		const dbPath = temp.join("skills.db");
		let verbatim = true;
		let opened: SkillDescriptionStore | undefined;
		const catalog = new SkillDescriptionCatalog({
			store: () => {
				opened = SkillDescriptionStore.open(dbPath);
				return opened;
			},
			verbatim: () => verbatim,
		});

		catalog.render([original]);
		expect(fs.existsSync(dbPath)).toBe(false);

		verbatim = false;
		catalog.render([original]);
		expect(fs.existsSync(dbPath)).toBe(true);
		await opened?.close();
	});
});
