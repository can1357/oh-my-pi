const factory = pi => ({
    name: "hello",
    label: "Hello",
    description: "A simple greeting tool",
    parameters: pi.zod.object({
        name: pi.zod.string().describe("Name to greet"),
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
