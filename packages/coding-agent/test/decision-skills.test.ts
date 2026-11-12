import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	progressiveSkillProjection,
	skillDependencyClosure,
} from "@oh-my-pi/pi-coding-agent/decision/skill-projection";
import { prepareSkillTurn, SKILL_HINT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/decision/skill-turn";
import { selectSkills, skillHintText } from "@oh-my-pi/pi-coding-agent/decision/skills";
import { loadSkillsFromDir, type Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";

const JEV = {
	id: "jev-preview",
	name: "JEV Preview",
	api: "typesafe",
	provider: "typesafe",
	baseUrl: "https://judge.example.test/",
	kind: "judge",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as Model<Api>;

let root: string;
let skills: Skill[];

async function writeSkill(name: string, description: string, frontmatter = ""): Promise<Skill> {
	const dir = path.join(root, name);
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, "SKILL.md");
	await Bun.write(
		filePath,
		`---\nname: ${name}\ndescription: ${description}\n${frontmatter}---\n# ${name}\nProcedure body for ${name}.\n`,
	);
	return { name, description, filePath, baseDir: dir, source: "test" };
}

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-skills-"));
	skills = [
		await writeSkill("postgres-migrations", "Write and verify postgres schema migrations"),
		await writeSkill("release-notes", "Draft release notes from merged pull requests"),
		await writeSkill("terraform-plan", "Review terraform plan output for infrastructure drift"),
	];
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

function judgeDeps(config: Record<string, unknown> = {}) {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("typesafe", "ts-key");
	const registry = new ModelRegistry(authStorage, "/nonexistent/decision-skills-models.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue([JEV]);
	const settings = Settings.isolated({ modelRoles: { judge: "typesafe/jev-preview" }, ...config });
	return { settings, registry };
}

interface JudgeBody {
	state: { candidates: { name: string }[] };
	questions: Record<string, unknown>;
}

/** Serve System One Noul answers: `relevance`/`fit` by candidate name, gates at `gate`. */
function serveJudge(scores: { relevance: Record<string, number>; fit: Record<string, number>; gate?: number }) {
	const bodies: JudgeBody[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(async (_url, init) => {
			const body = JSON.parse(String(init?.body)) as JudgeBody;
			bodies.push(body);
			const answers: Record<string, { type: "noul"; noul: number }> = {};
			for (const id of Object.keys(body.questions)) {
				const index = Number(id.slice(1));
				const name = body.state.candidates[index]?.name ?? "";
				const noul =
					id === "actsOnSystem" || id === "procedureUseful"
						? (scores.gate ?? 0.9)
						: id.startsWith("r")
							? (scores.relevance[name] ?? 0.05)
							: (scores.fit[name] ?? 0.05);
				answers[id] = { type: "noul", noul };
			}
			return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 10, output_tokens: 1 } });
		}),
	);
	return bodies;
}

const deadline = () => Date.now() + 5_000;

describe("selectSkills", () => {
	it("deterministic backend selects only skills the request names", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const selection = await selectSkills(
			{ skills, request: "use the release notes skill for v2", backend: "deterministic", deadline: deadline() },
			judgeDeps(),
		);
		expect(selection.ids).toEqual(["release-notes"]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("keeps a candidate only when both relevance and fit clear the threshold", async () => {
		const bodies = serveJudge({
			relevance: { "postgres-migrations": 0.92, "terraform-plan": 0.85 },
			fit: { "postgres-migrations": 0.9, "terraform-plan": 0.3 },
		});
		const selection = await selectSkills(
			{
				skills,
				request: "add a postgres migration and check the terraform plan",
				backend: "judge",
				deadline: deadline(),
			},
			judgeDeps(),
		);
		expect(selection).toMatchObject({ ids: ["postgres-migrations"], reason: "selected" });
		// Stage two judges only the relevant survivors, with excerpts of their bodies.
		expect(bodies).toHaveLength(2);
		expect(bodies[1]!.state.candidates.map(candidate => candidate.name).sort()).toEqual([
			"postgres-migrations",
			"terraform-plan",
		]);
		expect(JSON.stringify(bodies[1]!.state)).toContain("Procedure body for postgres-migrations.");
	});

	it("selects nothing when the request does not call for a procedure", async () => {
		serveJudge({ relevance: { "postgres-migrations": 0.95 }, fit: { "postgres-migrations": 0.95 }, gate: 0.1 });
		const selection = await selectSkills(
			{ skills, request: "what are postgres migrations, in one sentence", backend: "judge", deadline: deadline() },
			judgeDeps(),
		);
		expect(selection).toMatchObject({ ids: [], reason: "gated" });
	});

	it("offers the lexical shortlist as unverified when the judge fails", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async () => new Response("down", { status: 503 })),
		);
		const selection = await selectSkills(
			{ skills, request: "review the terraform plan drift", backend: "judge", deadline: deadline() },
			judgeDeps(),
		);
		expect(selection.reason).toBe("judge_unavailable");
		expect(selection.ids).toEqual([]);
		expect(selection.unverified.map(skill => skill.name)).toContain("terraform-plan");
		// The roster already lists every skill; only the progressive catalogue repeats the shortlist.
		expect(skillHintText(selection, false)).toBeUndefined();
		expect(skillHintText(selection, true)).toContain("- terraform-plan:");
	});

	it("pins explicitly invoked skills and their declared dependencies", async () => {
		const withDeps = [
			...skills.filter(skill => skill.name !== "release-notes"),
			{ ...skills.find(skill => skill.name === "release-notes")!, requiresSkills: ["postgres-migrations"] },
		];
		const selection = await selectSkills(
			{ skills: withDeps, request: "/skill:release-notes for 2.1", backend: "deterministic", deadline: deadline() },
			judgeDeps(),
		);
		expect(selection.ids.sort()).toEqual(["postgres-migrations", "release-notes"]);
	});
});

