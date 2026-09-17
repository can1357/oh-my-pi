import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getCustomApi,
	type RegisteredCustomApi,
	registerCustomApi,
	unregisterCustomApis,
} from "@pk-nerdsaver-ai/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { parseFrontmatter, removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";
import { __resetDirsFromEnvForTests, getActiveProfile, getAgentDir, setAgentDir } from "@pk-nerdsaver-ai/pi-utils/dirs";
import {
	type EvolutionCompletion,
	evolveSkill,
	loadEvolutionReport,
	promoteEvolution,
} from "../src/autolearn/evolution";
import type { EvolutionInput } from "../src/autolearn/evolution-types";
import { readManagedSkill, writeManagedSkill } from "../src/autolearn/managed-skills";
import { writeVaultLesson } from "../src/autolearn/vault";
import { Settings } from "../src/config/settings";
import { getActiveSkills, type Skill, setActiveSkills } from "../src/extensibility/skills";
import { getMemoryRoot } from "../src/memories";
import type { ToolSession } from "../src/tools";
import { LearnTool } from "../src/tools/learn";
import { ManageSkillTool } from "../src/tools/manage-skill";

const input: EvolutionInput = {
	lessons: "Normalize the requested token rather than returning a fixed answer.",
	training: [{ id: "train", prompt: "alpha", expected: "ALPHA" }],
	holdout: [{ id: "heldout", prompt: "private-holdout", expected: "PRIVATE-HOLDOUT" }],
	rounds: 2,
	candidates: 2,
};
const candidate = { description: "Normalize an input token.", body: "Return uppercase tokens." };

