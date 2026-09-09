import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { getManagedSkillsDir } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetActiveSkillsForTests, type Skill, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { MnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { LearnTool } from "@oh-my-pi/pi-coding-agent/tools/learn";
import { ManageSkillTool } from "@oh-my-pi/pi-coding-agent/tools/manage-skill";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

function makeSession(
	settingsOverrides: Partial<Record<SettingPath, unknown>> = {},
	extra: Partial<ToolSession> = {},
): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(settingsOverrides),
		...extra,
	};
}

describe("autolearn tool gating", () => {
	it("offers neither tool by default (autolearn disabled)", async () => {
		const names = (await createTools(makeSession())).map(t => t.name);
		expect(names).not.toContain("learn");
		expect(names).not.toContain("manage_skill");
	});

	it("offers manage_skill but not learn when enabled with no memory backend", async () => {
		const names = (await createTools(makeSession({ "autolearn.enabled": true, "memory.backend": "off" }))).map(
			t => t.name,
		);
		expect(names).toContain("manage_skill");
		expect(names).not.toContain("learn");
	});

	it("offers both tools, marked essential, when enabled with a live backend", async () => {
		const tools = await createTools(makeSession({ "autolearn.enabled": true, "memory.backend": "mnemopi" }));
		const learn = tools.find(t => t.name === "learn");
		const manage = tools.find(t => t.name === "manage_skill");
		expect(learn).toBeDefined();
		expect(manage).toBeDefined();
		// loadMode "essential" is what keeps them active under tools.discoveryMode "all".
		expect(learn?.loadMode).toBe("essential");
		expect(manage?.loadMode).toBe("essential");
	});

	it("force-includes the tools into an explicit restricted toolNames list", async () => {
		// A session created with autolearn on but a narrow tool list still gets the
		// controller/guidance, so the tools the nudge points at must be present.
		const withBackend = (
			await createTools(makeSession({ "autolearn.enabled": true, "memory.backend": "mnemopi" }), ["read"])
		).map(t => t.name);
		expect(withBackend).toContain("manage_skill");
		expect(withBackend).toContain("learn");

		const noBackend = (
			await createTools(makeSession({ "autolearn.enabled": true, "memory.backend": "off" }), ["read"])
		).map(t => t.name);
		expect(noBackend).toContain("manage_skill");
		expect(noBackend).not.toContain("learn");
	});

	it("excludes the tools from a subagent when not in the explicit list", async () => {
		// taskDepth > 0: the controller never runs here, so a subagent's explicit
		// whitelist must not be silently widened with write-capable tools.
		const sub = (
			await createTools(makeSession({ "autolearn.enabled": true, "memory.backend": "mnemopi" }, { taskDepth: 1 }), [
				"read",
			])
		).map(t => t.name);
		expect(sub).not.toContain("manage_skill");
		expect(sub).not.toContain("learn");

		// Nor via discovery (no explicit list) at depth.
		const subDiscovered = (
			await createTools(makeSession({ "autolearn.enabled": true, "memory.backend": "mnemopi" }, { taskDepth: 1 }))
		).map(t => t.name);
		expect(subDiscovered).not.toContain("manage_skill");
		expect(subDiscovered).not.toContain("learn");
	});

	it("allows the tools in a subagent when explicitly requested in toolNames", async () => {
		// Frontmatter tools: list overrides the taskDepth gate.
		const sub = (
			await createTools(makeSession({ "autolearn.enabled": true, "memory.backend": "mnemopi" }, { taskDepth: 1 }), [
				"manage_skill",
				"learn",
			])
		).map(t => t.name);
		expect(sub).toContain("manage_skill");
		expect(sub).toContain("learn");
	});

	it("offers learn with the file-based local backend", async () => {
		const names = (await createTools(makeSession({ "autolearn.enabled": true, "memory.backend": "local" }))).map(
			t => t.name,
		);
		expect(names).toContain("learn");
		expect(names).toContain("manage_skill");

		// Force-included into an explicit restricted toolNames list too.
		const restricted = (
			await createTools(makeSession({ "autolearn.enabled": true, "memory.backend": "local" }), ["read"])
		).map(t => t.name);
		expect(restricted).toContain("learn");
	});
});

describe("manage_skill execute", () => {
	let tempHome: string;
	let originalAgentDir: string;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-manage-skill-"));
		spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));
	});

	afterEach(async () => {
		spyOn(os, "homedir").mockRestore();
		setAgentDir(originalAgentDir);
		resetActiveSkillsForTests();
		await removeWithRetries(tempHome);
	});

	const tool = () => ManageSkillTool.createIf(makeSession({ "autolearn.enabled": true }))!;

	it("create writes the managed SKILL.md; delete removes it", async () => {
		const file = path.join(getManagedSkillsDir(), "demo", "SKILL.md");
		await tool().execute("1", { action: "create", name: "demo", description: "When to demo.", body: "# Demo" });
		expect(await Bun.file(file).exists()).toBe(true);

		await tool().execute("2", { action: "delete", name: "demo" });
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("rejects create without a body and delete of a missing skill", async () => {
		await expect(tool().execute("3", { action: "create", name: "nobody", description: "d" })).rejects.toThrow(
			/requires/,
		);
		await expect(tool().execute("4", { action: "delete", name: "absent" })).rejects.toThrow(/does not exist/);
	});

	it("schema rejects create/update without description+body but allows delete", () => {
		const schema = tool().parameters;
		expect(schema({ action: "create", name: "x" }) instanceof type.errors).toBe(true);
		expect(schema({ action: "update", name: "x", description: "d" }) instanceof type.errors).toBe(true);
		expect(schema({ action: "create", name: "x", description: "d", body: "b" }) instanceof type.errors).toBe(false);
		expect(schema({ action: "delete", name: "x" }) instanceof type.errors).toBe(false);
	});

	it("refuses to create a managed skill an authored skill of the same name would shadow", async () => {
		const authored: Skill = {
			name: "demo",
			description: "An authored demo skill.",
			filePath: path.join(tempHome, "authored", "demo", "SKILL.md"),
			baseDir: path.join(tempHome, "authored", "demo"),
			source: "native:user",
			_source: {
				provider: "native",
				providerName: "Pi",
				path: path.join(tempHome, "authored", "demo", "SKILL.md"),
				level: "user",
			},
		};
		setActiveSkills([authored]);

		const result = await tool().execute("c", {
			action: "create",
			name: "demo",
			description: "When to demo.",
			body: "# Demo",
		});

		// Reported as an error, not a false "Created".
		expect(result.isError).toBe(true);
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
		expect(text).toMatch(/authored skill/i);
		expect(text).not.toContain("Created");
		// Nothing was written, so the managed skill can never surface.
		expect(await Bun.file(path.join(getManagedSkillsDir(), "demo", "SKILL.md")).exists()).toBe(false);
	});
});

