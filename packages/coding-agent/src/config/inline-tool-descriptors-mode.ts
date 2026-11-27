import type { CatalogPolicyInputs } from "@oh-my-pi/pi-catalog";
import { resolveCatalogPolicy } from "@oh-my-pi/pi-catalog/compat/catalog-policy";
import { classifyModel } from "@oh-my-pi/pi-catalog/identity";

/**
 * Determines whether to move tool descriptions from tool schemas into the system prompt.
 * In `auto` mode, a catalog rule takes precedence over the Gemini family default.
 * Explicit `on` and `off` settings take precedence.
 */
export function shouldInlineToolDescriptors(
	setting: "auto" | "on" | "off" | undefined,
	model: CatalogPolicyInputs | undefined,
): boolean {
	switch (setting ?? "auto") {
		case "on":
			return true;
		case "off":
			return false;
		default: {
			if (!model) return false;
			const policy = resolveCatalogPolicy(model).inlineToolDescriptors;
			return typeof policy === "boolean"
				? policy
				: classifyModel("", model.id, { lenient: true }).class === "gemini";
		}
	}
}
