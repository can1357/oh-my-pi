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
	| { status: "slow_down" }
	| { status: "failed"; message: string };

/** Options for polling an RFC 8628-style OAuth device-code flow. */
export interface OAuthDeviceCodeFlowOptions<T> {
	/** Poll the provider once and classify the response. */
	poll(): OAuthDeviceCodePollResult<T> | Promise<OAuthDeviceCodePollResult<T>>;
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
		const result = await options.poll();
		if (result.status === "complete") {
			return result.value;
		}
		if (result.status === "failed") {
			throw new AIError.OAuthError(result.message, { kind: "polling" });
		}
		if (result.status === "slow_down") {
			slowDownResponses += 1;
			intervalMs = Math.max(MINIMUM_DEVICE_FLOW_INTERVAL_MS, intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS);
		}

		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			break;
		}
		await abortableDeviceFlowSleep(Math.min(intervalMs, remainingMs), options.signal);
	}

	throw new AIError.OAuthError(
		slowDownResponses > 0 ? DEVICE_FLOW_SLOW_DOWN_TIMEOUT_MESSAGE : DEVICE_FLOW_TIMEOUT_MESSAGE,
		{ kind: "timeout" },
	);
}
