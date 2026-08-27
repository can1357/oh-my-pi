export default function (pi) {
    const z = pi.zod;
    pi.registerTool({
        name: "hello",
        label: "Hello",
        description: "A simple greeting tool",
        parameters: z.object({
            name: z.string().describe("Name to greet"),
        }),
        async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
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
