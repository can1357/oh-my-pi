import { TempDir } from "@oh-my-pi/pi-utils";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { PERSISTED_HISTORY_WORKER_ARG } from "../cli/worker-selectors";
import type { AgentHistorySummary } from "./agent-registry";
import type { PersistedTranscript } from "./persisted-agents";

export type HistoryWorkerReply = { id: number; history?: AgentHistorySummary; error?: string };
interface Pending {
	resolve: (history: AgentHistorySummary) => void;
	reject: (error: Error) => void;
	shouldContinue: () => boolean;
}
let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, Pending>();
let idle: Timer | undefined;
let cancellation: Timer | undefined;
function stop(): void {
	const old = worker;
	worker = undefined;
	clearInterval(cancellation);
	cancellation = undefined;
	clearTimeout(idle);
	idle = undefined;
	old?.terminate();
}
function retireWhenIdle(): void {
	if (pending.size === 0 && !idle) idle = setTimeout(stop, 100);
}
function fail(error: Error): void {
	for (const request of pending.values()) request.reject(error);
	pending.clear();
	stop();
}
function ensureWorker(): Worker {
	clearTimeout(idle);
	idle = undefined;
	if (worker) return worker;
	const host = workerHostEntry();
	const created = host
		? new Worker(host, { type: "module", argv: [PERSISTED_HISTORY_WORKER_ARG] })
		: new Worker(new URL("./persisted-history-worker.ts", import.meta.url).href, { type: "module" });
	worker = created;
	created.onmessage = (event: MessageEvent<HistoryWorkerReply>) => {
		if (worker !== created) return;
		const reply = event.data;
		const request = pending.get(reply.id);
		if (!request) return;
		pending.delete(reply.id);
		if (!request.shouldContinue()) request.resolve({});
		else if (reply.error !== undefined) request.reject(new Error(reply.error));
		else request.resolve(reply.history ?? {});
		retireWhenIdle();
	};
	created.onerror = event => {
		if (worker === created) fail(new Error(event.message));
	};
	created.addEventListener("close", () => {
		if (worker === created) fail(new Error("History worker closed before completion"));
	});
	cancellation = setInterval(() => {
		for (const [id, request] of pending) {
			if (request.shouldContinue()) continue;
			pending.delete(id);
			request.resolve({});
		}
		if (pending.size === 0) stop();
	}, 50);
	return created;
}
/** Share one parser thread across concurrent history reads; retire it when the batch settles. */
export async function readHistoryOffThread(
	transcript: PersistedTranscript,
	shouldContinue: () => boolean,
): Promise<AgentHistorySummary> {
	if (!shouldContinue()) return {};
	const target = ensureWorker();
	const id = ++sequence;
	const { promise, resolve, reject } = Promise.withResolvers<AgentHistorySummary>();
	pending.set(id, { resolve, reject, shouldContinue });
	try {
		target.postMessage({ id, transcript });
	} catch (error) {
		fail(error instanceof Error ? error : new Error(String(error)));
	}
	return promise;
}

/** Exercise the distribution's actual worker entrypoint, not an inline parser. */
export async function smokeTestPersistedHistoryWorker(): Promise<void> {
	using directory = TempDir.createSync("omp-history-smoke-");
	const sessionFile = `${directory.path()}/worker.jsonl`;
	await Bun.write(
		sessionFile,
		[
			{ type: "session", id: "smoke", version: 3, cwd: directory.path(), timestamp: "2026-01-01T00:00:00Z" },
			{
				type: "model_usage",
				id: "usage",
				parentId: null,
				timestamp: "2026-01-01T00:00:01Z",
				usage: { cost: { total: 0.125 } },
			},
		]
			.map(entry => JSON.stringify(entry))
			.join("\n") + "\n",
	);
	const deadline = Date.now() + 10000;
	const history = await readHistoryOffThread({ id: "smoke", sessionFile }, () => Date.now() < deadline);
	if (history.directCost !== 0.125) throw new Error("Persisted history worker smoke failed: missing usage summary");
}
