import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core/types";

export interface CalculateResult extends AgentToolResult<undefined> {
	content: Array<{ type: "text"; text: string }>;
	details: undefined;
}

export function calculate(expression: string): CalculateResult {
	try {
		const result = new Function(`return ${expression}`)();
		return { content: [{ type: "text", text: `${expression} = ${result}` }], details: undefined };
	} catch (e: any) {
		throw new Error(e.message || String(e));
	}
}

const calculateSchema = type({
	expression: "string = 'The mathematical expression to evaluate'",
});

type CalculateParams = typeof calculateSchema.infer;

export const calculateTool: AgentTool<typeof calculateSchema, undefined> = {
	label: "Calculator",
	name: "calculate",
	description: "Evaluate mathematical expressions",
	parameters: calculateSchema,
	execute: async (_toolCallId: string, args: CalculateParams) => {
		return calculate(args.expression);
	},
};
