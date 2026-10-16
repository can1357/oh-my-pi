import * as path from "node:path";
import type {
	DatasetName,
	EvalCase,
	EvalMessage,
	EvalQuestion,
	ExcludedQuestion,
	LoadResult,
	UpstreamCompatConversation,
} from "./types";

interface BeamMessage {
	id: number;
	role: string;
	content: string;
}

interface BeamConversation {
	conversationId: string;
	chat: BeamMessage[][];
	probingQuestions: Record<string, Record<string, unknown>[]>;
}

interface LmeTurn {
	role: string;
	content: string;
	has_answer?: boolean;
}

interface LmeQuestion {
	question_id: string;
	question_type: string;
	question: string;
	haystack_session_ids: string[];
	haystack_sessions: LmeTurn[][];
}

const UPSTREAM_MAX_QUESTIONS = 100;

function asRole(role: string): EvalMessage["role"] {
	if (role !== "user" && role !== "assistant") throw new Error(`Unexpected message role: ${role}`);
	return role;
}

/** Raw gold id strings of a BEAM question: a list, or all values of a dict; null/absent gives none. */
function beamGold(sourceChatIds: unknown): string[] {
	const values: unknown[] = Array.isArray(sourceChatIds)
		? sourceChatIds
		: sourceChatIds !== null && typeof sourceChatIds === "object"
			? Object.values(sourceChatIds).flatMap(v => (Array.isArray(v) ? v : [v]))
			: [];
	return values.filter(v => v !== null && v !== undefined).map(String);
}

/** The runner remembers only these messages, so a blank one can never be recalled. */
export const isRememberable = (message: EvalMessage): boolean => message.content.trim() !== "";

async function readBeam(dataDir: string, name: "beam-100k" | "beam-500k"): Promise<BeamConversation[]> {
	return (await Bun.file(path.join(dataDir, `${name}.json`)).json()) as BeamConversation[];
}

function loadBeam(name: "beam-100k" | "beam-500k", conversations: BeamConversation[]): LoadResult {
	const cases: EvalCase[] = [];
	const excluded: ExcludedQuestion[] = [];
	for (const conv of conversations) {
		const messages: EvalMessage[] = [];
		const sessionOf = new Map<string, string>();
		const blank = new Set<string>();
		conv.chat.forEach((block, blockIndex) => {
			const sessionId = `beam-${conv.conversationId}-${blockIndex}`;
			for (const m of block) {
				const messageId = String(m.id);
				sessionOf.set(messageId, sessionId);
				const message: EvalMessage = { messageId, sessionId, role: asRole(m.role), content: m.content };
				if (!isRememberable(message)) blank.add(messageId);
				messages.push(message);
			}
		});
		const questions: EvalQuestion[] = [];
		for (const [ability, list] of Object.entries(conv.probingQuestions)) {
			list.forEach((q, i) => {
				const questionId = `${conv.conversationId}:${ability}:${i}`;
				// Some entries are comma-joined strings such as "136,138".
				const listedGold = beamGold(q.source_chat_ids)
					.flatMap(s => s.split(","))
					.map(s => s.trim())
					.filter(s => s !== "");
				if (listedGold.length === 0) {
					excluded.push({ questionId, reason: "no-gold" });
					return;
				}
				const dangling = listedGold.find(id => !sessionOf.has(id));
				if (dangling !== undefined) {
					throw new Error(
						`${name} case ${conv.conversationId} question ${questionId}: gold id "${dangling}" is not in the conversation`,
					);
				}
				const goldMessageIds = listedGold.filter(id => !blank.has(id));
				if (goldMessageIds.length === 0) {
					excluded.push({ questionId, reason: "blank-gold" });
					return;
				}
				const goldSessionIds = new Set<string>();
				for (const id of goldMessageIds) {
					const sessionId = sessionOf.get(id);
					if (sessionId !== undefined) goldSessionIds.add(sessionId);
				}
				questions.push({
					questionId,
					text: String(q.question ?? ""),
					category: ability,
					goldMessageIds,
					goldSessionIds: [...goldSessionIds],
				});
			});
		}
		cases.push({ caseId: conv.conversationId, dataset: name, messages, questions });
	}
	return { cases, excluded };
}

function loadLme(dataset: DatasetName, raw: LmeQuestion[]): LoadResult {
	const cases: EvalCase[] = [];
	const excluded: ExcludedQuestion[] = [];
	for (const q of raw) {
		if (q.question_id.endsWith("_abs")) {
			excluded.push({ questionId: q.question_id, reason: "abstention" });
			continue;
		}
		const messages: EvalMessage[] = [];
		q.haystack_sessions.forEach((session, s) => {
			const sessionId = q.haystack_session_ids[s];
			session.forEach((turn, t) => {
				if (turn.role !== "user") return;
				let messageId = `${sessionId}_${t + 1}`;
				if (sessionId.includes("answer") && !turn.has_answer) messageId = messageId.replaceAll("answer", "noans");
				messages.push({ messageId, sessionId, role: "user", content: turn.content });
			});
		});
		const goldMessageIds = messages.map(m => m.messageId).filter(id => id.includes("answer"));
		if (goldMessageIds.length === 0) {
			excluded.push({ questionId: q.question_id, reason: "no-gold" });
			continue;
		}
		const goldSessionIds = [...new Set(goldMessageIds.map(id => id.slice(0, id.lastIndexOf("_"))))];
		cases.push({
			caseId: q.question_id,
			dataset,
			messages,
			questions: [
				{
					questionId: q.question_id,
					text: q.question,
					category: q.question_type,
					goldMessageIds,
					goldSessionIds,
				},
			],
		});
	}
	return { cases, excluded };
}

export async function loadDataset(name: DatasetName, dataDir: string): Promise<LoadResult> {
	if (name === "beam-100k" || name === "beam-500k") return loadBeam(name, await readBeam(dataDir, name));
	const raw = (await Bun.file(path.join(dataDir, "lme-s.json")).json()) as LmeQuestion[];
	if (name === "lme-s") return loadLme(name, raw);
	const subset = new Set((await Bun.file(path.join(import.meta.dir, "lme-dev-subset.json")).json()) as string[]);
	return loadLme(
		name,
		raw.filter(q => subset.has(q.question_id)),
	);
}

/** Mirrors upstream Mnemosyne `load_beam_data`: gold comes from dict-shaped `source_chat_ids` only. */
export async function loadBeamUpstreamCompat(
	dataDir: string,
	maxConversations: number,
): Promise<UpstreamCompatConversation[]> {
	const conversations = (await readBeam(dataDir, "beam-100k")).slice(0, maxConversations);
	return conversations.map(conv => {
		const messages = conv.chat.flatMap(block => block.map(m => m.content));
		const questions: UpstreamCompatConversation["questions"] = [];
		for (const list of Object.values(conv.probingQuestions)) {
			for (const q of list) {
				const ids = q.source_chat_ids;
				const goldIndices =
					ids !== null && typeof ids === "object" && !Array.isArray(ids)
						? beamGold(ids)
								.filter(s => /^\d+$/.test(s))
								.map(Number)
						: [];
				questions.push({ text: String(q.question ?? ""), goldIndices });
			}
		}
		return { messages, questions: questions.slice(0, UPSTREAM_MAX_QUESTIONS) };
	});
}
