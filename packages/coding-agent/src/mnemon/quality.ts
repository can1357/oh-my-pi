export type MnemonRecallMode = "silent" | "explicit";

export interface MnemonRecallRow {
	id?: string;
	content?: string;
	category?: string;
	importance?: number;
	confidence?: string;
	score?: number;
	superseded?: boolean;
}

export interface MnemonRecallPayload {
	results: MnemonRecallRow[];
	hint?: string;
}

const LOW_SCORE = 0.25;
const HIGH_SCORE = 0.6;
const TOOL_RECALL_MAX = 50;

export function parseMnemonRecallPayload(payload: unknown): MnemonRecallPayload {
	if (Array.isArray(payload)) return { results: payload as MnemonRecallRow[] };
	if (payload && typeof payload === "object" && "results" in payload) {
		const results = Array.isArray(payload.results) ? (payload.results as MnemonRecallRow[]) : [];
		const hint =
			"hint" in payload && typeof payload.hint === "string" && payload.hint.trim() ? payload.hint : undefined;
		return { results, hint };
	}
	return { results: [] };
}

function scoreDecision(row: MnemonRecallRow, mode: MnemonRecallMode) {
	if (row.superseded) return { action: "drop" as const, tier: "low" as const };
	const score = row.score;
	if (score === undefined || score === null) {
		return { action: mode === "silent" ? ("drop" as const) : ("keep" as const), tier: "unknown" as const };
	}
	if (!Number.isFinite(score) || score <= 0) return { action: "drop" as const, tier: "low" as const };
	if (score > 1) {
		return { action: mode === "silent" ? ("drop" as const) : ("keep" as const), tier: "unknown" as const };
	}
	if (score < LOW_SCORE) {
		return { action: mode === "silent" ? ("drop" as const) : ("keep" as const), tier: "low" as const };
	}
	if (score < HIGH_SCORE) {
		return { action: mode === "silent" ? ("drop" as const) : ("keep" as const), tier: "medium" as const };
	}
	return { action: "keep" as const, tier: "high" as const };
}

export function applyMnemonRecallQuality(
	results: MnemonRecallRow[],
	options: { limit?: number; mode?: MnemonRecallMode },
) {
	const mode = options.mode ?? "explicit";
	const num = Number(options.limit);
	const requested = Math.max(1, Math.min(TOOL_RECALL_MAX, Number.isFinite(num) ? Math.round(num) : 10));
	const evaluated = results.map(row => ({ row, decision: scoreDecision(row, mode) }));
	const kept = evaluated.filter(entry => entry.decision.action === "keep");
	const selected =
		mode === "silent"
			? kept.filter(entry => entry.decision.tier === "high").slice(0, requested)
			: [
					...kept.filter(entry => entry.decision.tier !== "low"),
					...kept.filter(entry => entry.decision.tier === "low"),
				].slice(0, requested);
	return {
		results: selected.map(entry => entry.row),
		dropped: evaluated.length - selected.length,
	};
}

export function formatMnemonSilentRecall(results: MnemonRecallRow[]) {
	return results
		.map(row => {
			const body = String(row.content ?? "")
				.trim()
				.replace(/\s+/g, " ");
			const clipped = body.length > 320 ? `${body.slice(0, 317)}…` : body;
			const confidence = row.confidence ? `, ${row.confidence}` : "";
			return `- (${row.category ?? "general"}, imp ${row.importance ?? "?"}${confidence}) ${clipped}`;
		})
		.join("\n");
}

const STOPWORDS: Record<string, true> = {
	the: true,
	and: true,
	for: true,
	that: true,
	this: true,
	with: true,
	from: true,
	have: true,
	what: true,
	when: true,
	how: true,
	about: true,
	should: true,
	would: true,
	could: true,
	your: true,
	you: true,
	are: true,
	was: true,
	were: true,
	feel: true,
	else: true,
	anything: true,
	before: true,
	after: true,
};

export function focusMnemonQuery(text: string, max = 160) {
	const cleaned = text
		.replace(/<system-directive\b[\s\S]*?<\/system-directive>/gi, " ")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const tokens = cleaned
		.split(/[^A-Za-z0-9_./:+#-]+/)
		.filter(token => token.length >= 3 && !STOPWORDS[token.toLowerCase()]);
	const unique: string[] = [];
	const seen: Record<string, true> = {};
	for (const token of tokens) {
		const key = token.toLowerCase();
		if (seen[key]) continue;
		seen[key] = true;
		unique.push(token);
		if (unique.join(" ").length >= max) break;
	}
	const query = unique.join(" ").trim();
	return (query.length >= 8 ? query : cleaned).slice(0, max);
}
