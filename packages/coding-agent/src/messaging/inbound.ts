import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { ManagedTimers } from "../extensibility/extensions/managed-timers";
import { decideInbound, dialogExpiryMs, type InboundDecision, resolveInbound } from "./policy";
import type { StoredMessage } from "./mailbox";
import {
	ACCEPTED_QUEUE_CAP,
	HELD_CAP,
	type InboxRequest,
	type InboxResponse,
	MAX_SERIALIZED_CHARS,
	type SenderInfo,
} from "./protocol";
import type { MessagingHost, RemoteDelivery } from "./service";
import {
	cfgMessagingRateLimit,
	cfgMessagingRateWindowSeconds,
	cfgMessagingRelayMaxHops,
	cfgMessagingRelayMaxRevisits,
	cfgMessagingRepeatWindowSeconds,
} from "./settings";

type MessageRequest = Extract<InboxRequest, { type: "message" }>;
export type OutgoingNotice = Omit<
	Exclude<Extract<InboxRequest, { type: "notice" }>, { kind: "refused" }>,
	"id" | "from"
>;
interface HeldMessage {
	request: MessageRequest;
	sender: SenderInfo;
	receiver: SenderInfo | undefined;
	ownChild: boolean;
	delivery: RemoteDelivery;
	controller: AbortController;
	timer?: Timer;
	decision: InboundDecision;
}

export class InboundGate {
	readonly #rates = new Map<string, number[]>();
	readonly #repeats = new Map<string, Map<string, number>>();
	readonly #held: HeldMessage[] = [];
	readonly #timers = new ManagedTimers((_event, error) => logger.warn("Messaging timer failed", { error }));

	constructor(
		private readonly host: MessagingHost,
		private readonly settings: Settings,
		private readonly ownShortId: () => string,
		private readonly reply: (sender: SenderInfo, notice: OutgoingNotice, from?: SenderInfo) => Promise<void>,
		private readonly isReady: () => boolean = () => true,
		private readonly ownSender?: () => SenderInfo,
	) {}

	decision(sender: SenderInfo | undefined, ownChild = false): InboundDecision {
		return decideInbound({
			inbound: resolveInbound(this.settings),
			receiver: this.host.permissionClass(),
			sender: sender?.class ?? "unknown",
			ownChild,
		});
	}