describe("learn execute", () => {
	let tempHome: string;
	let remembered: string[];
	let originalAgentDir: string;

	function learnSession(): ToolSession {
		const fakeState = {
			sessionId: "sess-1",
			session: { sessionManager: { getCwd: () => "/tmp/work" } },
			rememberScoped: (memory: string) => {
				remembered.push(memory);
				return "mem-id";
			},
		};
		return makeSession(
			{ "autolearn.enabled": true, "memory.backend": "mnemopi" },
			{ getMnemopiSessionState: () => fakeState as unknown as MnemopiSessionState },
		);
	}

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-learn-"));
		spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		remembered = [];
	});

	afterEach(async () => {
		spyOn(os, "homedir").mockRestore();
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempHome);
	});

	it("stores a lesson to memory without writing a skill when no skill payload", async () => {
		await new LearnTool(learnSession()).execute("1", { memory: "Prefer Bun.file over readFileSync." });
		expect(remembered).toEqual(["Prefer Bun.file over readFileSync."]);
		// No managed skills written.
		expect(await fs.readdir(getManagedSkillsDir()).catch(() => [])).toHaveLength(0);
	});

	it("stores a lesson AND mints a managed skill when a skill payload is given", async () => {
		await new LearnTool(learnSession()).execute("2", {
			memory: "Use the worker host entry pattern.",
			skill: { action: "create", name: "worker-host", description: "Spawn workers.", body: "# Worker host" },
		});
		expect(remembered).toHaveLength(1);
		expect(await Bun.file(path.join(getManagedSkillsDir(), "worker-host", "SKILL.md")).exists()).toBe(true);
	});

	it("surfaces a partial-outcome error when the skill name is invalid", async () => {
		await expect(
			new LearnTool(learnSession()).execute("3", {
				memory: "lesson",
				skill: { action: "create", name: "../evil", description: "d", body: "b" },
			}),
		).rejects.toThrow(/Lesson stored, but the managed skill could not be written/);
		// The memory half still ran.
		expect(remembered).toHaveLength(1);
	});

	it("reports Hindsight lessons as queued rather than stored", async () => {
		const queued: Array<{ memory: string; context?: string }> = [];
		const session = makeSession(
			{ "autolearn.enabled": true, "memory.backend": "hindsight" },
			{
				getHindsightSessionState: () =>
					({
						enqueueRetain: (memory: string, context?: string) => {
							queued.push({ memory, context });
						},
					}) as unknown as HindsightSessionState,
			},
		);

		const result = await new LearnTool(session).execute("hindsight-1", {
			memory: "Queue this lesson.",
			context: "from review",
		});

		expect(queued).toEqual([{ memory: "Queue this lesson.", context: "from review" }]);
		expect(result.content[0]).toEqual({ type: "text", text: "Lesson queued for retention." });
	});

	it("reports Hindsight skill failures as queued partial outcomes", async () => {
		const queued: string[] = [];
		const session = makeSession(
			{ "autolearn.enabled": true, "memory.backend": "hindsight" },
			{
				getHindsightSessionState: () =>
					({
						enqueueRetain: (memory: string) => {
							queued.push(memory);
						},
					}) as unknown as HindsightSessionState,
			},
		);

		await expect(
			new LearnTool(session).execute("hindsight-2", {
				memory: "queued lesson",
				skill: { action: "create", name: "../evil", description: "d", body: "b" },
			}),
		).rejects.toThrow(/Lesson queued for retention, but the managed skill could not be written/);
		expect(queued).toEqual(["queued lesson"]);
	});

	it("fails the lesson and skips the skill when mnemopi returns no id", async () => {
		const failingState = {
			sessionId: "sess-2",
			session: { sessionManager: { getCwd: () => "/tmp/work" } },
			rememberScoped: () => undefined,
		};
		const session = makeSession(
			{ "autolearn.enabled": true, "memory.backend": "mnemopi" },
			{ getMnemopiSessionState: () => failingState as unknown as MnemopiSessionState },
		);
		await expect(
			new LearnTool(session).execute("5", {
				memory: "lesson",
				skill: { action: "create", name: "should-not-exist", description: "d", body: "b" },
			}),
		).rejects.toThrow(/did not store/i);
		// A failed lesson must not leave a minted skill behind.
		expect(await Bun.file(path.join(getManagedSkillsDir(), "should-not-exist", "SKILL.md")).exists()).toBe(false);
	});
});
