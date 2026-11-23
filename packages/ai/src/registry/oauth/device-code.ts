import * as AIError from "../../error";

const DEVICE_FLOW_CANCEL_MESSAGE = "Login cancelled";
const DEVICE_FLOW_TIMEOUT_MESSAGE = "Device flow timed out";
const DEVICE_FLOW_SLOW_DOWN_TIMEOUT_MESSAGE =
	"Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.";
const MINIMUM_DEVICE_FLOW_INTERVAL_MS = 1000;
const DEFAULT_DEVICE_FLOW_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;

/** Result returned by one OAuth device-code polling attempt. */
export type OAuthDeviceCodePollResult<T> =
	| { status: "complete"; value: T }
	| { status: "pending" }
	/**
	 * Provider asked to poll less often. Without `retryAfterMs` the interval grows by five
	 * seconds (RFC 8628); with it only the next wait stretches to at least `retryAfterMs`.
	 */
	| { status: "slow_down"; retryAfterMs?: number }
	| { status: "failed"; message: string };

/** Options for polling an RFC 8628-style OAuth device-code flow. */
export interface OAuthDeviceCodeFlowOptions<T> {
	/** Poll the provider once and classify the response. Signal includes caller cancellation and device-code expiry. */
	poll(signal?: AbortSignal): OAuthDeviceCodePollResult<T> | Promise<OAuthDeviceCodePollResult<T>>;
	/** Provider-requested polling cadence; defaults to RFC 8628's five seconds. */
	intervalSeconds?: number;
	/** Provider-issued expiry window for the device code. */
	expiresInSeconds?: number;
	/** Cancels the flow with the legacy "Login cancelled" error. */
	signal?: AbortSignal;
}

async function abortableDeviceFlowSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (!signal) {
		await Bun.sleep(ms);
		return;
	}
	if (signal.aborted) {
		throw new AIError.LoginCancelledError(DEVICE_FLOW_CANCEL_MESSAGE);
	}

	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const onAbort = () => {
		clearTimeout(timer);
		reject(new AIError.LoginCancelledError(DEVICE_FLOW_CANCEL_MESSAGE));
	};
	const timer = setTimeout(() => {
		signal.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	signal.addEventListener("abort", onAbort, { once: true });
	await promise;
}

/** Poll an OAuth device-code flow until completion, provider failure, timeout, or cancellation. */
export async function pollOAuthDeviceCodeFlow<T>(options: OAuthDeviceCodeFlowOptions<T>): Promise<T> {
	const deadline =
		typeof options.expiresInSeconds === "number"
			? Date.now() + options.expiresInSeconds * 1000
			: Number.POSITIVE_INFINITY;
	let intervalMs = Math.max(
		MINIMUM_DEVICE_FLOW_INTERVAL_MS,
		Math.floor((options.intervalSeconds ?? DEFAULT_DEVICE_FLOW_INTERVAL_SECONDS) * 1000),
	);
	let slowDownResponses = 0;

	while (Date.now() < deadline) {
		if (options.signal?.aborted) {
			throw new AIError.LoginCancelledError(DEVICE_FLOW_CANCEL_MESSAGE);
		}
		const deadlineSignal = Number.isFinite(deadline)
			? AbortSignal.timeout(Math.max(0, deadline - Date.now()))
			: undefined;
		const pollSignal =
			options.signal && deadlineSignal
				? AbortSignal.any([options.signal, deadlineSignal])
				: (options.signal ?? deadlineSignal);
		let result: OAuthDeviceCodePollResult<T>;
		try {
			result = await options.poll(pollSignal);
		} catch (error) {
			if (options.signal?.aborted) throw new AIError.LoginCancelledError(DEVICE_FLOW_CANCEL_MESSAGE);
			if (Date.now() >= deadline) break;
			throw error;
		}
		if (options.signal?.aborted) throw new AIError.LoginCancelledError(DEVICE_FLOW_CANCEL_MESSAGE);
		if (result.status === "complete") {
			return result.value;
		}
		if (Date.now() >= deadline) break;
		if (result.status === "failed") {
			throw new AIError.OAuthError(result.message, { kind: "polling" });
		}
		let waitMs = intervalMs;
		if (result.status === "slow_down") {
			if (result.retryAfterMs === undefined) {
				slowDownResponses += 1;
				intervalMs = Math.max(MINIMUM_DEVICE_FLOW_INTERVAL_MS, intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS);
				waitMs = intervalMs;
			} else {
				waitMs = Math.max(intervalMs, result.retryAfterMs);
			}
		}

		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			break;
		}
		await abortableDeviceFlowSleep(Math.min(waitMs, remainingMs), options.signal);
	}

	throw new AIError.OAuthError(
		slowDownResponses > 0 ? DEVICE_FLOW_SLOW_DOWN_TIMEOUT_MESSAGE : DEVICE_FLOW_TIMEOUT_MESSAGE,
		{ kind: "timeout" },
	);
}
