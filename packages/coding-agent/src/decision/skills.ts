/**
 * Skill selection: which loaded skills a turn's request needs. Local BM25 retrieval bounds the
 * candidates, then the native judge answers independent per-candidate Nouls in two stages (metadata
 * relevance behind two applicability gates, then fit against a short excerpt of each survivor).
 * The `deterministic` backend matches explicitly named skills only. Every threshold below is an
 * experimental policy constant, not a calibrated accuracy claim.
 */
import { type JsonValue, judgeQuestions, renderQuestion } from "@oh-my-pi/pi-ai";
import { escapeXmlText } from "@oh-my-pi/pi-utils";
import { resolveContainedPath } from "../discovery/contained-path";
import type { Skill } from "../extensibility/skills";
import questionFile from "../prompts/judge/skill-selection.json" with { type: "json" };
import taskContextNote from "../prompts/system/decision-task-context.md" with { type: "text" };
import { askDecisionJudge, type DecisionJudgeDeps } from "./judge";
import { lexicalRank } from "./lexical";
import type { DecisionBackend } from "./resolve";
import { skillDependencyClosure } from "./skill-projection";
import type { TaskContext } from "./task-context";

export const SKILL_POLICY = {
	/** Most candidates one judgment evaluates. */
	maxCandidates: 64,
	/** Query terms in more than this share of skills do not count as matches. */
	commonTermFraction: 0.25,
	/** Most ambient skills selected per turn (explicit names and dependencies come on top). */
	topK: 3,
	excerptChars: 700,
	/** Both applicability gates must reach this probability before any candidate is kept. */
	gateThreshold: 0.35,
	/** Relevance and fit probability a candidate needs. */
	keepThreshold: 0.7,
	/** Lexical matches listed, unverified, when the judge cannot answer. */
	unverifiedShortlist: 5,
} as const;

const QUESTIONS = judgeQuestions(questionFile);

/** Why a selection ended as it did; the status record and tests read it. */
export type SkillSelectionReason =
	| "selected"
	| "explicit"
	| "no_candidates"
	| "gated"
	| "none_relevant"
	| "none_fit"
	| "too_many"
	| "excerpt_unavailable"
	| "judge_unavailable"
	| "cancelled";

export interface SkillSelection {
	/** Selected and explicitly named skills, with their `requiresSkills` closure. */
	ids: string[];
	/** Local lexical matches offered only when the judge could not answer; never autoloaded. */
	unverified: Skill[];
	/** How many candidates retrieval passed to the judge. */
	candidates: number;
	reason: SkillSelectionReason;
}

export interface SkillSelectionInput {
	skills: readonly Skill[];
	request: string;
	taskContext?: TaskContext;
	backend: Exclude<DecisionBackend, "off">;
	/** Epoch ms shared by every judge call of this selection. */
	deadline: number;
}

/** Content digest of the catalogue's metadata; changes whenever a listing or search could. */
export function skillCatalogueDigest(skills: readonly Skill[]): string {
	return Bun.hash(
		JSON.stringify(skills.map(skill => [skill.name, skill.description, skill.hide === true, skill.filePath])),
	).toString(16);
}

function ambient(skills: readonly Skill[]): Skill[] {
	return skills.filter(skill => skill.hide !== true);
}

/** Non-hidden skills matching `query` lexically, best first; every non-hidden skill by name when blank. */
export function searchSkills(skills: readonly Skill[], query: string): Skill[] {
	const visible = ambient(skills);
	if (!query.trim()) return visible.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return lexicalRank(
		query,
		visible.map(skill => `${skill.name} ${skill.description}`),
	)
		.filter(item => item.score > 0)
		.map(item => visible[item.index]!);
}

/** Lexical candidates for `text`, ignoring explicit skill references and terms common to the catalogue. */
function retrieve(visible: readonly Skill[], text: string): Skill[] {
	const query = text.replace(/(?:\/skill:|skill:\/\/)\S+/gu, " ");
	return lexicalRank(
		query,
		visible.map(skill => `${skill.name} ${skill.description}`),
		{ maxDocumentFrequency: Math.max(5, Math.floor(visible.length * SKILL_POLICY.commonTermFraction)) },
	)
		.filter(item => item.score > 0)
		.slice(0, SKILL_POLICY.maxCandidates)
		.map(item => visible[item.index]!);
}

