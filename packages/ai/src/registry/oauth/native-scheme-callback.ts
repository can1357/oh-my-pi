import { NativeOAuthCallback } from "@oh-my-pi/pi-natives";

/** Native callback lifetime exposed to the provider-independent OAuth flow. */
export interface NativeSchemeCallbackReceiver {
	/** Restore owned settings; native recovery data remains intact on failure. */
	dispose(): Promise<void>;
	/** Wait for a complete URL while forwarding cancellation to native execution. */
	waitForCallback(signal?: AbortSignal, timeoutMs?: number): Promise<string>;
}

/** Cancellation for native callback registration and its active lifetime. */
export interface NativeSchemeCallbackOptions {
	signal?: AbortSignal;
}

/** Connect OAuth's AbortSignals to the native, recoverable desktop callback receiver. */
export async function createNativeSchemeCallbackReceiver(
	scheme: string,
	options: NativeSchemeCallbackOptions = {},
): Promise<NativeSchemeCallbackReceiver | undefined> {
	options.signal?.throwIfAborted();
	const receiver = new NativeOAuthCallback({ scheme });
	const cancel = () => receiver.cancel();
	const detach = () => options.signal?.removeEventListener("abort", cancel);
	options.signal?.addEventListener("abort", cancel, { once: true });
	try {
		if (!(await receiver.start())) {
			await receiver.dispose();
			detach();
			return undefined;
		}
		options.signal?.throwIfAborted();
	} catch (error) {
		try {
			await receiver.dispose();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Native OAuth setup and recovery both failed");
		} finally {
			detach();
		}
		throw error;
	}

	return {
		async dispose() {
			try {
				await receiver.dispose();
			} finally {
				detach();
			}
		},
		async waitForCallback(signal, timeoutMs) {
			signal?.throwIfAborted();
			signal?.addEventListener("abort", cancel, { once: true });
			try {
				return await receiver.waitForCallback(timeoutMs);
			} finally {
				signal?.removeEventListener("abort", cancel);
			}
		},
	};
}
