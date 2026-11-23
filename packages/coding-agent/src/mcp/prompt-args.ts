import type { MCPPromptArgument } from "./types";

/**
 * Build a `prompts/get` argument map from the tokens a user typed after a prompt command.
 *
 * A `key=value` token lands under its own name, as before. The remaining positional tokens fill the
 * prompt's declared arguments in declaration order, skipping any name a `key=value` token already
 * set, so a prompt that declares `arguments: [{ name: "path" }]` receives `/server:prompt src/app.ts`
 * as `{ path: "src/app.ts" }` instead of nothing. Positionals past the last free declared argument
 * are ignored, as they were before.
 *
 * The map is accumulated on a null prototype: a declared argument named `toString`, `constructor` or
 * `__proto__` is a plain key, not an inherited property and not a prototype write.
 */
export function mapPromptArguments(
	declared: readonly MCPPromptArgument[] | undefined,
	tokens: readonly string[],
): Record<string, string> {
	const named: Record<string, string> = Object.create(null);
	const positional: string[] = [];
	for (const token of tokens) {
		const eqIdx = token.indexOf("=");
		if (eqIdx > 0) {
			named[token.slice(0, eqIdx)] = token.slice(eqIdx + 1);
		} else if (token) {
			positional.push(token);
		}
	}

	const slots = (declared ?? []).map(argument => argument.name);
	let slot = 0;
	for (const value of positional) {
		let name = slots[slot];
		while (name !== undefined && Object.hasOwn(named, name)) {
			slot += 1;
			name = slots[slot];
		}
		if (name === undefined) break;
		named[name] = value;
		slot += 1;
	}
	return { ...named };
}
