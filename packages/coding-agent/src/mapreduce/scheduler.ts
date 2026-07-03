export interface SchedulableShard {
	id: string;
	priority?: number;
	weight?: number;
	retryPenalty?: number;
	expectedDuration?: number;
}

export interface ScheduledShardResult<TShard extends SchedulableShard, TResult> {
	shard: TShard;
	result: TResult;
	startedAt: number;
	finishedAt: number;
}

export interface ScheduledShardFailure<TShard extends SchedulableShard> {
	shard: TShard;
	error: unknown;
	startedAt: number;
	finishedAt: number;
}

export interface RunShardQueueInput<TShard extends SchedulableShard, TResult> {
	shards: readonly TShard[];
	concurrency: number;
	worker: (shard: TShard, signal: AbortSignal) => Promise<TResult>;
	signal?: AbortSignal;
}

export interface RunShardQueueResult<TShard extends SchedulableShard, TResult> {
	results: Array<ScheduledShardResult<TShard, TResult>>;
	failures: Array<ScheduledShardFailure<TShard>>;
	maxActive: number;
	completed: number;
	failed: number;
}

export function shardPriority(shard: SchedulableShard): number {
	return (shard.priority ?? 0) - (shard.retryPenalty ?? 0) - (shard.expectedDuration ?? shard.weight ?? 0);
}

export function normalizeSchedulerConcurrency(concurrency: number, itemCount: number): number {
	if (itemCount <= 0) return 0;
	if (concurrency <= 0 || concurrency === Number.POSITIVE_INFINITY) return itemCount;
	if (!Number.isFinite(concurrency)) return 1;
	return Math.max(1, Math.min(Math.floor(concurrency), itemCount));
}

export async function runShardQueue<TShard extends SchedulableShard, TResult>(
	input: RunShardQueueInput<TShard, TResult>,
): Promise<RunShardQueueResult<TShard, TResult>> {
	const pending = [...input.shards].sort(
		(left, right) => shardPriority(right) - shardPriority(left) || left.id.localeCompare(right.id),
	);
	const workerCount = normalizeSchedulerConcurrency(input.concurrency, pending.length);
	const results: Array<ScheduledShardResult<TShard, TResult>> = [];
	const failures: Array<ScheduledShardFailure<TShard>> = [];
	const controller = new AbortController();
	const workerSignal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
	let active = 0;
	let maxActive = 0;
	let cursor = 0;

	const lease = (): TShard | undefined => {
		if (input.signal?.aborted || cursor >= pending.length) return undefined;
		const shard = pending[cursor];
		cursor += 1;
		return shard;
	};

	const runWorker = async (): Promise<void> => {
		while (true) {
			const shard = lease();
			if (!shard) return;
			const startedAt = Date.now();
			active += 1;
			maxActive = Math.max(maxActive, active);
			try {
				const result = await input.worker(shard, workerSignal);
				results.push({ shard, result, startedAt, finishedAt: Date.now() });
			} catch (error) {
				failures.push({ shard, error, startedAt, finishedAt: Date.now() });
			} finally {
				active -= 1;
			}
		}
	};

	try {
		await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
	} catch (error) {
		controller.abort(error);
		throw error;
	}

	results.sort((left, right) => left.shard.id.localeCompare(right.shard.id));
	failures.sort((left, right) => left.shard.id.localeCompare(right.shard.id));
	return { results, failures, maxActive, completed: results.length, failed: failures.length };
}
