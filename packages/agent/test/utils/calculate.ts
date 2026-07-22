import type { AgentTool, AgentToolResult } from "@pk-nerdsaver-ai/pi-agent-core/types";
import { type } from "arktype";

export interface CalculateResult extends AgentToolResult<undefined> {
	content: Array<{ type: "text"; text: string }>;
	details: undefined;
}

type Token = { kind: "number"; value: number } | { kind: "operator"; value: "+" | "-" | "*" | "/" | "%" | "(" | ")" };

const OPERATORS = new Set(["+", "-", "*", "/", "%", "(", ")"]);

function tokenize(expression: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	while (index < expression.length) {
		const char = expression[index]!;
		if (/\s/.test(char)) {
			index += 1;
			continue;
		}
		if (OPERATORS.has(char)) {
			tokens.push({ kind: "operator", value: char as Extract<Token, { kind: "operator" }>["value"] });
			index += 1;
			continue;
		}
		const numberMatch = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(expression.slice(index));
		if (numberMatch) {
			const text = numberMatch[0];
			tokens.push({ kind: "number", value: Number(text) });
			index += text.length;
			continue;
		}
		throw new Error(`Unsupported token at position ${index + 1}: ${char}`);
	}
	if (tokens.length === 0) throw new Error("Expression is empty");
	return tokens;
}

class Parser {
	#position = 0;

	constructor(private readonly tokens: readonly Token[]) {}

	parseExpression(): number {
		const value = this.#parseAdditive();
		if (this.#peek() !== undefined) throw new Error("Unexpected token after expression");
		return value;
	}

	#peek(): Token | undefined {
		return this.tokens[this.#position];
	}

	#consumeOperator(value: string): boolean {
		const token = this.#peek();
		if (token?.kind === "operator" && token.value === value) {
			this.#position += 1;
			return true;
		}
		return false;
	}

	#parseAdditive(): number {
		let value = this.#parseMultiplicative();
		for (;;) {
			if (this.#consumeOperator("+")) value += this.#parseMultiplicative();
			else if (this.#consumeOperator("-")) value -= this.#parseMultiplicative();
			else return value;
		}
	}

	#parseMultiplicative(): number {
		let value = this.#parseUnary();
		for (;;) {
			if (this.#consumeOperator("*")) value *= this.#parseUnary();
			else if (this.#consumeOperator("/")) value /= this.#parseUnary();
			else if (this.#consumeOperator("%")) value %= this.#parseUnary();
			else return value;
		}
	}

	#parseUnary(): number {
		if (this.#consumeOperator("+")) return this.#parseUnary();
		if (this.#consumeOperator("-")) return -this.#parseUnary();
		return this.#parsePrimary();
	}

	#parsePrimary(): number {
		const token = this.#peek();
		if (token?.kind === "number") {
			this.#position += 1;
			if (!Number.isFinite(token.value)) throw new Error("Number is not finite");
			return token.value;
		}
		if (this.#consumeOperator("(")) {
			const value = this.#parseAdditive();
			if (!this.#consumeOperator(")")) throw new Error("Missing closing parenthesis");
			return value;
		}
		throw new Error("Expected a number or parenthesized expression");
	}
}

export function calculate(expression: string): CalculateResult {
	const result = new Parser(tokenize(expression)).parseExpression();
	if (!Number.isFinite(result)) throw new Error("Calculation did not produce a finite number");
	return { content: [{ type: "text", text: `${expression} = ${result}` }], details: undefined };
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
