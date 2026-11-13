import {
	getMathImageRenderer,
	onMathImageRendererChange,
	setMathImageRenderer,
	type MathImageRenderer,
	type MathImageRenderRequest,
	type MathImageSvg,
} from "@oh-my-pi/pi-tui";
import { TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { MATH_WORKER_ARG } from "../cli/worker-selectors";
import {
	isMathWorkerOutbound,
	MATH_RENDERER_ID,
	MATH_WORKER_MAX_PENDING,
	MATH_WORKER_TIMEOUT_MS,
	type MathWorkerInbound,
} from "./math-worker-protocol";

type State = "idle" | "spawning" | "ready" | "failed" | "exhausted" | "terminated";
interface Pending {
	id: number;
	epoch: number;
	request: MathImageRenderRequest;
	resolve: (result: MathImageSvg) => void;
	reject: (error: Error) => void;
	promise: Promise<MathImageSvg>;
}

/** One serial, demand-started transport; conversion never runs in this realm. */
export class MathImageWorkerClient {
	#state: State = "idle";
	#enabled = false;
	#epoch = 0;
	#nextId = 0;
	#restartUsed = false;
	#worker: Worker | undefined;
	#queue: Pending[] = [];
	#active: Pending | undefined;
	#timer: Timer | undefined;
	#detach: (() => void) | undefined;
	#pingId = 0;
	#ready = false;
	#pong = false;

	beginLifecycle(): void {
		if (this.#enabled) return;
		this.#enabled = true;
		this.#epoch++;
		this.#restartUsed = false;
		this.#state = "idle";
	}

	render(request: MathImageRenderRequest): Promise<MathImageSvg> {
		if (!this.#enabled || this.#state === "terminated") return Promise.reject(new Error("Math renderer is disabled"));
		if (this.#state === "exhausted") return Promise.reject(new Error("Math worker restart allowance exhausted"));
		if (this.#queue.length + Number(Boolean(this.#active)) >= MATH_WORKER_MAX_PENDING)
			return Promise.reject(new Error("Math worker queue is full"));
		const deferred = Promise.withResolvers<MathImageSvg>();
		this.#queue.push({ ...deferred, id: ++this.#nextId, epoch: this.#epoch, request });
		if (this.#state === "idle" || this.#state === "failed") {
			if (this.#state === "failed") this.#restartUsed = true;
			this.#spawn();
		} else this.#pump();
		return deferred.promise;
	}

	cancelQueued(): void {
		const queue = this.#queue.splice(0);
		for (const pending of queue) pending.reject(new Error("Math rendering cancelled"));
	}

	terminate(): void {
		this.#enabled = false;
		this.#cleanup(new Error("Math renderer disabled"));
		this.#state = "idle";
	}

	dispose(): void {
		this.#enabled = false;
		this.#cleanup(new Error("Math renderer disposed"));
		this.#state = "terminated";
	}

	#cleanup(error: Error): void {
		this.#epoch++;
		const worker = this.#worker;
		this.#worker = undefined;
		this.#detach?.();
		this.#detach = undefined;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		const active = this.#active;
		this.#active = undefined;
		const queue = this.#queue.splice(0);
		active?.reject(error);
		for (const pending of queue) pending.reject(error);
		worker?.terminate();
	}

	#fail(error: Error): void {
		this.#cleanup(error);
		this.#state = this.#restartUsed ? "exhausted" : "failed";
	}

	#post(message: MathWorkerInbound): void {
		try {
			this.#worker!.postMessage(message);
		} catch {
			this.#fail(new Error("Math worker postMessage failed"));
		}
	}

	#spawn(): void {
		this.#state = "spawning";
		this.#ready = false;
		this.#pong = false;
		let worker: Worker;
		try {
			const hostEntry = workerHostEntry();
			worker = hostEntry
				? new Worker(hostEntry, { type: "module", argv: [MATH_WORKER_ARG] })
				: new Worker(new URL("./math-worker-entry.ts", import.meta.url).href, { type: "module" });
		} catch {
			this.#fail(new Error("Math worker construction failed"));
			return;
		}
		this.#worker = worker;
		const current = () => this.#worker === worker;
		const message = (event: MessageEvent<unknown>) => {
			if (!current()) return;
			const value = event.data;
			if (!isMathWorkerOutbound(value)) {
				this.#fail(new Error("Invalid math worker response"));
				return;
			}
			if (value.type === "ready") {
				if (this.#state !== "spawning") return;
				if (value.rendererId !== MATH_RENDERER_ID) {
					this.#fail(new Error("Math worker renderer mismatch"));
					return;
				}
				if (this.#state === "spawning") this.#ready = true;
			} else if (value.type === "pong") {
				if (this.#state === "spawning" && value.id === this.#pingId && value.epoch === this.#epoch)
					this.#pong = true;
			} else {
				const active = this.#active;
				if (
					this.#state !== "ready" ||
					!active ||
					active.id !== value.id ||
					active.epoch !== value.epoch ||
					value.epoch !== this.#epoch
				)
					return;
				this.#active = undefined;
				clearTimeout(this.#timer);
				this.#timer = undefined;
				if (value.type === "result") active.resolve(value.result);
				else {
					const error = new Error(value.error.message);
					error.name = value.error.name;
					active.reject(error);
				}
				this.#pump();
				return;
			}
			if (this.#state === "spawning" && this.#ready && this.#pong) {
				clearTimeout(this.#timer);
				this.#timer = undefined;
				this.#state = "ready";
				this.#pump();
			}
		};
		const failure = () => {
			if (current()) this.#fail(new Error("Math worker transport failed"));
		};
		worker.addEventListener("message", message);
		worker.addEventListener("error", failure);
		worker.addEventListener("messageerror", failure);
		worker.addEventListener("close", failure);
		this.#detach = () => {
			worker.removeEventListener("message", message);
			worker.removeEventListener("error", failure);
			worker.removeEventListener("messageerror", failure);
			worker.removeEventListener("close", failure);
		};
		this.#timer = setTimeout(() => {
			if (current() && this.#state === "spawning") this.#fail(new Error("Math worker startup timed out"));
		}, MATH_WORKER_TIMEOUT_MS);
		this.#pingId = ++this.#nextId;
		this.#post({ type: "ping", id: this.#pingId, epoch: this.#epoch });
	}

	#pump(): void {
		if (this.#state !== "ready" || this.#active || !this.#queue.length) return;
		const pending = this.#queue.shift()!;
		this.#active = pending;
		const worker = this.#worker;
		this.#timer = setTimeout(() => {
			if (this.#worker === worker && this.#active === pending) this.#fail(new Error("Math worker render timed out"));
		}, MATH_WORKER_TIMEOUT_MS);
		this.#post({ type: "render", id: pending.id, epoch: pending.epoch, request: pending.request });
	}
}

export interface MathImageRendererPolicy {
	renderMath: boolean;
	showImages: boolean;
}
export interface MathImageRendererLifecycle {
	setPolicy(policy: MathImageRendererPolicy): void;
	dispose(): void;
}
const client = new MathImageWorkerClient();
let owner: object | undefined;
let policy: MathImageRendererPolicy = { renderMath: false, showImages: false };
export const codingAgentMathImageRenderer: MathImageRenderer = {
	id: MATH_RENDERER_ID,
	render(request) {
		if (!owner || !policy.renderMath || !policy.showImages || !TERMINAL.imageProtocol)
			return Promise.reject(new Error("Math image rendering unavailable"));
		return client.render(request);
	},
};
onMathImageRendererChange(() => {
	if (getMathImageRenderer() !== codingAgentMathImageRenderer) {
		owner = undefined;
		client.dispose();
	}
});

export function registerCodingAgentMathImageRenderer(initial: MathImageRendererPolicy): MathImageRendererLifecycle {
	client.dispose();
	const token = {};
	owner = token;
	policy = { ...initial };
	setMathImageRenderer(codingAgentMathImageRenderer);
	if (policy.renderMath) client.beginLifecycle();
	return {
		setPolicy(next) {
			if (owner !== token || (next.renderMath === policy.renderMath && next.showImages === policy.showImages))
				return;
			const previous = policy;
			policy = { ...next };
			setMathImageRenderer(getMathImageRenderer());
			if (!next.renderMath) client.terminate();
			else if (!previous.renderMath) client.beginLifecycle();
			if (!next.showImages) client.cancelQueued();
		},
		dispose() {
			if (owner !== token) return;
			owner = undefined;
			setMathImageRenderer(getMathImageRenderer());
			client.dispose();
		},
	};
}
