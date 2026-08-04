export interface IrcMessage {
	id: string;
	/** Sender agent id. */
	from: string;
	/** Resolved recipient agent id. Broadcast fan-out stores each concrete recipient. */
	to: string;
	body: string;
	ts: number;
	/** Message id being answered. */
	replyTo?: string;
	/** Shared id across every concrete leg of one `to: all` broadcast. */
	broadcastId?: string;
}

export type IrcDeliveryOutcome = "pending" | "injected" | "woken" | "revived" | "failed";

export interface IrcDeliveryReceipt {
	to: string;
	outcome: Exclude<IrcDeliveryOutcome, "pending">;
	error?: string;
}

export interface IrcHistoryRecord {
	message: IrcMessage;
	outcome: IrcDeliveryOutcome;
	error?: string;
	updatedAt: number;
}

export interface IrcReadCursor {
	timestamp: number;
	messageId: string;
}

export type IrcHistoryEvent =
	| { type: "irc"; v: 1; event: "message"; message: IrcMessage }
	| {
			type: "irc";
			v: 1;
			event: "delivery";
			messageId: string;
			outcome: Exclude<IrcDeliveryOutcome, "pending">;
			error?: string;
			ts: number;
	  };