describe("bounded skill evolution and Obsidian learning", () => {
	let root: string;
	let agentDir: string;
	let vault: string;
	let settings: Settings;
	let previousApi: RegisteredCustomApi | undefined;
	let previousSkills: readonly Skill[];
	let original: { agent?: string; omp?: string; pi?: string; effective: string; profile?: string };
	const restores: (() => void)[] = [];

	beforeEach(async () => {
		previousSkills = getActiveSkills();
		original = {
			agent: process.env.PI_CODING_AGENT_DIR,
			omp: process.env.OMP_PROFILE,
			pi: process.env.PI_PROFILE,
			effective: getAgentDir(),
			profile: getActiveProfile(),
		};
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-evolution-"));
		agentDir = path.join(root, "agent");
		vault = path.join(root, "Design-and-Building");
		await fs.mkdir(agentDir);
		await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
		setAgentDir(agentDir);
		expect(getAgentDir()).toBe(agentDir);
		settings = Settings.isolated({
			"autolearn.enabled": true,
			"autolearn.evolution.enabled": true,
			"autolearn.vaultPath": vault,
			"memory.backend": "off",
		});
		const dirSpy = spyOn(settings, "getAgentDir").mockReturnValue(agentDir);
		const cwdSpy = spyOn(settings, "getCwd").mockReturnValue(root);
		restores.push(
			() => dirSpy.mockRestore(),
			() => cwdSpy.mockRestore(),
		);
		previousApi = getCustomApi("mock");
		registerMockApi("autolearn-evolution-test");
	});
	afterEach(async () => {
		try {
			setActiveSkills(previousSkills);
			for (const restore of restores.splice(0)) restore();
			unregisterCustomApis("autolearn-evolution-test");
			if (previousApi) registerCustomApi("mock", previousApi.streamSimple, previousApi.sourceId, previousApi.stream);
		} finally {
			try {
				for (const [key, value] of [
					["PI_CODING_AGENT_DIR", original.agent],
					["OMP_PROFILE", original.omp],
					["PI_PROFILE", original.pi],
				] as const) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
				__resetDirsFromEnvForTests();
				expect(getAgentDir()).toBe(original.effective);
				expect(getActiveProfile()).toBe(original.profile);
			} finally {
				await removeWithRetries(root);
			}
		}
	});

	it("refuses authored names at evaluation and when authorship changes before promotion", async () => {
		const authored = (name: string): Skill => ({
			name,
			description: "Authored.",
			filePath: path.join(root, "SKILL.md"),
			baseDir: root,
			source: "user",
		});
		setActiveSkills([...previousSkills, authored("reserved")]);
		await expect(evolveSkill("reserved", input, options())).rejects.toThrow("authored skill");
		const run = await evolveSkill("later-authored", input, options());
		setActiveSkills([...previousSkills, authored("later-authored")]);
		await expect(promoteEvolution(agentDir, run.report.id, "later-authored")).rejects.toThrow("authored skill");
		expect(await readManagedSkill("later-authored", agentDir)).toBeNull();
	});

	it("retains local memory when the configured vault cannot be written", async () => {
		settings.override("memory.backend", "local");
		settings.override("autolearn.vaultPath", path.join(root, "absent"));
		const result = await new LearnTool(session()).execute("partial", {
			memory: "A retained lesson survives mirror failure.",
		});
		expect(result.isError).toBe(true);
		expect(result.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "text", text: expect.stringContaining("Lesson stored") }),
			]),
		);
		expect(await Bun.file(path.join(getMemoryRoot(agentDir, root), "learned.md")).text()).toContain(
			"survives mirror failure",
		);
	});

	it("retains a vault lesson when the selected memory backend is unavailable", async () => {
		settings.override("memory.backend", "mnemopi");
		const result = await new LearnTool(session()).execute("memory-unavailable", {
			memory: "This lesson must survive a backend outage.",
			skill: { action: "create", name: "not-promoted-on-failure", ...candidate },
		});
		expect(result.isError).toBe(true);
		const details = result.details as { vaultPath: string };
		expect(await Bun.file(details.vaultPath).text()).toContain("survive a backend outage");
		expect(await readManagedSkill("not-promoted-on-failure", agentDir)).toBeNull();
	});

	const solver: EvolutionCompletion = async (system, user) => {
		if (system.includes("propose one improved")) {
			expect(user).not.toContain("private-holdout");
			expect(user).not.toContain("PRIVATE-HOLDOUT");
			return JSON.stringify(candidate);
		}
		return system.includes(candidate.body) ? user.toUpperCase() : "wrong";
	};
	function options(complete: EvolutionCompletion = solver) {
		return { agentDir, model: "test/model", complete, maxCalls: 24, signal: new AbortController().signal };
	}
	function session(): ToolSession {
		const model = createMockModel({
			handler: async context => {
				expect(context.tools).toEqual([]);
				expect(context.messages).toHaveLength(1);
				const message = context.messages[0];
				if (message.role !== "user" || typeof message.content !== "string")
					throw new Error("Unexpected model context.");
				return {
					content: [
						await solver(context.systemPrompt?.join("\n") ?? "", message.content, new AbortController().signal),
					],
				};
			},
		});
		return {
			settings,
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getActiveModel: () => model,
		};
	}

	it("runs real tool/provider dispatch, retains candidates, gates promotion and writes vault summaries", async () => {
		const tool = ManageSkillTool.createIf(session())!;
		const result = await tool.execute("evolve", { action: "evolve", name: "token-normalizer", evolution: input });
		expect(result.isError).toBe(false);
		const details = result.details as { runId: string; auditPath: string; vaultPath: string; state: string };
		expect(details.state).toBe("eligible");
		expect(await readManagedSkill("token-normalizer", agentDir)).toBeNull();
		const report = await loadEvolutionReport(agentDir, details.runId);
		expect(report.attempts).toHaveLength(4);
		expect(report.calls).toBe(11);
		expect(report.holdout[0].actual).toBe("PRIVATE-HOLDOUT");
		const note = await Bun.file(details.vaultPath).text();
		expect(note).toContain("learningStatus: eligible");
		expect(note).not.toContain("PRIVATE-HOLDOUT");
		const promoted = await tool.execute("promote", {
			action: "promote",
			name: "token-normalizer",
			runId: details.runId,
		});
		expect(promoted.isError).toBe(false);
		expect((await readManagedSkill("token-normalizer", agentDir))?.body.trim()).toBe(candidate.body);
		const promotion = promoted.details as { auditPath: string; vaultPath: string };
		expect(JSON.parse(await Bun.file(promotion.auditPath).text()).state).toBe("promoted");
		expect(await Bun.file(promotion.vaultPath).text()).toContain("learningStatus: promoted");
		await expect(
			tool.execute("again", { action: "promote", name: "token-normalizer", runId: details.runId }),
		).rejects.toThrow();
	});

	it("reports vault failure after promotion without rolling back or replaying the skill write", async () => {
		const run = await evolveSkill("partial-promotion", input, options());
		settings.override("autolearn.vaultPath", path.join(root, "unavailable-vault"));
		const result = await new ManageSkillTool(session()).execute("promote", {
			action: "promote",
			name: "partial-promotion",
			runId: run.report.id,
		});
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ state: "promoted", runId: run.report.id });
		expect((await readManagedSkill("partial-promotion", agentDir))?.body.trim()).toBe(candidate.body);
		await expect(promoteEvolution(agentDir, run.report.id, "partial-promotion")).rejects.toThrow();
	});

	it("rejects held-out regressions despite improved training and leaves the current skill unchanged", async () => {
		await writeManagedSkill({
			action: "create",
			name: "regression",
			description: "Existing behavior.",
			body: "Keep the existing held-out behavior.",
		});
		const before = await readManagedSkill("regression", agentDir);
		const result = await evolveSkill(
			"regression",
			input,
			options(async (system, user, signal) => {
				if (system.includes("propose one improved")) return solver(system, user, signal);
				if (user === "private-holdout") return system.includes(candidate.body) ? "regressed" : "PRIVATE-HOLDOUT";
				return system.includes(candidate.body) ? "ALPHA" : "wrong";
			}),
		);
		expect(result.report.state).toBe("rejected");
		await expect(promoteEvolution(agentDir, result.report.id, "regression")).rejects.toThrow("not eligible");
		expect(await readManagedSkill("regression", agentDir)).toEqual(before);
	});

	it("does not select a candidate that sacrifices a previously passing training case", async () => {
		const data = { ...input, training: [...input.training, { id: "stable", prompt: "stable", expected: "STABLE" }] };
		const result = await evolveSkill(
			"tradeoff",
			data,
			options(async (system, user, signal) => {
				if (system.includes("propose one improved")) return solver(system, user, signal);
				if (user === "stable") return system.includes(candidate.body) ? "lost" : "STABLE";
				return solver(system, user, signal);
			}),
		);
		expect(result.report.state).toBe("rejected");
		expect(await readManagedSkill("tradeoff", agentDir)).toBeNull();
	});

	it("rejects stale evaluated updates and wrong-name promotions without overwriting current content", async () => {
		await writeManagedSkill({
			action: "create",
			name: "stale",
			description: "Baseline.",
			body: "Return a fixed answer.",
		});
		const run = await evolveSkill("stale", input, options());
		await expect(promoteEvolution(agentDir, run.report.id, "another")).rejects.toThrow("different skill");
		await writeManagedSkill({
			action: "update",
			name: "stale",
			description: "Human edit.",
			body: "Keep this newer authored content in the managed file.",
		});
		await expect(promoteEvolution(agentDir, run.report.id, "stale")).rejects.toThrow("changed since evaluation");
		expect((await readManagedSkill("stale", agentDir))?.description).toBe("Human edit.");
	});

	it("retains a failed evaluation without installing malformed generated skills", async () => {
		const run = await evolveSkill(
			"malformed",
			input,
			options(async () => "not JSON"),
		);
		expect(run.report.state).toBe("failed");
		expect((await loadEvolutionReport(agentDir, run.report.id)).error).toBeTruthy();
		expect(await readManagedSkill("malformed", agentDir)).toBeNull();
		await expect(promoteEvolution(agentDir, run.report.id, "malformed")).rejects.toThrow("not eligible");
	});

	it("preflights missing/disjoint benchmark data and call budgets before making model calls", async () => {
		let calls = 0;
		const complete: EvolutionCompletion = async () => {
			calls++;
			return "wrong";
		};
		await expect(evolveSkill("empty", { ...input, holdout: [] }, options(complete))).rejects.toThrow("1–8 cases");
		await expect(evolveSkill("leak", { ...input, holdout: input.training }, options(complete))).rejects.toThrow(
			"distinct",
		);
		await expect(evolveSkill("budget", input, { ...options(complete), maxCalls: 2 })).rejects.toThrow("cap");
		expect(calls).toBe(0);
	});

	it("records cancellation without installing a candidate", async () => {
		const control = new AbortController();
		let calls = 0;
		const run = await evolveSkill("cancelled", input, {
			...options(async () => {
				calls++;
				control.abort(new Error("operator cancelled"));
				return Promise.withResolvers<string>().promise;
			}),
			signal: control.signal,
		});
		expect(run.report.state).toBe("failed");
		expect(run.report.error).toContain("cancelled");
		expect(calls).toBe(1);
		expect(await readManagedSkill("cancelled", agentDir)).toBeNull();
	});

	it("keeps evolution disabled unless explicitly opted in", async () => {
		settings.override("autolearn.evolution.enabled", false);
		await expect(
			new ManageSkillTool(session()).execute("off", { action: "evolve", name: "off", evolution: input }),
		).rejects.toThrow("requires autolearn.enabled");
	});

	it("writes a redacted vault-only lesson with valid metadata and no managed skill", async () => {
		const token = `ghp_${"A".repeat(36)}`;
		const tool = LearnTool.createIf(session());
		expect(tool).not.toBeNull();
		expect(tool!.approval({ memory: "lesson" })).toBe("write");
		const result = await tool!.execute("learn", {
			memory: `Never publish ${token}; retain only the reproducible lesson.`,
			context: "A failure taught us this.",
		});
		const details = result.details as { vaultPath: string };
		const text = await Bun.file(details.vaultPath).text();
		expect(text).not.toContain(token);
		expect(text).toContain("[REDACTED]");
		const parsed = parseFrontmatter(text, { source: details.vaultPath });
		expect(parsed.frontmatter.type).toBe("reference");
		expect(parsed.frontmatter.learningStatus).toBe("captured");
		expect(parsed.frontmatter.version).toBe(1);
		expect(details.vaultPath.startsWith(path.join(vault, "Skills", "Auto-Learn", "Lessons"))).toBe(true);
	});

	it("reports a missing vault without creating it or silently writing skills", async () => {
		const missing = path.join(root, "missing-vault");
		settings.override("autolearn.vaultPath", missing);
		const result = await new LearnTool(session()).execute("missing", {
			memory: "Useful lesson.",
			skill: { action: "create", name: "never-written", ...candidate },
		});
		expect(result.isError).toBe(true);
		expect(await Bun.file(missing).exists()).toBe(false);
		expect(await readManagedSkill("never-written", agentDir)).toBeNull();
	});

	it("does not overwrite existing learning notes when concurrent captures arrive", async () => {
		const [first, second] = await Promise.all([
			writeVaultLesson({ root: vault, cwd: root }, "First lesson."),
			writeVaultLesson({ root: vault, cwd: root }, "Second lesson."),
		]);
		expect(first).not.toBe(second);
		expect(await Bun.file(first).text()).toContain("First lesson.");
		expect(await Bun.file(second).text()).toContain("Second lesson.");
	});

	it("rejects vault link escapes and malformed run IDs", async () => {
		const outside = path.join(root, "outside");
		await fs.mkdir(outside);
		await fs.symlink(outside, path.join(vault, "Skills"), "junction");
		await expect(writeVaultLesson({ root: vault, cwd: root }, "Lesson.")).rejects.toThrow("unsafe link");
		await expect(loadEvolutionReport(agentDir, "../escape")).rejects.toThrow("run ID");
		expect(await fs.readdir(outside)).toEqual([]);
	});
});
