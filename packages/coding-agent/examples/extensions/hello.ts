/**
 * Hello Tool - Minimal custom tool example
 *
 * Demonstrates using ExtensionAPI's logger and injected schema builder.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const type = pi.arktype;
	const parameters = type({
		name: type.string.describe("Name to greet"),
	});

	pi.registerTool<typeof parameters>({
		name: "hello",
		label: "Hello",
		description: "A simple greeting tool",
		parameters,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { name } = params;

			// Use logger for debugging
			pi.logger.debug("Hello tool executed", { name });

			return {
				content: [{ type: "text", text: `Hello, ${name}!` }],
				details: { greeted: name },
			};
		},
	});
}
