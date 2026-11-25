import type { AssistantMessage, completeSimple } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ImageDescriptions } from "@oh-my-pi/pi-coding-agent/utils/image-vision-fallback";

/**
 * The image descriptions the SDK installs, for tests that build `Agent` and `AgentSession` directly: pass
 * `transform` as the agent's `transformProviderContext` and `descriptions` as the session's
 * `imageDescriptions`. A text-only model gets each input image replaced by `description`, made by a stubbed
 * vision request; `calls` counts those requests.
 */
export function createTestImageDescriptions(options: {
	modelRegistry: ModelRegistry;
	settings: Settings;
	artifactsDir: string;
	description: string;
}): { descriptions: ImageDescriptions; transform: ImageDescriptions["transform"]; calls: unknown[][] } {
	const calls: unknown[][] = [];
	const completeImpl = (async (model, ...rest) => {
		calls.push([model, ...rest]);
		return {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			content: [{ type: "text", text: options.description }],
		} satisfies AssistantMessage;
	}) as typeof completeSimple;
	const descriptions = new ImageDescriptions(() => ({
		modelRegistry: options.modelRegistry,
		settings: options.settings,
		localProtocolOptions: { getArtifactsDir: () => options.artifactsDir, getSessionId: () => "test-session" },
		completeImpl,
	}));
	return { descriptions, transform: descriptions.transform, calls };
}
