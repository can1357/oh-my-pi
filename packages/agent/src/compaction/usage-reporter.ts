/**
 * Shared journal for billed compaction-side provider requests.
 *
 * A provider bills a request as soon as it completes, even when the response
 * turns out to be unusable. Every such attempt must reach the session ledger —
 * but an attempt that produced nothing usable is recorded as a *failed*
 * request, so the request log keeps a rejected compaction distinguishable from
 * a working one.
 *
 * Every compaction-side lane reports through this module: the remote V1/V2
 * endpoints, the Anthropic native-compaction request, the handoff oneshot and
 * the advisor's overflow compaction.
 */

import type { AssistantMessage, Model, StopReason, Usage } from "@oh-my-pi/pi-ai";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { RemoteCompactionUsage } from "./remote-usage";

/**
 * Billing metadata for one completed compaction-side provider request.
 *
 * Reported for every attempt the provider billed — including attempts a
 * transient retry discarded and responses the provider rejected.
 */
export type CompactionRequestUsage = Pick<
	AssistantMessage,
	"api" | "provider" | "model" | "usage" | "stopReason" | "errorMessage"
> & { purpose: string };

/** Sink that journals one billed attempt. */
export type CompactionUsageSink = (usage: CompactionRequestUsage) => void;

/**
 * Why a billed attempt produced nothing usable, or undefined when it did.
 *
 * A lane supplies the verdict its payload must satisfy: the Anthropic native
 * compaction needs a signed block, the handoff needs a document.
 */
export type CompactionUsageVerdict = (response: AssistantMessage) => string | undefined;

/** The billed fields of one attempt, before its outcome is classified. */
interface BilledAttempt {
	api: string;
	provider: string;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
}

/**
 * Classify one billed attempt into its ledger record.
 *
 * A rejected attempt is stored as a failed request. A provider error and a
 * cancellation keep their own outcome: a request the provider already failed
 * is a failure, and a cancelled one is neither.
 */
export function compactionUsageRecord(
	attempt: BilledAttempt,
	purpose: string,
	failure?: string,
): CompactionRequestUsage {
	const rejected = failure !== undefined && attempt.stopReason !== "error" && attempt.stopReason !== "aborted";
	return {
		purpose,
		api: attempt.api,
		provider: attempt.provider,
		model: attempt.model,
		usage: attempt.usage,
		stopReason: rejected ? "error" : attempt.stopReason,
		errorMessage: rejected ? (attempt.errorMessage ?? failure) : attempt.errorMessage,
	};
}

/**
 * Build the per-attempt observer for one compaction-side request kind.
 *
 * The observer fires once per completed attempt — including attempts a
 * transient retry discarded and responses the provider rejected — so a host
 * can bill the spend even when the request itself is later abandoned. The
 * verdict classifies an attempt whose payload the lane cannot use.
 *
 * Returns `undefined` when the host does not track usage, so the oneshot keeps
 * its zero-overhead path.
 */
export function compactionUsageObserver(
	options: { onUsage?: CompactionUsageSink } | undefined,
	purpose: string,
	verdict?: CompactionUsageVerdict,
): ((response: AssistantMessage) => void) | undefined {
	if (!options?.onUsage) return undefined;
	return response => {
		options.onUsage?.(
			compactionUsageRecord(
				{
					api: response.api,
					provider: response.provider,
					model: response.model,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: response.errorMessage,
				},
				purpose,
				verdict?.(response),
			),
		);
	};
}

/**
 * Report one billed provider-native compaction request.
 *
 * A provider-native compaction request never goes through a summarization
 * oneshot, so without this the session ledger would omit what the provider
 * billed. The attempt is billed as soon as the provider reports its usage —
 * including an attempt whose payload is later rejected.
 *
 * `failure` names the reason the attempt produced nothing usable; the record
 * is then stored as a failed request rather than a successful one.
 */
export function reportRemoteCompactionUsage(
	options: { onUsage?: CompactionUsageSink } | undefined,
	model: Model,
	reported: RemoteCompactionUsage | undefined,
	purpose: string,
	failure?: string,
): void {
	if (!options?.onUsage || !reported) return;
	// The buckets come from the shared OpenAI accounting path, so a compaction
	// request is billed exactly like the equivalent Responses request — the
	// cache-write and provider-side orchestration buckets included, and the
	// recorded total is the sum of the recorded buckets.
	const usage: Usage = {
		...reported.accounting,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	// A gateway that bills the request itself reports what it charged; the
	// locally computed cost would contradict it, so the reported amount wins.
	if (reported.providerCost) {
		const total = reported.providerCost.total;
		if (total !== undefined) {
			usage.cost = { ...usage.cost, total };
		}
	}
	options.onUsage(
		compactionUsageRecord(
			{ api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop" },
			purpose,
			failure,
		),
	);
}
