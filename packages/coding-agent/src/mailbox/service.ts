import { Buffer } from "node:buffer";
import { type } from "@oh-my-pi/omptype";
import type { IrcDeliveryReceipt, IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { logger, postmortem, Serial } from "@oh-my-pi/pi-utils";
import { boundField } from "../collab/registry";
import { combine } from "../config/registry";
import type { Settings } from "../config/settings";
import {
	listLocalEndpoints,
	type LocalEndpointPublication,
	type LocalEndpointRegistry,
	type LocalEndpointResponse,
	publishLocalEndpoint,
	queryLocalEndpoint,
	readLocalEndpointEntries,
} from "../ipc/local-endpoint-registry";
import { IrcBus, type IrcRemoteRouter } from "../irc/bus";
import { cfgIrcCrossProcess, cfgIrcPeerAlias } from "../irc/settings";
import { AgentRegistry } from "../registry/agent-registry";
import {
	MAILBOX_ADDRESS_PATTERN,
	MAILBOX_MAX_BODY_BYTES,
	MAILBOX_REGISTRY,
	mailboxAddress,
	mailboxSnapshotSchema,
	type MailboxSnapshot,
	type MailboxTargetSnapshot,
	normalizePeerAlias,
} from "./protocol";

export interface MailboxTarget {
	agentId: string;
	conversation: string | null;
	settings: Settings;
	receive: boolean;
	describe(): { title: string | null; busy: boolean; cwd?: string };
	notify?(state: MailboxTargetState): void;
}

export type MailboxTargetState =
	| { enabled: false }
	| { enabled: true; address: string; receiving: boolean; alias: string | null }
	| { enabled: true; address: string; receiving: false; alias: string | null; error: string };

export interface MailboxPeer extends MailboxTargetSnapshot {
	address: string;
	id: string;
	pid: number;
	cwd: string;
}

export type MailboxPeerResolution =
	| { status: "found"; peer: MailboxPeer }
	| { status: "not_found" }
	| { status: "ambiguous"; candidates: string[] };

export function formatMailboxState(state: MailboxTargetState): string {
	if (!state.enabled) return "Peers: off";
	if ("error" in state) return `Peers: on, but receiving failed — ${state.error}`;
	const address = `${state.address}${state.alias ? ` (alias ${state.alias})` : ""}`;
	if (!state.receiving) return `Peers: on (send-only) — this session is ${address}`;
	return `Peers: on — this session is ${address}`;
}

interface BoundTarget {
	target: MailboxTarget;
	enabled: boolean;
	alias: string | null;
	unsubscribe: () => void;
}

const receiptSchema = type({
	to: "string",
	outcome: "'injected' | 'woken' | 'revived' | 'failed'",
	"error?": "string",
});
const senderDisplaySchema = type({ cwd: "string", title: "string | null" });

export class MailboxService implements IrcRemoteRouter {
	static #global: MailboxService | undefined;

	static global(): MailboxService {
		return (MailboxService.#global ??= new MailboxService());
	}

	static resetGlobalForTests(): void {
		if (MailboxService.#global) void MailboxService.#global.close();
		MailboxService.#global = undefined;
	}

	readonly id = Bun.randomUUIDv7();
	readonly #registry: LocalEndpointRegistry;
	readonly #bus: IrcBus;
	readonly #agentRegistry: AgentRegistry;
	readonly #targets = new Map<string, BoundTarget>();
	readonly #notifications = new Set<BoundTarget>();
	readonly #serial = new Serial();
	#cwd: string | undefined;
	#address: string | undefined;
	#publication: LocalEndpointPublication | undefined;
	#publicationError: string | undefined;
	#cancelExit: (() => void) | undefined;
	#pending: Promise<void> = Promise.resolve();
	#closed = false;
	#closePromise: Promise<void> | undefined;

	constructor(options: { registry?: LocalEndpointRegistry; bus?: IrcBus; agentRegistry?: AgentRegistry } = {}) {
		this.#registry = options.registry ?? MAILBOX_REGISTRY;
		this.#agentRegistry = options.agentRegistry ?? AgentRegistry.global();
		this.#bus = options.bus ?? (options.agentRegistry ? new IrcBus(this.#agentRegistry) : IrcBus.global());
	}

	initialize(cwd: string): void {
		if (this.#address !== undefined) return;
		this.#cwd = cwd;
		this.#address = mailboxAddress(cwd, this.id);
	}

	get address(): string {
		if (this.#address === undefined) throw new Error("MailboxService must be initialized before use.");
		return this.#address;
	}

	bindTarget(target: MailboxTarget): () => void {
		if (this.#closed) throw new Error("MailboxService is closed.");
		void this.address;
		if (this.#targets.has(target.agentId)) throw new Error(`Mailbox target "${target.agentId}" is already bound.`);
		if ([...this.#targets.values()].some(bound => bound.target.conversation === target.conversation)) {
			throw new Error(`Mailbox conversation "${target.conversation}" is already bound.`);
		}
		const config = combine({ enabled: cfgIrcCrossProcess, alias: cfgIrcPeerAlias.map(normalizePeerAlias) });
		const bound: BoundTarget = {
			target,
			...config.get(target.settings),
			unsubscribe: () => {},
		};
		this.#targets.set(target.agentId, bound);
		bound.unsubscribe = config.listen(target.settings, ({ enabled, alias }, previous) => {
			bound.enabled = enabled;
			bound.alias = alias;
			if (enabled || enabled !== previous.enabled) this.#notifications.add(bound);
			this.#schedule();
		});
		if (bound.enabled) this.#notifications.add(bound);
		this.#schedule();
		return () => {
			if (this.#targets.get(target.agentId) !== bound) return;
			bound.unsubscribe();
			this.#targets.delete(target.agentId);
			this.#notifications.delete(bound);
			this.#schedule();
		};
	}

	state(agentId: string): MailboxTargetState {
		const bound = this.#targets.get(agentId);
		if (this.#closed || !bound?.enabled) return { enabled: false };
		const address = `${this.address}${bound.target.conversation === null ? "" : `.${bound.target.conversation}`}`;
		if (bound.target.receive && this.#publicationError !== undefined) {
			return { enabled: true, address, alias: bound.alias, receiving: false, error: this.#publicationError };
		}
		return {
			enabled: true,
			address,
			alias: bound.alias,
			receiving: bound.target.receive && this.#publication !== undefined,
		};
	}

	async whenSettled(): Promise<void> {
		// Derived.listen coalesces setting changes in a microtask before scheduling publication.
		await Promise.resolve();
		let pending: Promise<void>;
		do {
			pending = this.#pending;
			await pending;
			await Promise.resolve();
		} while (pending !== this.#pending);
	}

	#schedule(): void {
		this.#pending = this.#serial.run(() => this.#reconcile());
		void this.#pending.catch(error => logger.warn("Mailbox reconciliation failed", { error }));
	}

	async #reconcile(): Promise<void> {
		for (;;) {
			const receive =
				!this.#closed && [...this.#targets.values()].some(bound => bound.enabled && bound.target.receive);
			if (receive === (this.#publication !== undefined)) break;
			if (!receive) {
				const publication = this.#publication;
				this.#publication = undefined;
				await publication?.close();
				this.#publicationError = undefined;
			} else {
				try {
					this.#publication = await publishLocalEndpoint(this.#registry, request => this.#handle(request), {
						instanceId: this.address,
					});
					this.#publicationError = undefined;
					if (!this.#cancelExit) {
						this.#cancelExit = postmortem.register("mailbox", () => this.close(), { exitOnly: true });
					}
				} catch (error) {
					this.#publicationError = error instanceof Error ? error.message : String(error);
					break;
				}
			}
		}
		const notifications = [...this.#notifications];
		this.#notifications.clear();
		for (const bound of notifications) {
			if (this.#targets.get(bound.target.agentId) !== bound) continue;
			try {
				bound.target.notify?.(this.state(bound.target.agentId));
			} catch (error) {
				logger.warn("Mailbox state notification failed", { error });
			}
		}
	}

	async #handle(request: Readonly<Record<string, unknown>>): Promise<LocalEndpointResponse> {
		if (request.op === "snapshot") {
			const snapshot: MailboxSnapshot = {
				address: this.address,
				id: this.id,
				pid: process.pid,
				cwd: boundField(this.#cwd!),
				targets: [...this.#targets.values()]
					.filter(bound => !this.#closed && bound.enabled && bound.target.receive)
					.map(({ target, alias }) => {
						const { title, busy, cwd } = target.describe();
						return {
							conversation: target.conversation,
							title: title === null ? null : boundField(title),
							busy,
							alias: alias === null ? null : boundField(alias),
							cwd: cwd === undefined ? null : boundField(cwd),
						};
					}),
			};
			return { ok: true, snapshot };
		}
		if (request.op !== "deliver") return { ok: false, error: "malformed_request" };
		const { from, body, to, replyTo, noWake, senderDisplay } = request;
		if (
			typeof from !== "string" ||
			!MAILBOX_ADDRESS_PATTERN.test(from) ||
			from === this.address ||
			from.startsWith(`${this.address}.`)
		) {
			return { ok: false, error: "invalid_sender" };
		}
		if (typeof body !== "string") return { ok: false, error: "malformed_request" };
		if (Buffer.byteLength(body, "utf8") > MAILBOX_MAX_BODY_BYTES) return { ok: false, error: "body_too_large" };
		const bound = [...this.#targets.values()].find(candidate => candidate.target.conversation === to);
		if (!bound) return { ok: false, error: "unknown_target" };
		if (this.#closed || !bound.enabled || !bound.target.receive) return { ok: false, error: "not_receiving" };
		if (
			(replyTo !== undefined && typeof replyTo !== "string") ||
			(noWake !== undefined && typeof noWake !== "boolean")
		) {
			return { ok: false, error: "malformed_request" };
		}
		let display: IrcMessage["senderDisplay"];
		if (senderDisplay !== undefined) {
			if (!senderDisplaySchema.allows(senderDisplay)) {
				return { ok: false, error: "malformed_request" };
			}
			display = {
				cwd: boundField(senderDisplay.cwd),
				title: senderDisplay.title === null ? null : boundField(senderDisplay.title),
			};
		}
		const receipt = await this.#bus.send({
			from,
			to: bound.target.agentId,
			body,
			replyTo,
			remote: true,
			noWake,
			senderDisplay: display,
		});
		return { ok: true, receipt };
	}

	async listPeers(options?: { signal?: AbortSignal }): Promise<MailboxPeer[]> {
		const snapshots = await listLocalEndpoints<MailboxSnapshot>(
			this.#registry,
			async entry => {
				if (entry.meta.instanceId === this.#address) return { status: "skip" };
				const result = await queryLocalEndpoint(
					this.#registry,
					entry.meta,
					{ op: "snapshot" },
					1500,
					options?.signal,
				);
				if (result.status !== "ok") return result;
				const snapshot = result.value.snapshot;
				if (
					result.value.ok !== true ||
					!mailboxSnapshotSchema.allows(snapshot) ||
					snapshot.address !== entry.meta.instanceId
				) {
					return { status: "skip" };
				}
				return { status: "ok", value: snapshot };
			},
			options,
		);
		return snapshots.flatMap(({ value }) =>
			value.targets.map(target => ({
				...target,
				address: `${value.address}${target.conversation === null ? "" : `.${target.conversation}`}`,
				id: value.id,
				pid: value.pid,
				cwd: target.cwd ?? value.cwd,
			})),
		);
	}

	/** Canonical address or alias → live peer. Exact matches only. */
	async resolvePeer(to: string, options?: { signal?: AbortSignal }): Promise<MailboxPeerResolution> {
		const peers = await this.listPeers(options);
		const exact = peers.filter(peer => peer.address === to);
		const matches = exact.length > 0 ? exact : peers.filter(peer => peer.alias === to);
		const unique = [...new Map(matches.map(peer => [peer.address, peer])).values()];
		if (unique.length === 0) return { status: "not_found" };
		if (unique.length > 1) return { status: "ambiguous", candidates: unique.map(peer => peer.address).sort() };
		return { status: "found", peer: unique[0]! };
	}

	handles(to: string): boolean {
		return (
			!this.#closed &&
			(MAILBOX_ADDRESS_PATTERN.test(to) || normalizePeerAlias(to) === to) &&
			[...this.#targets.values()].some(bound => bound.enabled)
		);
	}

	async send(message: IrcMessage): Promise<IrcDeliveryReceipt> {
		const fail = (error: string): IrcDeliveryReceipt => ({ to: message.to, outcome: "failed", error });
		const sender = this.#targets.get(message.from);
		if (!sender) return fail("Only main agents can message other omp processes.");
		if (this.#closed || !sender.enabled) return fail("Cross-process peers are off for this session — run /peers on.");
		const from = `${this.address}${sender.target.conversation === null ? "" : `.${sender.target.conversation}`}`;
		const noWake = this.#agentRegistry.get(message.from)?.session?.isRemoteWakeTurn() === true;
		let to = message.to;
		try {
			if (!MAILBOX_ADDRESS_PATTERN.test(to)) {
				const resolution = await this.resolvePeer(to);
				if (resolution.status === "not_found") {
					return fail(`No local agent or omp peer named "${to}" — read history:// to list agents and peers.`);
				}
				if (resolution.status === "ambiguous") {
					return fail(
						`"${to}" matches more than one omp peer; use an address: ${resolution.candidates.join(", ")}`,
					);
				}
				to = resolution.peer.address;
			}
			const [address, conversation] = to.split(".");
			const entry = (await readLocalEndpointEntries(this.#registry)).find(
				candidate => candidate.meta.instanceId === address,
			);
			if (!entry) return fail(`No omp peer "${message.to}" is running — read history:// to list peers.`);
			const { cwd, title } = sender.target.describe();
			const result = await queryLocalEndpoint(
				this.#registry,
				entry.meta,
				{
					op: "deliver",
					from,
					to: conversation ?? null,
					body: message.body,
					replyTo: message.replyTo,
					noWake,
					senderDisplay: {
						cwd: boundField(cwd ?? this.#cwd!),
						title: title === null ? null : boundField(title),
					},
				},
				30_000,
			);
			if (result.status === "dead") return fail(`Peer ${message.to} is not reachable.`);
			if (result.status === "skip") {
				return fail(
					result.error === "not_receiving"
						? `Peer ${message.to} is not receiving messages.`
						: (result.error ?? `Peer ${message.to} did not return a valid delivery receipt.`),
				);
			}
			return receiptSchema.allows(result.value.receipt)
				? result.value.receipt
				: fail(`Peer ${message.to} did not return a valid delivery receipt.`);
		} catch {
			return fail(`Peer ${message.to} is not reachable.`);
		}
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		for (const bound of this.#targets.values()) bound.unsubscribe();
		this.#notifications.clear();
		this.#schedule();
		this.#closePromise = this.whenSettled().then(() => {
			this.#targets.clear();
			this.#cancelExit?.();
			this.#cancelExit = undefined;
		});
		return this.#closePromise;
	}
}
