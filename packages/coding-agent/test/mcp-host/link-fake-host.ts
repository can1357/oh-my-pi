/**
 * A scripted MCP host for `HostLink` tests: every attach hands out an
 * in-memory tunnel whose far end the test plays, message by message.
 */
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import {
	encodeJsonLine,
	type McpAttachment,
	type McpAttachRequest,
	type McpEra,
	type McpHostAccess,
	type McpRemoteSpec,
	type McpResolveResult,
	type McpServerSpec,
	type McpTunnel,
} from "@oh-my-pi/pi-coding-agent/mcp/host/contract";
import { MCP_SUBSCRIPTION_ACKNOWLEDGED, MCPMeta } from "@oh-my-pi/pi-coding-agent/mcp/protocol";

export type Message = Record<string, unknown>;

const WAIT_MS = 2_000;

/** The host end of one attachment. */
export class FakeTunnel implements McpTunnel {
	/** Every message the session wrote, in order. */
	readonly sent: Message[] = [];
	closed = false;
	released = false;
	/** While set, the tunnel reports itself full: the session must hold further lines back until {@link drain}. */
	full = false;
	#drained: PromiseWithResolvers<void> | undefined;
	#taken = 0;
	#onData: ((chunk: Uint8Array) => void) | undefined;
	#onClose: ((reason: string | null) => void) | undefined;
	#waiters: (() => void)[] = [];

	constructor(
		readonly request: McpAttachRequest,
		readonly answer: ((message: Message, tunnel: FakeTunnel) => void) | undefined,
	) {}

	send(data: string | Uint8Array): boolean {
		const text = typeof data === "string" ? data : new TextDecoder().decode(data);
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			const message: Message = JSON.parse(line);
			this.sent.push(message);
			this.answer?.(message, this);
		}
		for (const wake of this.#waiters.splice(0)) wake();
		return !this.full;
	}

	drained(): Promise<void> {
		if (!this.full) return Promise.resolve();
		this.#drained ??= Promise.withResolvers<void>();
		return this.#drained.promise;
	}

	/** Make room again: the session may write what it held back. */
	drain(): void {
		this.full = false;
		this.#drained?.resolve();
		this.#drained = undefined;
	}

	start(onData: (chunk: Uint8Array) => void, onClose: (reason: string | null) => void): void {
		this.#onData = onData;
		this.#onClose = onClose;
	}

	close(): void {
		this.closed = true;
	}

	/** Deliver `message` to the session. */
	push(message: Message): void {
		this.#onData?.(new TextEncoder().encode(encodeJsonLine({ jsonrpc: "2.0", ...message })));
	}

	/** Lose the tunnel from the host's side. */
	drop(reason: string | null = "gone"): void {
		this.#onClose?.(reason);
	}

	/** The next not-yet-returned message the session wrote with `method`. */
	async next(method: string): Promise<Message> {
		const deadline = Date.now() + WAIT_MS;
		for (;;) {
			for (let index = this.#taken; index < this.sent.length; index++) {
				if (this.sent[index].method !== method) continue;
				this.#taken = index + 1;
				return this.sent[index];
			}
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.push(resolve);
			const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
			await promise;
			clearTimeout(timer);
			if (Date.now() >= deadline) throw new Error(`session never sent ${method}`);
		}
	}

	/** Acknowledge a `subscriptions/listen` request with the filter it asked for. */
	acknowledge(listen: Message): void {
		this.push({
			method: MCP_SUBSCRIPTION_ACKNOWLEDGED,
			params: { notifications: paramsOf(listen).notifications, _meta: { [MCPMeta.subscriptionId]: listen.id } },
		});
	}
}

/** `params` of a message the session wrote. */
export function paramsOf(message: Message): Message {
	const params = message.params;
	if (typeof params !== "object" || params === null) throw new Error("message has no params");
	return params as Message;
}

/** `_meta` of a request the session wrote. */
export function metaOf(message: Message): Message {
	return paramsOf({ params: paramsOf(message)._meta });
}

/** An {@link McpHostAccess} whose units are {@link FakeTunnel}s. */
export class FakeHost implements McpHostAccess {
	readonly shared = false;
	readonly tunnels: FakeTunnel[] = [];
	readonly resolved: McpServerSpec[] = [];
	era: McpEra = "modern";
	/** When set, the next attaches reject with it. */
	attachFailure: Error | undefined;
	/** Called at the start of every era probe, before it fails or answers. */
	onResolve: ((spec: McpServerSpec) => void) | undefined;
	/** Failures of the coming era probes, consumed one per `resolve`. */
	readonly resolveFailures: Error[] = [];
	/** While set, every era probe waits for it before it fails or answers: the test decides when the verdict arrives. */
	resolveGate: Promise<void> | undefined;
	/** While set, every attach waits for it after its era probe: the test decides when the unit exists. */
	attachGate: Promise<void> | undefined;
	/** Called for every message a session writes, to answer it inline. */
	answer: ((message: Message, tunnel: FakeTunnel) => void) | undefined;
	#reconnectSinks = new Set<() => void>();

	async resolve(spec: McpServerSpec): Promise<McpResolveResult> {
		this.resolved.push(spec);
		this.onResolve?.(spec);
		if (this.resolveGate) await this.resolveGate;
		const failure = this.resolveFailures.shift();
		if (failure) throw failure;
		return { era: this.era };
	}

	async attach(request: McpAttachRequest): Promise<McpAttachment> {
		if (this.attachGate) await this.attachGate;
		if (this.attachFailure) throw this.attachFailure;
		const tunnel = new FakeTunnel(request, this.answer);
		this.tunnels.push(tunnel);
		return {
			tunnel,
			release: () => {
				tunnel.released = true;
			},
		};
	}

	onReconnect(sink: () => void): () => void {
		this.#reconnectSinks.add(sink);
		return () => this.#reconnectSinks.delete(sink);
	}

	/** Sessions currently listening for the host being replaced. */
	get reconnectListeners(): number {
		return this.#reconnectSinks.size;
	}

	/** Announce that the host was replaced. */
	replace(): void {
		for (const sink of this.#reconnectSinks) sink();
	}

	/** The newest tunnel handed out. */
	get tunnel(): FakeTunnel {
		const tunnel = this.tunnels.at(-1);
		if (!tunnel) throw new Error("nothing attached");
		return tunnel;
	}

	/** Resolve once `count` tunnels were handed out. */
	async attached(count: number): Promise<FakeTunnel> {
		const deadline = Date.now() + WAIT_MS;
		while (this.tunnels.length < count) {
			if (Date.now() > deadline) throw new Error(`attachment ${count} never happened`);
			await Bun.sleep(1);
		}
		return this.tunnels[count - 1];
	}
}

export const REMOTE_SPEC: McpRemoteSpec = {
	transport: "http",
	url: "https://mcp.example.test/mcp",
	headers: { Authorization: "Bearer old" },
	timeoutMs: 0,
};

/** The failure a host reports when a remote server refuses the credentials it was given. */
export function unauthorized(status: 401 | 403 = 401): MCPTransportError {
	return new MCPTransportError({
		transport: "http",
		stage: "receive",
		failure: "http_status",
		message: `HTTP ${status}: unauthorized`,
		retryable: false,
		code: status,
	});
}

/** Let every promise continuation already queued run, without waiting on a clock. */
export async function settled(): Promise<void> {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}
