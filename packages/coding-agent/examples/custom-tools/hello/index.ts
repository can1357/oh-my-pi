import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

const factory: CustomToolFactory = (pi) => ({
	name: "hello",
	label: "Hello",
	description: "A simple greeting tool",
	parameters: pi.typebox.Type.Object({
		name: pi.typebox.Type.String({ description: "Name to greet" }),
	}),

	async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
		const { name } = params;
		return {
			content: [{ type: "text", text: `Hello, ${name}!` }],
			details: { greeted: name },
		};
	},
});

export default factory;