describe("prepareSkillTurn", () => {
	const turn = (settings: Settings, registry: ModelRegistry, request: string, history: AgentMessage[] = []) =>
		prepareSkillTurn({
			settings,
			skills,
			request,
			history,
			isCurrent: () => true,
			judge: { settings, registry },
			onRecord: () => {},
		});

	it("does nothing until both the backend and the feature mode are set", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const { settings, registry } = judgeDeps({ "decision.skills.mode": "automatic" });
		expect(await turn(settings, registry, "add a postgres migration")).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("suggest mode delivers names only; automatic also delivers the selected body once", async () => {
		serveJudge({ relevance: { "postgres-migrations": 0.9 }, fit: { "postgres-migrations": 0.9 } });
		const suggest = judgeDeps({ "decision.backend": "judge", "decision.skills.mode": "suggest" });
		const suggested = await turn(suggest.settings, suggest.registry, "add a postgres migration");
		expect(suggested.map(message => message.role === "custom" && message.customType)).toEqual([
			SKILL_HINT_MESSAGE_TYPE,
		]);

		const auto = judgeDeps({ "decision.backend": "judge", "decision.skills.mode": "automatic" });
		const loaded = await turn(auto.settings, auto.registry, "add a postgres migration");
		const body = loaded.find(
			message => message.role === "custom" && message.customType === SKILL_PROMPT_MESSAGE_TYPE,
		);
		expect(body?.role === "custom" && String(body.content)).toContain("Procedure body for postgres-migrations.");

		// Already in context: only the hint is delivered again.
		const again = await turn(auto.settings, auto.registry, "add a postgres migration", loaded);
		expect(again.map(message => message.role === "custom" && message.customType)).toEqual([SKILL_HINT_MESSAGE_TYPE]);
	});
});

describe("progressive skill catalogue", () => {
	const progressive = {
		"decision.backend": "judge",
		"decision.skills.mode": "suggest",
		"decision.skills.variant": "progressive",
	};

	it("lists only always-apply skills and their dependencies", async () => {
		const graph: Skill[] = [
			{ ...skills[0]!, alwaysApply: true, requiresSkills: ["terraform-plan"] },
			skills[1]!,
			skills[2]!,
		];
		const settings = Settings.isolated(progressive);
		expect(progressiveSkillProjection(settings, graph)?.mandatory.map(skill => skill.name)).toEqual([
			"postgres-migrations",
			"terraform-plan",
		]);
		const prompt = await buildSystemPrompt({
			cwd: root,
			contextFiles: [],
			rules: [],
			toolNames: ["read"],
			skills: graph,
			progressiveSkills: loaded => progressiveSkillProjection(settings, loaded)?.mandatory,
		});
		const text = prompt.systemPrompt.join("\n");
		expect(text).toContain("terraform-plan");
		expect(text).not.toContain("release-notes");
		expect(text).toContain("skill://?q=<query>");
	});

	it("falls back to the full roster when a dependency is missing or cyclic", () => {
		const settings = Settings.isolated(progressive);
		const cyclic: Skill[] = [
			{ ...skills[0]!, alwaysApply: true, requiresSkills: ["release-notes"] },
			{ ...skills[1]!, requiresSkills: ["postgres-migrations"] },
		];
		expect(skillDependencyClosure(cyclic, ["postgres-migrations"]).diagnostics[0]).toContain("cycle");
		expect(progressiveSkillProjection(settings, cyclic)).toBeUndefined();
		const missing: Skill[] = [{ ...skills[0]!, alwaysApply: true, requiresSkills: ["absent"] }];
		expect(progressiveSkillProjection(settings, missing)).toBeUndefined();
	});

	it("reads alwaysApply and requires-skills from SKILL.md frontmatter", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-skill-frontmatter-"));
		try {
			await fs.mkdir(path.join(dir, "policy"));
			await Bun.write(
				path.join(dir, "policy", "SKILL.md"),
				"---\nname: policy\ndescription: House policy\nalwaysApply: true\nrequires-skills: [style]\n---\nBody\n",
			);
			const { skills: loaded } = await loadSkillsFromDir({ dir, source: "test" });
			expect(loaded[0]).toMatchObject({ name: "policy", alwaysApply: true, requiresSkills: ["style"] });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("searches and pages the catalogue through skill://", async () => {
		const handler = new SkillProtocolHandler();
		const search = JSON.parse(
			(await handler.resolve(parseInternalUrl("skill://?q=terraform%20drift"), { skills })).content,
		);
		expect(search.skills.map((skill: Skill) => skill.name)).toEqual(["terraform-plan"]);

		const first = JSON.parse((await handler.resolve(parseInternalUrl("skill://?limit=2"), { skills })).content);
		expect(first).toMatchObject({ total: 3, coverageComplete: false });
		const second = JSON.parse(
			(await handler.resolve(parseInternalUrl(`skill://?limit=2&cursor=${first.nextCursor}`), { skills })).content,
		);
		expect(second).toMatchObject({ coverageComplete: true, nextCursor: null });
		expect([...first.skills, ...second.skills].map((skill: Skill) => skill.name)).toEqual(skills.map(s => s.name));

		// A cursor never pages a catalogue that changed under it.
		await expect(
			handler.resolve(parseInternalUrl(`skill://?limit=2&cursor=${first.nextCursor}`), { skills: skills.slice(1) }),
		).rejects.toThrow(/stale skill catalogue cursor/);
	});
});
