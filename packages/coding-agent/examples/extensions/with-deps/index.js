import ms from "ms";
export default function (pi) {
    const z = pi.zod;
    // Register a tool that uses ms
    pi.registerTool({
        name: "parse_duration",
        label: "Parse Duration",
        description: "Parse a human-readable duration string (e.g., '2 days', '1h', '5m') to milliseconds",
        parameters: z.object({
            duration: z.string().describe("Duration string like '2 days', '1h', '5m'"),
        }),
        execute: async (_toolCallId, params) => {
            const result = ms(params.duration);
            if (result === undefined) {
                return {
                    content: [{ type: "text", text: `Invalid duration: "${params.duration}"` }],
                    isError: true,
                    details: {},
                };
            }
            return {
                content: [{ type: "text", text: `${params.duration} = ${result} milliseconds` }],
                details: {},
            };
        },
    });
}
