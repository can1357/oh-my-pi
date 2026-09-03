import { classifyModel } from "@oh-my-pi/pi-catalog/identity";

/**
 * Resolves whether full tool descriptors should be inlined into the system
 * prompt (and stripped from provider tool schemas) for a given model and
 * setting.
 *
 * `auto` enforces a per-model policy: inline for Gemini models, off otherwise.
 * Gemini benefits from descriptors in-prompt; other providers keep them in the
 * tool schemas. `on`/`off` are explicit user overrides.
 *
 * @param modelId Model id (e.g. `gemini-3-pro`) used to classify `auto`.
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
		default:
			return modelId !== undefined && classifyModel("", modelId, { lenient: true }).class === "gemini";
	}
}
