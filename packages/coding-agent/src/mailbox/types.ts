/** One message in a session's mailbox (`<mailboxRoot>/mail/<session>/`). */
export interface SessionMail {
	v: 1;
	/** Stable delivery id; the transcript entry carries it, so a delivery is confirmed by finding it there. */
	id: string;
	kind: "poke";
	sessionId: string;
	createdAt: string;
	poke: { text: string; from: string; force?: boolean };
	/** Injection attempts so far, summed over every consumer that claimed it. */
	attempts?: number;
}
