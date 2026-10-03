/**
 * Await `promise` and return its rejection reason; fail if it resolves.
 *
 * Use instead of `await expect(promise).rejects` when the promise settles from
 * I/O (child-process pipes, RPC responses, CDP sockets). Bun's `.rejects` /
 * `.resolves` wait on a pending promise by spinning the event loop in place;
 * on Windows that spin can stop servicing pipe and socket reads, so the reply
 * never arrives and the test hangs until its timeout. A plain `await` runs the
 * real event loop.
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("Expected promise to reject, but it resolved");
}