	receive(request: MessageRequest, sender: SenderInfo, ownChild: boolean): InboxResponse {
		if (JSON.stringify(request).length > MAX_SERIALIZED_CHARS) return { ok: false, error: "too_large" };
		if (this.#relayLoops(request.chain ?? [])) return { ok: true, outcome: "dropped", reason: "relay_loop" };
		const now = Date.now();
		const key = ownChild ? "own-child" : sender.shortId;
		const repeatWindowStart = now - cfgMessagingRepeatWindowSeconds.get(this.settings) * 1000;
		const repeats = this.#repeats.get(key) ?? new Map<string, number>();
		for (const [body, at] of repeats) {
			if (at <= repeatWindowStart) repeats.delete(body);
		}
		if (repeats.has(request.body)) return { ok: true, outcome: "dropped", reason: "repeat" };
		repeats.set(request.body, now);
		this.#repeats.set(key, repeats);
		const windowStart = now - cfgMessagingRateWindowSeconds.get(this.settings) * 1000;
		const rates = (this.#rates.get(key) ?? []).filter(at => at > windowStart);
		this.#rates.set(key, rates);
		if (rates.length >= cfgMessagingRateLimit.get(this.settings))
			return { ok: true, outcome: "dropped", reason: "rate" };
		rates.push(now);
		return this.#admit(request, sender, ownChild);
	}

	receiveOffline(message: StoredMessage): InboxResponse {
		if (this.#relayLoops(message.chain)) return { ok: true, outcome: "dropped", reason: "relay_loop" };
		return this.#admit({ type: "message", ...message }, message.from, false);
	}

	#relayLoops(chain: readonly string[]): boolean {
		return (
			chain.length >= cfgMessagingRelayMaxHops.get(this.settings) ||
			chain.filter(id => id === this.ownShortId()).length >= cfgMessagingRelayMaxRevisits.get(this.settings)
		);
	}

	#admit(request: MessageRequest, sender: SenderInfo, ownChild: boolean): InboxResponse {
		const decision = this.decision(ownChild ? undefined : request.from, ownChild);
		if (decision === "refuse") return { ok: true, outcome: "refused" };
		const delivery: RemoteDelivery = {
			id: request.id,
			from: { name: sender.name, shortId: sender.shortId, address: sender.name ?? sender.shortId, cwd: sender.cwd },
			body: request.body,
			chain: request.chain ?? [],
			receivedAt: Date.now(),
		};
		if (decision === "accept") {
			if (this.host.pendingRemoteCount() >= ACCEPTED_QUEUE_CAP)
				return { ok: true, outcome: "dropped", reason: "queue_full" };
			const queued = this.host.isBusy() || !this.isReady();
			this.host.deliverRemote([delivery]);
			return { ok: true, outcome: queued ? "queued" : "delivered" };
		}
		const held: HeldMessage = {
			request,
			sender,
			receiver: this.ownSender?.(),
			ownChild,
			delivery,
			controller: new AbortController(),
			decision,
		};
		this.#held.push(held);
		if (this.#held.length > HELD_CAP) {
			const oldest = this.#held[0];
			this.#remove(oldest);
			void this.reply(oldest.sender, {
				type: "notice",
				kind: "dropped",
				reason: "queue_full",
				aboutId: oldest.request.id,
			});
		}
		this.#hold(held);
		return { ok: true, outcome: "held" };
	}

	#hold(held: HeldMessage): void {
		if (held.decision === "hold-explicit") {
			this.host.showNotice(
				`Held message from @${held.delivery.from.address}: ${held.request.body.split(/\r?\n/, 1)[0]}`,
			);
			return;
		}
		const expiry = dialogExpiryMs(this.settings);
		if (expiry !== null)
			held.timer = this.#timers.setTimeout(() => {
				this.#remove(held);
				return this.reply(held.sender, { type: "notice", kind: "expired", aboutId: held.request.id });
			}, expiry);
		const controller = held.controller;
		if (this.host.askApproval) {
			void this.host
				.askApproval({ from: held.delivery.from, body: held.request.body }, controller.signal)
				.then(answer => {
					if (!this.#held.includes(held) || controller.signal.aborted) return;
					this.#remove(held);
					if (answer === "approve") this.#deliverHeld(held);
				})
				.catch(error => {
					if (controller.signal.aborted) return;
					this.#remove(held);
					logger.warn("Messaging approval failed", { error: String(error) });
				});
		}
	}

	#remove(held: HeldMessage): void {
		const index = this.#held.indexOf(held);
		if (index === -1) return;
		this.#held.splice(index, 1);
		if (held.timer) this.#timers.clear(held.timer);
		held.controller.abort();
	}

	#deliverHeld(held: HeldMessage): boolean {
		if (this.host.pendingRemoteCount() >= ACCEPTED_QUEUE_CAP) {
			void this.reply(held.sender, {
				type: "notice",
				kind: "dropped",
				reason: "queue_full",
				aboutId: held.request.id,
			});
			return false;
		}
		this.host.deliverRemote([held.delivery]);
		return true;
	}

	reapplyPolicy(): void {
		let delivered = 0;
		for (const held of [...this.#held]) {
			const decision = this.decision(held.ownChild ? undefined : held.request.from, held.ownChild);
			if (decision === "accept" || decision === "refuse") {
				this.#remove(held);
				if (decision === "accept" && this.#deliverHeld(held)) delivered++;
			} else if (decision !== held.decision) {
				if (held.timer) this.#timers.clear(held.timer);
				held.controller.abort();
				held.controller = new AbortController();
				held.timer = undefined;
				held.decision = decision;
				this.#hold(held);
			}
		}
		if (delivered > 0) this.host.showNotice(`Re-applied inbound rules: delivered ${delivered} held message(s).`);
	}
	async retire(): Promise<void> {
		const held = [...this.#held];
		for (const message of held) this.#remove(message);
		await Promise.all(
			held.map(message =>
				this.reply(
					message.sender,
					{
						type: "notice",
						kind: "retired",
						subject: "message",
						aboutId: message.request.id,
					},
					message.receiver,
				),
			),
		);
	}

	close(): void {
		for (const held of [...this.#held]) this.#remove(held);
		this.#timers.clearAll();
		this.#rates.clear();
		this.#repeats.clear();
	}
}
