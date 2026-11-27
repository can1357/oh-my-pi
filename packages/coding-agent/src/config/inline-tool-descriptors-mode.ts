import { classifyModel } from "@oh-my-pi/pi-catalog/identity";

/**
 * Resolves whether full tool descriptors should be inlined into the system
 * prompt (and stripped from provider tool schemas) for a given model and
 * setting.
 *
 * `auto` enforces a per-model policy: inline for Gemini models, off otherwise.
 * Gemini benefits from descriptors in-prompt; other providers keep them in the
 * tool schemas. Antigravity (Cloud Code Assist) models are exempt in `auto`:
 * both transports (`antigravity-cli` via agy, `google-antigravity` direct)
 * already send tool schemas in `request.tools`, and the backend rejects large
 * non-official system prompts with HTTP 429 RESOURCE_EXHAUSTED on
 * `streamGenerateContent` once the rendered prompt grows past roughly 20k
 * characters, so the inlined catalog only inflates the prompt. `on`/`off` are
 * explicit user overrides.
 *
 * @param modelId Model id (e.g. `gemini-3-pro`, `antigravity-cli/gemini-4-neon`)
 * used to classify `auto`.
 */
export function shouldInlineToolDescriptors(
	setting: "auto" | "on" | "off" | undefined,
	modelId: string | undefined,
): boolean {
	switch (setting ?? "auto") {
		case "on":
			return true;
		case "off":
			return false;
		default: {
			if (modelId === undefined) return false;
			const provider = modelId.split("/")[0];
			if (provider.includes("antigravity")) return false;
			return classifyModel("", modelId, { lenient: true }).class === "gemini";
		}
	}
}
