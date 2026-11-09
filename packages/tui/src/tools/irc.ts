/** Peer-message types and roster constants shared by messaging, `wait`, and child prompts. */

/** Maximum live peer rows embedded in child prompts. */
export const DEFAULT_PEER_ROSTER_LIMIT = 32;

/** Serializable peer message retained in coordination result snapshots. */
export interface IrcMessage {
	id: string;
	/** Sender agent id. */
	from: string;
	/** Recipient agent id (resolved; "all" is expanded by the tool, not stored). */
	to: string;
	body: string;
	ts: number;
	/** Message id being answered. */
	replyTo?: string;
	/**
	 * Automated wake-turn relay of a woken subagent's stop output (task executor
	 * `relayWakeTurnOutput`). Relays are answers, never wake sources: the
	 * recipient's own wake-turn relay must skip them or two idle peers
	 * ping-pong forever.
	 */
	wakeRelay?: boolean;
	/**
	 * One leg of an `all` broadcast. Like relays, broadcasts never draw an
	 * automatic wake-turn reply: every woken idle peer would otherwise answer
	 * the broadcaster, mostly to say the message was not for it.
	 */
	broadcast?: boolean;
	/**
	 * Interim acknowledgement or progress on something the recipient asked
	 * (`agent://<id>?progress`): it neither answers that request nor asks one,
	 * so the recipient's `wait` keeps waiting for the actual reply.
	 */
	progress?: boolean;
	/**
	 * Non-request team notification: no reply or automatic wake-turn relay is
	 * owed. A notice addressed to the recipient can end its wait, even when
	 * `progress` is set. Independent of the `teamControl` rate exemption.
	 */
	teamNotice?: boolean;
	/**
	 * A delivery from outside the agent tree — the A2A bridge. Each such message
	 * is one authenticated client request identified by its A2A `messageId`, so
	 * the agent-loop ingress policy does not apply: identical text is a new
	 * request, not a repetition loop, and the bridge's loopback-plus-bearer
	 * boundary is its own throttle. Set by `a2a/rpc.ts`; agents never set it.
	 */
	external?: boolean;
	/**
	 * Runtime-authored team traffic — stop requests and notices sent on behalf
	 * of a member (idle, decline/timeout, plan approval/rejection) — bypasses
	 * sender rate charging only; agent-authored plan submissions do not. This
	 * flag implies no request or relay semantics; `teamNotice` marks
	 * non-request notices.
	 */
	teamControl?: boolean;
	/** Original A2A message id for an external request, distinct from the IRC bus id. */
	a2aMessageId?: string;
	/**
	 * On an `external` delivery that answers an A2A request this terminal sent:
	 * that request's `messageId`. An answer owes no reply. Set by `a2a/rpc.ts`.
	 */
	a2aInReplyTo?: string;
	/**
	 * Senders this message passed through, oldest first, ending with the agent
	 * that sent it: the bus appends the sender's own id on every send, and an
	 * automatic wake relay hands the received chain on (a manual reply starts a
	 * fresh one). A chain longer than the ingress guard's `irc.maxHops` is
	 * refused, so automated agent loops cannot grow without bound.
	 */
	hops?: string[];
}

/** Delivery outcome for one peer recipient. */
export interface IrcDeliveryReceipt {
	to: string;
	outcome: "injected" | "woken" | "revived" | "failed";
	error?: string;
}
/** Status ordering for peer rosters in child prompts. */
export const LIST_STATUS_ORDER: Record<string, number> = { running: 0, idle: 1, parked: 2 };
