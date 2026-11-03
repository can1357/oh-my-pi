// Type-checked copy of block 1 under "### Command-backed providers" in docs/extensions.md; test/extensibility/doc-snippets.test.ts keeps the two identical.
// The documented helper is the extension's own process code.
declare function runCommandAndPushEvents(...args: unknown[]): Promise<void>;
// ---- documented snippet below, verbatim ----
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("local-command", {
		// Required model metadata; the custom stream does not use this URL.
		baseUrl: "https://command-provider.invalid/",
		apiKey: "unused-by-extension",
		api: "local-command-api",
		streamSimple(model, context, options) {
			const stream = new AssistantMessageEventStream();
			// Spawn the command, translate its output, and push canonical OMP events.
			// The implementation owns process cleanup, cancellation, and errors; the
			// helper needs `context` for the conversation and `options` for `signal`,
			// `cwd`, and the stable `sessionId`.
			void runCommandAndPushEvents(stream, model, context, options);
			return stream;
		},
		models: [
			{
				id: "local-command-model",
				name: "Local command",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16000,
			},
		],
	});
}