/** Candidates for the request, interleaved with candidates for its follow-up context. */
export function retrieveSkillCandidates(skills: readonly Skill[], request: string, taskContext?: TaskContext): Skill[] {
	const visible = ambient(skills);
	const current = retrieve(visible, request);
	if (!taskContext) return current;
	const earlier = retrieve(visible, taskContext.messages.map(message => message.text).join("\n"));
	const result = new Set<Skill>();
	for (let index = 0; index < Math.max(current.length, earlier.length); index++) {
		for (const skill of [current[index], earlier[index]]) {
			if (skill && result.size < SKILL_POLICY.maxCandidates) result.add(skill);
		}
	}
	return [...result];
}

/** Whether `request` is a bare greeting or thanks, which never needs a skill. */
export function isGreeting(request: string): boolean {
	return /^(?:hi|hello|hey|thanks|thank you|good morning|good evening)[.!?\s]*$/iu.test(request.trim());
}

function normalizeName(value: string): string {
	return value
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/** Skills `request` names as `/skill:<name>` or `skill://<name>`. */
function explicitNames(skills: readonly Skill[], request: string): string[] {
	const named = new Set(
		Array.from(request.matchAll(/(?:\/skill:|skill:\/\/)([^\s/?#<>`"'(),]+)/g), match =>
			match[1]!.replace(/[.!;]+$/, ""),
		),
	);
	return skills.filter(skill => named.has(skill.name)).map(skill => skill.name);
}

/** Non-hidden skills whose normalized name appears as words in the request ("the release notes skill"). */
function mentionedNames(skills: readonly Skill[], request: string): string[] {
	const text = ` ${normalizeName(request)} `;
	return ambient(skills)
		.filter(skill => text.includes(` ${normalizeName(skill.name)} `))
		.map(skill => skill.name);
}

/** `ids` with their dependencies; an invalid dependency graph never adds a dependency. */
function withDependencies(skills: readonly Skill[], ids: readonly string[]): string[] {
	if (ids.length === 0) return [];
	const closure = skillDependencyClosure(skills, ids);
	return closure.diagnostics.length > 0 ? [...new Set(ids)] : closure.skills.map(skill => skill.name);
}

/** First {@link SKILL_POLICY.excerptChars} characters of a skill's body, frontmatter stripped. */
async function readExcerpt(skill: Skill): Promise<string> {
	let filePath = skill.filePath;
	if (skill.containRoot) {
		const contained = await resolveContainedPath(skill.containRoot, filePath);
		if (contained.status !== "ok") throw new Error("skill excerpt is outside its plugin root");
		filePath = contained.realPath;
	}
	// A bounded prefix: a judge never needs the whole body.
	const raw = await Bun.file(filePath)
		.slice(0, 64 * 1024)
		.text();
	const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
	return Array.from(body).slice(0, SKILL_POLICY.excerptChars).join("");
}

/** The judged state: `request` first, then stage fields, then follow-up context when present. */
export function decisionState(
	request: string,
	fields: Record<string, JsonValue>,
	taskContext: TaskContext | undefined,
): Record<string, JsonValue> {
	if (!taskContext) return { request, ...fields };
	return {
		request,
		...fields,
		taskContext: taskContext.messages.map(({ source, text, truncated }) => ({ source, text, truncated })),
		taskContextNote: taskContextNote.trim(),
	};
}

/** Select skills for one request; never throws. */
export async function selectSkills(input: SkillSelectionInput, deps: DecisionJudgeDeps): Promise<SkillSelection> {
	const { skills, request, backend } = input;
	const explicit = explicitNames(skills, request);
	const finish = (
		reason: SkillSelectionReason,
		selected: readonly string[] = [],
		candidates = 0,
		unverified: readonly Skill[] = [],
	): SkillSelection => {
		if (deps.signal?.aborted) return { ids: [], unverified: [], candidates, reason: "cancelled" };
		const ids = withDependencies(skills, [...explicit, ...selected.slice(0, SKILL_POLICY.topK)]);
		return {
			ids,
			unverified: unverified.filter(skill => !ids.includes(skill.name)).slice(0, SKILL_POLICY.unverifiedShortlist),
			candidates,
			reason: reason === "no_candidates" && explicit.length > 0 ? "explicit" : reason,
		};
	};
	if (backend === "deterministic") {
		const mentioned = mentionedNames(skills, request).filter(name => !explicit.includes(name));
		return finish(mentioned.length > 0 ? "selected" : "no_candidates", mentioned, mentioned.length);
	}
	const candidates = retrieveSkillCandidates(skills, request, input.taskContext).filter(
		skill => !explicit.includes(skill.name),
	);
	if (candidates.length === 0) return finish("no_candidates");

	// Stage 1: descriptions appear once, in `candidates`; each relevance Noul is independent.
	const broadQuestions: Record<string, (typeof QUESTIONS)[keyof typeof QUESTIONS]> = {
		actsOnSystem: QUESTIONS.actsOnSystem,
		procedureUseful: QUESTIONS.procedureUseful,
	};
	candidates.forEach((_, index) => {
		broadQuestions[`r${index}`] = renderQuestion(QUESTIONS.relevance, { index });
	});
	const broad = await askDecisionJudge(
		"decision-skills",
		{
			state: decisionState(
				request,
				{ candidates: candidates.map(skill => ({ name: skill.name, description: skill.description })) },
				input.taskContext,
			),
			questions: broadQuestions,
		},
		deps,
		input.deadline,
	);
	if (broad.status === "unavailable") {
		return finish(
			broad.reason === "cancelled" ? "cancelled" : "judge_unavailable",
			[],
			candidates.length,
			candidates,
		);
	}
	const answers = broad.result.answers;
	const gate = (id: string) => {
		const answer = answers[id];
		return answer?.type === "noul" && answer.noul >= SKILL_POLICY.gateThreshold;
	};
	if (!gate("actsOnSystem") || !gate("procedureUseful")) return finish("gated", [], candidates.length);
	const relevant = candidates
		.flatMap((skill, index) => {
			const answer = answers[`r${index}`];
			return answer?.type === "noul" && answer.noul >= SKILL_POLICY.keepThreshold
				? [{ skill, score: answer.noul }]
				: [];
		})
		.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
		.slice(0, SKILL_POLICY.topK)
		.map(item => item.skill);
	if (relevant.length === 0) return finish("none_relevant", [], candidates.length);

	// Stage 2: fit against each survivor's own words, sharing the remaining deadline.
	let excerpts: string[];
	try {
		excerpts = await Promise.all(relevant.map(readExcerpt));
	} catch {
		return finish("excerpt_unavailable", [], candidates.length);
	}
	const fitQuestions: Record<string, (typeof QUESTIONS)["fit"]> = {};
	relevant.forEach((_, index) => {
		fitQuestions[`f${index}`] = renderQuestion(QUESTIONS.fit, { index });
	});
	const fit = await askDecisionJudge(
		"decision-skills",
		{
			state: decisionState(
				request,
				{
					candidates: relevant.map(skill => ({ name: skill.name, description: skill.description })),
					excerpts,
				},
				input.taskContext,
			),
			questions: fitQuestions,
		},
		deps,
		input.deadline,
	);
	if (fit.status === "unavailable") {
		return finish(fit.reason === "cancelled" ? "cancelled" : "judge_unavailable", [], candidates.length, relevant);
	}
	const fitting = relevant.filter((_, index) => {
		const answer = fit.result.answers[`f${index}`];
		return answer?.type === "noul" && answer.noul >= SKILL_POLICY.keepThreshold;
	});
	return finish(
		fitting.length > 0 ? "selected" : "none_fit",
		fitting.map(skill => skill.name),
		candidates.length,
	);
}

/** The tail hint for a selection; `undefined` when there is nothing to say. */
export function skillHintText(selection: SkillSelection, progressive: boolean): string | undefined {
	// The roster already lists every skill; the unverified shortlist only replaces what progressive omits.
	const shortlist = progressive ? selection.unverified : [];
	const lines: string[] = [];
	if (selection.ids.length > 0) {
		lines.push(`Relevant: ${selection.ids.map(escapeXmlText).join(", ")}. Ignore if it does not fit.`);
	}
	if (shortlist.length > 0) {
		lines.push(
			"Skill judge unavailable; unverified local matches (read skill://<name> before following one that fits, ignore the rest, or search skill://?q=<query>):",
			...shortlist.map(skill => `- ${escapeXmlText(skill.name)}: ${escapeXmlText(skill.description)}`),
		);
	}
	if (lines.length === 0) {
		if (!progressive) return undefined;
		lines.push("No reliable shortlist; search skill://?q=<query> or read skill:// to discover relevant procedures.");
	}
	return `<skill_relevance>\n${lines.join("\n")}\n</skill_relevance>`;
}
