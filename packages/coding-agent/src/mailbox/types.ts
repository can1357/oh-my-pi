import { type } from "@oh-my-pi/omptype";

/** One message in a session's mailbox (`<mailboxRoot>/mail/<session>/`); one union member per kind. */
export const SessionMailSchema = type({
	v: "1",
	/** Stable delivery id; the transcript entry carries it, so a delivery is confirmed by finding it there. */
	id: "string > 0",
	kind: "'poke'",
	sessionId: "string",
	createdAt: "string",
	poke: { text: "string", from: "string", "force?": "boolean" },
	/** Injection attempts so far, summed over every consumer that claimed it. */
	"attempts?": "number.integer >= 0",
});
export type SessionMail = typeof SessionMailSchema.infer;

/** Version and kinds this omp delivers: a file that claims one but fails {@link SessionMailSchema} is broken. */
export const KnownMailSchema = type({ v: "1", kind: "'poke'" });

/** What every mail of any version carries: a valid file this omp does not know is left for a newer omp. */
export const MailEnvelopeSchema = type({ v: "number.integer", id: "string > 0", kind: "string" });
