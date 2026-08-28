/**
 * Deadline guard for memory work on the critical path.
 *
 * Recall sits between the user's keystroke and the model call, so a slow or
 * wedged memory backend must degrade into *no memory*, never into a hung turn.
 * `withDeadline` bounds an operation and rejects with a typed error the caller
 * can recognise and swallow, rather than letting an unbounded await through.
 *
 * The timer is always cleared in `finally`, including on the success and the
 * rejection path, so a completed operation never leaves a pending timer holding
 * the process open.
 */

export class DeadlineExceededError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`Memory operation exceeded ${timeoutMs}ms deadline`);
		this.name = "DeadlineExceededError";
	}
}

export async function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
	const expiry = Promise.withResolvers<never>();
	const timer = setTimeout(() => expiry.reject(new DeadlineExceededError(timeoutMs)), timeoutMs);
	try {
		return await Promise.race([operation, expiry.promise]);
	} finally {
		clearTimeout(timer);
	}
}
