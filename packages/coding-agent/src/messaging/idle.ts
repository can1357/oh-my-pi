import { logger } from "@oh-my-pi/pi-utils";
import { ManagedTimers } from "../extensibility/extensions/managed-timers";
import type { OutgoingNotice } from "./inbound";
import type { InboundDecision } from "./policy";
import { type DropReason, IDLE_SUBSCRIPTION_TTL_MS, type InboxRequest, type SenderInfo } from "./protocol";
import type { MessagingHost, RemoteSender } from "./service";

type NoticeRequest = Extract<InboxRequest, { type: "notice" }>;

export function droppedMessageText(address: string, reason: DropReason): string {
	const reasons: Record<DropReason, string> = {
		queue_full: "its queue of undelivered peer messages was full",
		rate: "you sent faster than that session accepts",
		repeat: "it repeated your previous message",
		relay_loop: "a relay loop between sessions was cut",
	};
	return `Cross-session message was dropped at the recipient session's inbox (recipient: ${address}) and not delivered — ${reasons[reason]}. Do not resend right away.`;
}

export class IdleSubscriptions {
	readonly #watched = new Map<string, { sender: SenderInfo; receiver: SenderInfo | undefined; id: string }>();
	readonly #asking = new Map<string, { timer: Timer; target: RemoteSender; id: string }>();
	readonly #timers = new ManagedTimers((_event, error) => logger.warn("Messaging timer failed", { error }));

	constructor(
		private readonly host: MessagingHost,
		private readonly decision: (sender: SenderInfo) => InboundDecision,
		private readonly reply: (sender: SenderInfo, notice: OutgoingNotice, from?: SenderInfo) => Promise<void>,
		private readonly ownSender?: () => SenderInfo,
	) {}

	subscribe(sender: SenderInfo, id: string): void {
		const decision = this.decision(sender);
		if (decision === "refuse") return;
		this.#watched.set(sender.entryId, {
			sender,
			receiver: this.ownSender?.(),
			id,
		});
		this.host.showNotice(`@${sender.name ?? sender.shortId} asked to be told when this session is next idle.`);
		if (!this.host.isBusy()) void this.#flush("idle");
	}

	arm(entryId: string, target: RemoteSender, id: string): void {
		this.cancel(entryId);
		const timer = this.#timers.setTimeout(() => {
			this.#asking.delete(entryId);
			const own = this.ownSender?.();
			const decision = own ? this.decision(own) : "accept";
			const text = `No idle notice from @${target.address} within 12 hours; the subscription was dropped.`;
			if (decision === "accept") void this.host.deliverNotice(target, text, this.host.sessionId());
			else if (decision !== "refuse") this.host.showNotice(text);
		}, IDLE_SUBSCRIPTION_TTL_MS);
		this.#asking.set(entryId, { timer, target, id });
	}

	cancel(entryId: string, id?: string): void {
		const asking = this.#asking.get(entryId);
		if (!asking || (id !== undefined && asking.id !== id)) return;
		this.#timers.clear(asking.timer);
		this.#asking.delete(entryId);
	}

	receive(notice: NoticeRequest): void {
		const from: RemoteSender = {
			name: notice.from.name,
			shortId: notice.from.shortId,
			address: notice.from.name ?? notice.from.shortId,
			cwd: notice.from.cwd,
		};
		if (notice.kind === "retired" && notice.subject === "subscription") {
			const asking = this.#asking.get(notice.from.entryId);
			if (notice.aboutId === undefined || asking?.id !== notice.aboutId) return;
			this.cancel(notice.from.entryId, notice.aboutId);
			const decision = this.decision(notice.from);
			const text = `@${from.address} switched to a different conversation; the idle notice was cancelled.`;
			if (decision === "accept") void this.host.deliverNotice(from, text, this.host.sessionId());
			else if (decision !== "refuse") this.host.showNotice(text);
			return;
		}
		if (notice.kind === "idle" || notice.kind === "exited") {
			const asking = this.#asking.get(notice.from.entryId);
			if (notice.aboutId !== undefined && asking?.id !== notice.aboutId) return;
			this.cancel(notice.from.entryId, notice.aboutId);
			const finished = new Date(notice.finishedAt ?? Date.now());
			const time = `${String(finished.getHours()).padStart(2, "0")}:${String(finished.getMinutes()).padStart(2, "0")}`;
			const text =
				notice.kind === "exited"
					? `@${from.address} exited.`
					: `@${from.address} is idle (turn finished ${time})${notice.status ? `: ${notice.status}` : "."}`;
			const decision = this.decision(notice.from);
			if (decision === "accept") void this.host.deliverNotice(from, text, this.host.sessionId());
			else if (decision !== "refuse") this.host.showNotice(text);
		}
	}

	turnSettledIdle(): void {
		void this.#flush("idle");
	}

	async #flush(kind: "idle" | "exited" | "retired"): Promise<void> {
		const subscribers = [...this.#watched.values()];
		this.#watched.clear();
		const finished = this.host.lastFinished();
		await Promise.all(
			subscribers.map(({ sender, receiver, id }) => {
				const decision = this.decision(sender);
				if (decision === "refuse") return;
				return this.reply(
					sender,
					{
						type: "notice",
						kind,
						aboutId: id,
						...(kind === "retired" ? { subject: "subscription" as const } : {}),
						...(kind === "idle"
							? {
									finishedAt: finished?.finishedAt ?? Date.now(),
									...(decision === "accept" && finished?.status !== null && finished?.status !== undefined
										? { status: finished.status }
										: {}),
								}
							: {}),
					},
					kind === "retired" ? receiver : undefined,
				);
			}),
		);
	}

	async retire(): Promise<void> {
		this.#timers.clearAll();
		this.#asking.clear();
		await this.#flush("retired");
	}

	async close(): Promise<void> {
		this.#timers.clearAll();
		this.#asking.clear();
		await this.#flush("exited");
	}
}
