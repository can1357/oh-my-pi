/**
 * Bun Worker that hosts the workflow's `node:vm` sandbox.
 *
 * `runWorkflowScript` (vm.ts) spawns this worker so the host can terminate a
 * script stuck in a non-yielding stretch, including one that begins after an
 * `await`. The sandbox keeps the determinism and global-allowlist guarantees;
 * the `agent`/`log`/`phase` helpers bridge back over `postMessage`. A periodic
 * heartbeat lets the host tell a busy-but-yielding worker from an idle one
 * (a tight loop blocks the worker event loop, so its heartbeats stop).
 *
 * An `AsyncLocalStorage` scope gives every `agent()` call a deterministic,
 * completion-order-independent call path: parallel items each run in their own
 * child scope, so a call's identity is its structural position, not the order
 * in which sibling promises happen to settle.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as vm from "node:vm";
import type { WorkflowHostMessage, WorkflowWorkerMessage } from "./worker-protocol";

type Bridge = (...args: unknown[]) => unknown;

interface AgentPending {
	resolve: (value: string) => void;
	reject: (reason: string) => void;
}

interface Scope {
	path: string;
	seq: number;
}

const rootScope: Scope = { path: "r", seq: 0 };
const scopes = new AsyncLocalStorage<Scope>();
const pendingAgents = new Map<number, AgentPending>();
let nextRequestId = 0;
let started = false;

/** The Worker global scope; the package's DOM-less lib types do not declare `self`. */
const scope = globalThis as unknown as {
	postMessage(message: unknown): void;
	onmessage: ((event: MessageEvent) => void) | null;
};
const post = (message: WorkflowWorkerMessage): void => scope.postMessage(message);

function hardenBridge(fn: Bridge): Bridge {
	Object.setPrototypeOf(fn, null);
	return Object.freeze(fn);
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

const hostAgent: Bridge = (payloadJson, resolve, reject) => {
	if (typeof resolve !== "function" || typeof reject !== "function") return undefined;
	const scope = scopes.getStore() ?? rootScope;
	const callPath = `${scope.path}:${scope.seq++}`;
	const requestId = nextRequestId++;
	pendingAgents.set(requestId, {
		resolve: resolve as (value: string) => void,
		reject: reject as (reason: string) => void,
	});
	post({ type: "agent", requestId, callPath, payload: String(payloadJson) });
	return undefined;
};

const hostLog: Bridge = line => {
	if (typeof line === "string") post({ type: "log", line });
	return undefined;
};

const hostPhase: Bridge = name => {
	if (typeof name === "string") post({ type: "phase", name });
	return undefined;
};

const hostParallelFailure: Bridge = () => {
	post({ type: "parallelFailure" });
	return undefined;
};

/** Run `thunk` under a fresh child scope; ALS propagates it across awaits. */
const hostWithScope: Bridge = (key, thunk) => {
	if (typeof key !== "string" || typeof thunk !== "function") return undefined;
	const parent = scopes.getStore() ?? rootScope;
	const child: Scope = { path: `${parent.path}.${key}`, seq: 0 };
	return scopes.run(child, thunk as () => unknown);
};

function start(init: Extract<WorkflowHostMessage, { type: "init" }>): void {
	const sandbox: Record<string, unknown> = Object.create(null);
	sandbox.__hostAgent = hardenBridge(hostAgent);
	sandbox.__hostLog = hardenBridge(hostLog);
	sandbox.__hostPhase = hardenBridge(hostPhase);
	sandbox.__hostWithScope = hardenBridge(hostWithScope);
	sandbox.__hostParallelFailure = hardenBridge(hostParallelFailure);
	sandbox.__hostArgs = init.args;

	let context: vm.Context;
	try {
		context = vm.createContext(sandbox, {
			name: "omp-workflow",
			codeGeneration: { strings: false, wasm: false },
		});
		new vm.Script(init.prelude, { filename: "workflow-prelude.js" }).runInContext(context);
		new vm.Script(init.harden, { filename: "workflow-harden.js" }).runInContext(context);
	} catch (error) {
		post({ type: "error", message: `workflow sandbox could not start: ${errorText(error)}` });
		return;
	}

	setInterval(() => post({ type: "heartbeat" }), init.heartbeatMs);

	let pending: unknown;
	try {
		pending = new vm.Script(init.envelopeSource, { filename: "workflow-script.js" }).runInContext(context);
	} catch (error) {
		post({ type: "error", message: `workflow script syntax error: ${errorText(error)}` });
		return;
	}
	// The envelope always resolves to a JSON string; its own catch turns a
	// thrown script error into `{ ok: false }`. A script that never yields
	// keeps this promise pending until the host terminates the worker.
	void Promise.resolve(pending).then(
		envelopeJson => {
			post({
				type: "done",
				envelopeJson: typeof envelopeJson === "string" ? envelopeJson : String(envelopeJson ?? ""),
			});
		},
		error => {
			post({ type: "done", envelopeJson: JSON.stringify({ ok: false, error: errorText(error) }) });
		},
	);
}

scope.onmessage = (event: MessageEvent): void => {
	const message = event.data as WorkflowHostMessage | null;
	if (message === null || typeof message !== "object") return;
	switch (message.type) {
		case "init":
			if (!started) {
				started = true;
				start(message);
			}
			break;
		case "agentResult": {
			const pending = pendingAgents.get(message.requestId);
			if (pending) {
				pendingAgents.delete(message.requestId);
				pending.resolve(message.result);
			}
			break;
		}
		case "agentError": {
			const pending = pendingAgents.get(message.requestId);
			if (pending) {
				pendingAgents.delete(message.requestId);
				pending.reject(message.error);
			}
			break;
		}
	}
};
