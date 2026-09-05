import { getMessageRows, getUserMessageRows } from "./db";
import type { MessageStats, ModelEconomics, TaskLedgerRecord, UserMessageLink, UserMessageStats } from "./types";

/**
 * Resolve each assistant request to its task anchor, returned ALIGNED 1:1
 * with the input messages (`undefined` for orphans with no preceding user
 * message). Callers index the result against the same input array — the
 * alignment is constructed here, never assumed across independently-sized
 * arrays (the parser emits a stat for every assistant but a link only when
 * parentId+model/provider exist, so raw link arrays are NOT 1:1).
 *
 * Anchor = latest user message in the same sessionFile with
 * `user.timestamp <= message.timestamp`. Tool-result parents never appear:
 * grouping keys on confirmed user rows, never on parent chains.
 */
function resolveAnchors(messages: MessageStats[], users: UserMessageStats[]): (UserMessageLink | undefined)[] {
	const usersBySession = new Map<string, UserMessageStats[]>();
	for (const user of users) {
		const list = usersBySession.get(user.sessionFile) ?? [];
		list.push(user);
		usersBySession.set(user.sessionFile, list);
	}
	for (const list of usersBySession.values()) {
		list.sort((a, b) => a.timestamp - b.timestamp);
	}

	return messages.map(message => {
		const candidates = usersBySession.get(message.sessionFile) ?? [];
		let anchor: UserMessageStats | undefined;
		for (const user of candidates) {
			if (user.timestamp <= message.timestamp) anchor = user;
			else break;
		}
		if (!anchor) return undefined;
		return {
			sessionFile: message.sessionFile,
			entryId: anchor.entryId,
			model: message.model,
			provider: message.provider,
		};
	});
}

function finalizeTask(
	sessionFile: string,
	anchorId: string,
	anchorTimestamp: number | undefined,
	requests: MessageStats[],
): TaskLedgerRecord {
	const first = requests[0];
	const last = requests[requests.length - 1];
	let wallMs = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let costUsd = 0;
	for (const request of requests) {
		wallMs += request.duration ?? 0;
		inputTokens += request.usage.input;
		outputTokens += request.usage.output;
		cacheReadTokens += request.usage.cacheRead;
		costUsd += request.usage.cost.total;
	}
	return {
		taskId: `${sessionFile}#${anchorId}`,
		sessionFile,
		folder: first.folder,
		agentType: last.agentType,
		model: last.model,
		provider: last.provider,
		startedAt: anchorTimestamp ?? first.timestamp - (first.duration ?? 0),
		completedAt: last.timestamp,
		wallMs,
		ttftMs: first.ttft ?? null,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		requestCount: requests.length,
		costUsd,
		stopReason: last.stopReason,
	};
}

/**
 * Group assistant requests into per-task spans.
 *
 * Anchors resolve internally against confirmed `users` rows; grouping keys
 * on (sessionFile, anchor) in chronological order. A new anchor always
 * opens a new span. Orphan requests (no preceding user message) are
 * excluded — they belong to no task.
 */
export function aggregateTasks(requests: MessageStats[], users: UserMessageStats[]): TaskLedgerRecord[] {
	if (requests.length === 0) return [];
	const order = requests
		.map((_, index) => index)
		.sort((a, b) => {
			const left = requests[a];
			const right = requests[b];
			if (left.sessionFile < right.sessionFile) return -1;
			if (left.sessionFile > right.sessionFile) return 1;
			return left.timestamp - right.timestamp;
		});
	const sortedRequests = order.map(index => requests[index]);
	const sortedAnchors = resolveAnchors(sortedRequests, users);
	const userTsByKey = new Map<string, number>();
	for (const user of users) {
		userTsByKey.set(`${user.sessionFile}#${user.entryId}`, user.timestamp);
	}

	const records: TaskLedgerRecord[] = [];
	let current: { anchor: string; sessionFile: string; requests: MessageStats[] } | null = null;
	const flush = () => {
		if (current && current.requests.length > 0) {
			const anchorTs = userTsByKey.get(`${current.sessionFile}#${current.anchor}`);
			records.push(finalizeTask(current.sessionFile, current.anchor, anchorTs, current.requests));
		}
		current = null;
	};
	for (let i = 0; i < sortedRequests.length; i++) {
		const request = sortedRequests[i];
		const anchor = sortedAnchors[i]?.entryId;
		if (anchor === undefined) continue;
		if (!current || current.sessionFile !== request.sessionFile || current.anchor !== anchor) {
			flush();
			current = { anchor, sessionFile: request.sessionFile, requests: [request] };
		} else {
			current.requests.push(request);
		}
	}
	flush();
	return records;
}

/**
 * Recent task spans, most recent first. Anchors are confirmed against
 * `user_messages` rows in TypeScript; the db layer only fetches rows.
 */
export async function getRecentTaskStats(opts?: {
	limit?: number;
	cutoffMs?: number;
	folder?: string;
}): Promise<TaskLedgerRecord[]> {
	const limit = opts?.limit ?? 100;
	const messages = getMessageRows({ folder: opts?.folder });
	const users = getUserMessageRows({ folder: opts?.folder });
	const records = aggregateTasks(messages, users);
	const filtered =
		opts?.cutoffMs !== undefined && opts.cutoffMs > 0
			? records.filter(record => record.completedAt >= (opts?.cutoffMs ?? 0))
			: records;
	filtered.sort((a, b) => b.completedAt - a.completedAt);
	return filtered.slice(0, limit);
}

/**
 * Per-model economics over a trailing window (default 30 days).
 */
export async function getTaskEconomicsByModel(windowMs = 30 * 24 * 60 * 60 * 1000): Promise<ModelEconomics[]> {
	const tasks = await getRecentTaskStats({ cutoffMs: Date.now() - windowMs, limit: Number.MAX_SAFE_INTEGER });
	const byModel = new Map<string, TaskLedgerRecord[]>();
	for (const task of tasks) {
		const key = `${task.provider}/${task.model}`;
		const list = byModel.get(key) ?? [];
		list.push(task);
		byModel.set(key, list);
	}
	const economics: ModelEconomics[] = [];
	for (const list of byModel.values()) {
		const first = list[0];
		let cost = 0;
		let wall = 0;
		let ttftSum = 0;
		let ttftCount = 0;
		for (const task of list) {
			cost += task.costUsd;
			wall += task.wallMs;
			if (task.ttftMs !== null) {
				ttftSum += task.ttftMs;
				ttftCount++;
			}
		}
		economics.push({
			model: first.model,
			provider: first.provider,
			taskCount: list.length,
			avgCostUsd: cost / list.length,
			avgWallMs: wall / list.length,
			avgTtftMs: ttftCount > 0 ? ttftSum / ttftCount : null,
		});
	}
	economics.sort((a, b) => b.taskCount - a.taskCount);
	return economics;
}
