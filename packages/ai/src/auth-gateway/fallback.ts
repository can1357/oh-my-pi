/**
 * Moving a failed gateway request on to other models: the status rule and the
 * walk over the fallback models that `serve` (through
 * `createAuthGatewayRouter`) and `omp auth-gateway stdio` share.
 */
import type { Api, Model } from "../types";

/**
 * Whether a request whose requested model answered `status` may move on to
 * another model. A status up to 400 is a success or the request's own fault,
 * a 413 a body over the route's limit, and a 499 the caller hanging up:
 * another model would fare no better.
 */
export function shouldTryFallbackModel(status: number): boolean {
	return status > 400 && status !== 413 && status !== 499;
}

/**
 * Answers a request whose requested model failed with `failure`: each of
 * `fallbacks` is tried in turn through `attempt`, and the first that succeeds
 * (a status below 400) is the answer. A fallback that fails, with any status,
 * moves on to the next, since its error says nothing about how the requested
 * model saw the request; `onFailure` reports it. When none succeeds, or
 * `signal` aborts, the requested model's own `failure` is the answer. Every
 * response left unanswered has its body cancelled.
 */
export async function answerWithFallbacks(
	failure: Response,
	fallbacks: readonly Model<Api>[],
	attempt: (model: Model<Api>) => Promise<Response>,
	onFailure: (model: Model<Api>, status: number) => void,
	signal?: AbortSignal,
): Promise<Response> {
	for (const model of fallbacks) {
		if (signal?.aborted) break;
		const response = await attempt(model);
		if (response.status < 400) {
			await failure.body?.cancel().catch(() => undefined);
			return response;
		}
		onFailure(model, response.status);
		await response.body?.cancel().catch(() => undefined);
	}
	return failure;
}
