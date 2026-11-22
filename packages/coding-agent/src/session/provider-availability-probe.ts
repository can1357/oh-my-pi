import { completeSimple } from "@oh-my-pi/pi-ai/stream";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import type { ModelRegistry } from "../config/model-registry";
import { withModelDiscoveryTimeout } from "../config/model-provider-discovery";
import probePrompt from "../prompts/system/provider-availability-probe.md" with { type: "text" };

/** A real bounded inference, deliberately reading catalog identity rather than availability. */
export async function probeProviderInference(registry: ModelRegistry, provider: string): Promise<boolean> {
	const candidates = registry
		.getProviderModels(provider)
		.filter(model => modelKind(model) === "chat")
		.sort((left, right) => left.cost.input + left.cost.output - right.cost.input - right.cost.output);
	const model = candidates[0];
	if (!model) return false;
	const controller = new AbortController();
	try {
		return await withModelDiscoveryTimeout(15_000, async () => {
			const apiKey = await registry.getApiKey(model, undefined, { signal: controller.signal });
			if (!apiKey) return false;
			const result = await completeSimple(
				model,
				{
					messages: [{ role: "user", content: probePrompt, timestamp: Date.now() }],
				},
				{
					apiKey,
					headers: await registry.getProviderHeaders(provider),
					maxTokens: 1,
					disableReasoning: true,
					signal: controller.signal,
				},
			);
			return result.stopReason !== "error" && result.stopReason !== "aborted";
		});
	} finally {
		controller.abort();
	}
}
