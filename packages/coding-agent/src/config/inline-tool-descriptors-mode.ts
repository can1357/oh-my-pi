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
 * @param provider Optional provider id (e.g. `google-antigravity`).
 */
export function shouldInlineToolDescriptors(
	setting: "auto" | "on" | "off" | undefined,
	modelId: string | undefined,
	provider?: string,
): boolean {
	switch (setting ?? "auto") {
		case "on":
			return true;
		case "off":
			return false;
		default: {
			if (!modelId) return false;
			const effectiveProvider = provider ?? (modelId.includes("/") ? modelId.split("/")[0] : "");
			if (effectiveProvider === "google-antigravity") {
				return false;
			}
			return classifyModel(effectiveProvider, modelId, { lenient: true }).class === "gemini";
		}
	}
}
