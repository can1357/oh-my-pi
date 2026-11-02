/**
 * Provider-neutral state of an account past its usage limit, as reported to
 * RPC clients (`get_state.usageLimit`). Any provider that serves work past a
 * limit through a wrap-up allowance or a low-priority lane reports it here;
 * today Claude subscriptions (`session/anthropic-slow-mode.ts`) are the only
 * producer.
 */
export type UsageLimitState =
	| {
			/** Requests are served on the provider's low-priority (slow) lane. */
			stage: "low_priority";
			/** Epoch seconds when the limit that was hit resets. */
			resetsAtSec: number;
			/** Percent of the low-priority allowance still available, when reported. */
			allowanceLeftPercent?: number;
	  }
	| {
			/** Requests run on a short wrap-up allowance past the limit. */
			stage: "wrap_up";
			/** Epoch seconds when the limit that was hit resets, if reported. */
			resetsAtSec?: number;
			/** Whether paid extra usage serves requests once the allowance is spent. */
			extraUsage: boolean;
	  };
