export interface ParseCommandArgsOptions {
	rejectUnterminatedQuotes?: boolean;
	escapeQuotes?: boolean;
}

export function parseCommandArgs(argsString: string, options?: ParseCommandArgsOptions): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;
	const escapeQuotes = options?.escapeQuotes ?? false;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else if (escapeQuotes && char === "\\" && i + 1 < argsString.length && argsString[i + 1] === inQuote) {
				current += argsString[++i];
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (
			escapeQuotes &&
			char === "\\" &&
			i + 1 < argsString.length &&
			(argsString[i + 1] === '"' || argsString[i + 1] === "'")
		) {
			current += argsString[++i];
		} else if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (inQuote && options?.rejectUnterminatedQuotes) {
		throw new Error("Unterminated quote in command arguments");
	}

	if (current) {
		args.push(current);
	}

	return args;
}

/**
 * Substitute argument placeholders in template content
 * Supports $1, $2, ... for positional args, $@ and $ARGUMENTS for all args
 *
 * Note: Replacement happens on the template string only. Argument values
 * containing patterns like $1, $@, or $ARGUMENTS are NOT recursively substituted.
 */
export function substituteArgs(content: string, args: string[]): string {
	const allArgs = args.join(" ");

	return content.replace(
		/\$@\[(\d+)(?::(\d*)?)?\]|\$ARGUMENTS|\$@|\$(\d+)/g,
		(match, startRaw?: string, lengthRaw?: string, positionalNum?: string) => {
			if (positionalNum !== undefined) {
				const index = Number.parseInt(positionalNum, 10) - 1;
				return args[index] ?? "";
			}

			if (startRaw !== undefined) {
				const start = Number.parseInt(startRaw, 10);
				if (!Number.isFinite(start) || start < 1) return "";
				const startIndex = start - 1;
				if (startIndex >= args.length) return "";

				if (lengthRaw === undefined || lengthRaw === "") {
					return args.slice(startIndex).join(" ");
				}

				const length = Number.parseInt(lengthRaw, 10);
				if (!Number.isFinite(length) || length <= 0) return "";
				return args.slice(startIndex, startIndex + length).join(" ");
			}

			if (match === "$ARGUMENTS" || match === "$@") {
				return allArgs;
			}

			return match;
		},
	);
}
