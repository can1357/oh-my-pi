/**
 * Workers of `test/fixtures/runtime-service-worker.ts`, linked to this thread as a subagent worker is, with the
 * settings, runtime and async-jobs services on both ends, and main-side job managers for them. Each worker and its
 * channel ports are recorded at its spawn, before its readiness and boot, so {@link RuntimeWorkers.stop} releases
 * them whichever step of its start failed, each on its own.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async/job-manager";
import type { MainThreadLink, SubagentMainApi, SubagentWorkerApi } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { ThreadService, WorkerPeer } from "../../src/thread/services";
import { asyncJobsThreadService } from "../../src/thread/services/async-jobs";
import { runtimeThreadService } from "../../src/thread/services/runtime";
import { settingsThreadService } from "../../src/thread/services/settings";
import { runEach } from "./cleanup";

/** Main-side view of the fixture's probe: every call is async across the link. */
export type Probe = (op: string, ...args: unknown[]) => Promise<unknown>;

/** The cap of a worker's readiness after its spawn: below the 30 s timeout of each case that starts one. */
const START_MS = 20_000;

const SERVICES: readonly ThreadService[] = [settingsThreadService, runtimeThreadService, asyncJobsThreadService];

/** Holds, on main's side of a worker link, the worker's replies that carry the job results it is told to hold. */
export class ResultFrames {
	readonly #holds = new Map<string, PromiseWithResolvers<() => void>>();
	/** The frames held now, each by what lets it through. */
	readonly #held = new Set<() => void>();

	/**
	 * Hold the reply that carries the job result `text`. Resolves once main has it, with what lets it through: by
	 * then the worker's run has ended, its `finally` included, and main has not settled the job's row.
	 */
	hold(text: string): Promise<() => void> {
		const hold = Promise.withResolvers<() => void>();
		this.#holds.set(text, hold);
		return hold.promise;
	}

	/** Pass `frame`, a frame the worker sent, on to main with `deliver` now, or hold it if it is a held result. */
	inbound(frame: RpcFrame, deliver: () => void): void {
		const text = frame.t === "ok" && typeof frame.v === "string" ? frame.v : undefined;
		const hold = text === undefined ? undefined : this.#holds.get(text);
		if (text === undefined || !hold) {
			deliver();
			return;
		}
		this.#holds.delete(text);
		const letThrough = (): void => {
			if (this.#held.delete(letThrough)) deliver();
		};
		this.#held.add(letThrough);
		hold.resolve(letThrough);
	}

	/**
	 * Let every held frame through, each on its own, and hold no later one, so no teardown step waits on a frame a
	 * case left held; then throw what the deliveries threw.
	 */
	releaseAll(): Promise<void> {
		this.#holds.clear();
		return runEach([...this.#held]);
	}
}

/** A worker started here, and what of it this side holds, each recorded as it is acquired. */
interface Started {
	readonly worker: Worker;
	/** What holds its result frames; {@link RuntimeWorkers.stop} lets them through before it stops anything. */
	readonly frames: ResultFrames | undefined;
	/** The channel ports this side owns: both until the worker is sent its end, then main's only. */
	ports: MessagePort[];
	/** Stops listening for its readiness message, once this side listens. */
	stopReadiness?: () => void;
	/** Main's end of the link to it, once there is one. */
	peer?: WorkerPeer;
}

/** The workers and job managers of one test file; see the module doc. */
export class RuntimeWorkers {
	readonly #started: Started[] = [];
	readonly #managers: AsyncJobManager[] = [];
	#nextWorker = 1;

	/** The worker of the latest {@link start}, recorded at its spawn. */
	get latest(): Worker | undefined {
		return this.#started.at(-1)?.worker;
	}

	/** A main-side job manager, disposed by {@link stop}. */
	newManager(): AsyncJobManager {
		const manager = new AsyncJobManager({});
		this.#managers.push(manager);
		return manager;
	}

	/** Main's side of the latest linked worker's exit with `reason`: its services' exit hooks run and its link closes. */
	exitLatest(reason: string): void {
		const peer = this.#started.at(-1)?.peer;
		if (!peer) throw new Error("no linked worker");
		for (const service of SERVICES) service.onWorkerExit?.(peer, reason);
		peer.link.close(reason);
	}

	/**
	 * A worker of the fixture, ready within `startMs` of its spawn; returns its probe once it booted. `frames`, when
	 * given, sees each frame the worker sends before main does.
	 */
	async start({ frames, startMs = START_MS }: { frames?: ResultFrames; startMs?: number } = {}): Promise<Probe> {
		const spawned = new Worker(new URL("../fixtures/runtime-service-worker.ts", import.meta.url).href, {
			type: "module",
		});
		const channel = new MessageChannel();
		const entry: Started = { worker: spawned, frames, ports: [channel.port1, channel.port2] };
		this.#started.push(entry);
		const counter = new SharedArrayBuffer(4);
		const { promise: ready, resolve } = Promise.withResolvers<void>();
		const onReady = (event: MessageEvent): void => {
			if (event.data?.ready) {
				spawned.removeEventListener("message", onReady);
				resolve();
			}
		};
		spawned.addEventListener("message", onReady);
		entry.stopReadiness = () => spawned.removeEventListener("message", onReady);
		spawned.postMessage({ sync: channel.port2, counter }, [channel.port2]);
		// The worker owns its end from here on.
		entry.ports = [channel.port1];
		await withTimeout(ready, startMs, `worker start: not ready within ${startMs} ms`);
		const threadId = `w${this.#nextWorker++}` as const;
		const link: MainThreadLink = new RpcLink<SubagentMainApi, SubagentWorkerApi>(
			{
				send: frame => spawned.postMessage(frame),
				listen: handler => {
					const listener = (event: MessageEvent<RpcFrame>): void => {
						const frame = event.data;
						if (frames) frames.inbound(frame, () => handler(frame));
						else handler(frame);
					};
					spawned.addEventListener("message", listener);
					return () => spawned.removeEventListener("message", listener);
				},
			},
			{ name: `main↔${threadId}`, syncReplies: { port: channel.port1, counter: new Int32Array(counter) } },
		);
		const peer: WorkerPeer = { threadId, link };
		entry.peer = peer;
		link.handle("ping", nonce => nonce);
		for (const service of SERVICES) service.installMain?.(peer);
		let probe: Probe | undefined;
		await link.call("boot", {
			settings: settingsThreadService.globals?.(peer),
			probe: (registered: Probe) => {
				probe = registered;
			},
		});
		if (!probe) throw new Error("fixture did not register its probe");
		return probe;
	}

	/**
	 * Release everything started here, each step on its own, so a step that throws (an exit hook, say) skips none of
	 * the others; then throw what the steps threw. Held frames go first, so neither a wait of main nor a manager's
	 * dispose waits on one; then the managers; then, for each worker, its readiness listener, exit hooks, link,
	 * ports and the worker itself.
	 */
	stop(): Promise<void> {
		const workers = this.#started.splice(0);
		const steps: Array<() => unknown> = [];
		for (const { frames } of workers) if (frames) steps.push(() => frames.releaseAll());
		for (const manager of this.#managers.splice(0)) steps.push(() => manager.dispose({ timeoutMs: 100 }));
		for (const { worker, ports, stopReadiness, peer } of workers) {
			if (stopReadiness) steps.push(stopReadiness);
			if (peer) {
				for (const service of SERVICES) steps.push(() => service.onWorkerExit?.(peer, "test end"));
				steps.push(() => peer.link.close("test end"));
			}
			for (const port of ports) steps.push(() => port.close());
			steps.push(() => worker.terminate());
		}
		return runEach(steps);
	}
}
