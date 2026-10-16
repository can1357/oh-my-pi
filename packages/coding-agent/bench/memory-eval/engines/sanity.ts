/**
 * Sanity engines: `oracle` ranks gold first, so recall@k must reach its ceiling `min(1, k / |unique gold|)` (k slots
 * hold at most k gold messages); `random` shuffles (recall must match chance).
 */
import type { EngineAdapter, EngineName, RecallHit, RememberItem } from "../engine";
import { mulberry32 } from "../stats";
import type { EvalQuestion } from "../types";

function sanityEngine(
	name: EngineName,
	order: (items: readonly RememberItem[], question: EvalQuestion) => readonly RememberItem[],
): EngineAdapter {
	let items: RememberItem[] = [];
	let baselineRssBytes = process.memoryUsage().rss;
	return {
		name,
		rssScope: "harness-process",
		describe: async () => ({ engine: name, kind: "sanity" }),
		open: async () => {
			items = [];
		},
		remember: async batch => {
			items.push(...batch);
			return batch.map(item => item.messageId);
		},
		vectorCount: async () => 1,
		sleep: async () => {},
		recall: async (question, k): Promise<RecallHit[]> =>
			order(items, question)
				.slice(0, k)
				.map(item => ({
					engineId: item.messageId,
					tier: "working",
					content: item.content,
					summaryOf: [],
				})),
		close: async () => {},
		dispose: async () => {},
		warmup: async () => {
			baselineRssBytes = process.memoryUsage().rss;
		},
		resources: async () => ({
			// `maxRSS` is in kilobytes on Linux.
			peakRssBytes: process.resourceUsage().maxRSS * 1024,
			baselineRssBytes,
		}),
	};
}

export function oracleEngine(): EngineAdapter {
	return sanityEngine("oracle", (items, question) => {
		const gold = new Set(question.goldMessageIds);
		const byId = new Map(items.map(item => [item.messageId, item]));
		const first = [...gold].flatMap(id => byId.get(id) ?? []);
		return [...first, ...items.filter(item => !gold.has(item.messageId))];
	});
}

export function randomEngine(): EngineAdapter {
	const rand = mulberry32(1);
	return sanityEngine("random", items => {
		const shuffled = [...items];
		for (let i = shuffled.length - 1; i > 0; i--) {
			const j = Math.floor(rand() * (i + 1));
			[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
		}
		return shuffled;
	});
}
