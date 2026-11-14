/**
 * The `judge` decision backend: questions go to the native backend the `judge` role resolves to.
 * Policies gate on calibrated probabilities, so a prompted chat or on-device model never stands in
 * for the native judge; without one, the policy reports the judge as unavailable and falls back.
 */
import type { JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { hasNativeJudge, judgeNatively, type NativeJudgmentDeps } from "../judgment";

export type DecisionJudgeDeps = NativeJudgmentDeps;

export type DecisionJudgment<Q extends Questions> =
	| { status: "answered"; result: JudgmentResult<Q> }
	| { status: "unavailable"; reason: "no_native_judge" | "deadline" | "cancelled" | "failed" };

/**
 * Ask the native judge `request` within `deadline` (epoch ms, shared by every call of one
 * evaluation). Never throws: every failure becomes an `unavailable` outcome the policy falls back on.
 */
export async function askDecisionJudge<Q extends Questions>(
	purpose: string,
	request: JudgmentRequest<Q>,
	deps: DecisionJudgeDeps,
	deadline: number,
): Promise<DecisionJudgment<Q>> {
	if (deps.signal?.aborted) return { status: "unavailable", reason: "cancelled" };
	const remaining = deadline - Date.now();
	if (remaining <= 0) return { status: "unavailable", reason: "deadline" };
	if (!hasNativeJudge(deps.settings, deps.registry)) return { status: "unavailable", reason: "no_native_judge" };
	try {
		return { status: "answered", result: await judgeNatively(purpose, request, deps, remaining) };
	} catch (error) {
		if (deps.signal?.aborted) return { status: "unavailable", reason: "cancelled" };
		const timedOut = Date.now() >= deadline || (error instanceof Error && error.name === "TimeoutError");
		logger.debug("decision judge unavailable", {
			purpose,
			error: error instanceof Error ? error.message : String(error),
		});
		return { status: "unavailable", reason: timedOut ? "deadline" : "failed" };
	}
}
