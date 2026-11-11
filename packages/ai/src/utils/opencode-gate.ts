import { isOpenCodeProvider, withOpenCodeGateTools } from "@oh-my-pi/pi-catalog/wire/opencode";
import type { Api, Context, Model, ToolChoice } from "../types";

/**
 * Pad an OpenCode (Zen/Go) request's tool roster so the gateway's free-tier
 * body gate passes. The gate requires both `bash` and `read` in `tools[]`
 * (case-sensitive; schemas ignored, extras fine) — live-gateway bisection,
 * Oct 2026 ([#12306](https://github.com/can1357/oh-my-pi/issues/12306)).
 *
 * Shared by both dispatch funnels (`stream()` via `streamDispatch` and
 * `streamSimple()` via `streamSimpleRequest`) so tool-less auxiliary calls —
 * advisors, compaction one-shots, title generation — carry the same wire shape
 * as main turns, including on transports that return before the shared
 * dispatch tail. Pads are wire-shape filler, never exposed to the caller's
 * tool registry: they have no exec handler.
 *
 * A padded tool-less call additionally pins `toolChoice` to `"none"` (unless
 * the caller set one) on `openai-completions` only: the caller expects text
 * and a phantom call to a stub would surface as empty text. The pin is
 * gate-neutral (the gate reads `tools[]`, not `tool_choice`) and MUST stay
 * off `openai-responses`, which 400s on anything but `"auto"`. Option types
 * without a `toolChoice` field get tools padded but no pin.
 *
 * The gate also requires `stream: true` (a non-streaming request with an
 * otherwise-valid fingerprint 403s). omp always streams, so this is not
 * enforced here — but no future non-streaming dispatch path may send
 * OpenCode traffic without it.
 *
 * Returns the inputs unchanged (same identity) when nothing needs padding.
 */
export function withOpenCodeGateShape<TContext extends Context, TOptions extends object>(
	model: Model<Api>,
	context: TContext,
	requestOptions: TOptions,
): { context: TContext; requestOptions: TOptions } {
	if (!isOpenCodeProvider(model.provider)) return { context, requestOptions };
	const originalTools = context.tools;
	const paddedTools = withOpenCodeGateTools(originalTools);
	if (paddedTools === originalTools) return { context, requestOptions };
	const nextContext: Context = { ...context, tools: paddedTools };
	if ((originalTools ?? []).length > 0 || model.api !== "openai-completions") {
		return { context: nextContext as TContext, requestOptions };
	}
	const existingChoice = "toolChoice" in requestOptions ? requestOptions.toolChoice : undefined;
	if (existingChoice !== undefined) return { context: nextContext as TContext, requestOptions };
	const toolChoice: ToolChoice = "none";
	return { context: nextContext as TContext, requestOptions: { ...requestOptions, toolChoice } };
}
