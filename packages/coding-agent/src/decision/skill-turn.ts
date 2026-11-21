/**
 * Per-turn skill preparation for a user request: the hint and skill bodies delivered at the
 * conversation tail with the request. The cacheable system prefix never changes per turn.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { buildSkillPromptMessage, type Skill, type SkillRediscoverySource } from "../extensibility/skills";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";
import type { DecisionJudgeDeps } from "./judge";
import type { DecisionRecord } from "./records";
import { resolveDecisionFeature } from "./resolve";
import { progressiveSkillProjection, skillDependencyClosure } from "./skill-projection";
import { isGreeting, type SkillSelection, selectSkills, skillHintText } from "./skills";
import { buildTaskContext } from "./task-context";

export const SKILL_HINT_MESSAGE_TYPE = "decision-skill-hint";

/** Bounds on optional bodies loaded per turn; an over-budget batch loads nothing rather than part of it. */
export const SKILL_AUTOLOAD_LIMITS = { bytes: 64 * 1024, skills: 32, deadlineMs: 1_000 } as const;

export interface SkillTurnInput {
	settings: Settings;
	skills: readonly Skill[];
	/** The request as the agent will act on it. */
	request: string;
	/** Transcript before the request. */
	history: readonly AgentMessage[];
	/** Whether the turn being prepared is still the one to deliver. */
	isCurrent: () => boolean;
	judge: DecisionJudgeDeps;
	source?: SkillRediscoverySource;
	onRecord: (record: DecisionRecord) => void;
}

/** Names of skill bodies already in `messages`. */
function loadedSkillNames(messages: readonly AgentMessage[]): Set<string> {
	const names = new Set<string>();
	for (const message of messages) {
		if (message.role === "custom" && message.customType === SKILL_PROMPT_MESSAGE_TYPE && isRecord(message.details)) {
			const name = message.details.name;
			if (typeof name === "string") names.add(name);
		}
	}
	return names;
}

/**
 * Bodies of `skills` not already in `history`, as non-user `skill-prompt` messages. All or none:
 * an unreadable file, the byte or count budget, the local deadline, or a superseded turn loads nothing.
 */
export async function loadSkillBodies(
	skills: readonly Skill[],
	history: readonly AgentMessage[],
	isCurrent: () => boolean,
	source?: SkillRediscoverySource,
): Promise<AgentMessage[]> {
	const loaded = loadedSkillNames(history);
	const pending = skills.filter(skill => !loaded.has(skill.name));
	if (pending.length === 0 || pending.length > SKILL_AUTOLOAD_LIMITS.skills) return [];
	const deadline = AbortSignal.timeout(SKILL_AUTOLOAD_LIMITS.deadlineMs);
	const timedOut = Promise.withResolvers<AgentMessage[]>();
	const onTimeout = () => timedOut.resolve([]);
	deadline.addEventListener("abort", onTimeout, { once: true });
	const load = async (): Promise<AgentMessage[]> => {
		const messages: AgentMessage[] = [];
		let bytes = 0;
		for (const skill of pending) {
			const built = await buildSkillPromptMessage(skill, { args: "" }, "autoload", source);
			if (deadline.aborted || !isCurrent()) return [];
			bytes += Buffer.byteLength(built.message);
			if (bytes > SKILL_AUTOLOAD_LIMITS.bytes) return [];
			messages.push({
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: built.message,
				details: { name: built.details.name, path: built.details.path },
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			});
		}
		return messages;
	};
	try {
		return await Promise.race([
			load().catch(error => {
				logger.warn("decision: skill bodies not loaded", {
					error: error instanceof Error ? error.message : String(error),
				});
				return [];
			}),
			timedOut.promise,
		]);
	} finally {
		deadline.removeEventListener("abort", onTimeout);
	}
}

function record(input: SkillTurnInput, selection: SkillSelection, started: number): DecisionRecord {
	const config = resolveDecisionFeature(input.settings, "skills");
	return {
		feature: "skills",
		mode: config.mode,
		backend: config.backend,
		reason: selection.reason,
		selected: selection.ids,
		candidates: selection.candidates,
		durationMs: Math.round(performance.now() - started),
		timestamp: Date.now(),
	};
}

/**
 * Messages to deliver with a user request, in order: mandatory progressive bodies, automatically
 * selected bodies, then the hint. `shadow` evaluates after returning and only records the result.
 */
export async function prepareSkillTurn(input: SkillTurnInput): Promise<AgentMessage[]> {
	const { settings, skills, request, history, isCurrent } = input;
	const config = resolveDecisionFeature(settings, "skills");
	if (config.mode === "off" || config.backend === "off" || skills.length === 0) return [];
	const projection = progressiveSkillProjection(settings, skills);
	const messages = projection ? await loadSkillBodies(projection.mandatory, history, isCurrent, input.source) : [];
	if (!isCurrent() || isGreeting(request)) return messages;
	const started = performance.now();
	const selectionInput = {
		skills,
		request,
		taskContext: buildTaskContext(request, history),
		backend: config.backend,
		deadline: Date.now() + config.deadlineMs,
	};
	if (config.mode === "shadow") {
		// Off the turn's critical path: the request is never delayed for a result nobody sees.
		void selectSkills(selectionInput, { ...input.judge, signal: undefined }).then(selection =>
			input.onRecord(record(input, selection, started)),
		);
		return messages;
	}
	const selection = await selectSkills(selectionInput, input.judge);
	if (!isCurrent()) return [];
	input.onRecord(record(input, selection, started));
	if (config.mode === "automatic" && selection.ids.length > 0) {
		const closure = skillDependencyClosure(skills, selection.ids);
		if (closure.diagnostics.length === 0) {
			messages.push(...(await loadSkillBodies(closure.skills, [...history, ...messages], isCurrent, input.source)));
			if (!isCurrent()) return [];
		}
	}
	const hint = skillHintText(selection, projection !== undefined);
	if (hint) {
		messages.push({
			role: "custom",
			customType: SKILL_HINT_MESSAGE_TYPE,
			content: hint,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
	}
	return messages;
}
