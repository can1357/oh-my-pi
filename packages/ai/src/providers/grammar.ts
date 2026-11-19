export function compactGrammarDefinition(syntax: "lark" | "regex", definition: string): string {
	if (syntax !== "lark") {
		return definition;
	}

	return compactLarkGrammarDefinition(definition);
}

function compactLarkGrammarDefinition(definition: string): string {
	const lines: string[] = [];

	for (const line of definition.split(/\r?\n/)) {
		const uncommented = stripLarkLineComment(line).trimEnd();
		if (uncommented.trim()) {
			lines.push(uncommented);
		}
	}

	return lines.join("\n");
}

function stripLarkLineComment(line: string): string {
	let inString: string | undefined;
	let inRegex = false;
	let escaped = false;

	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		const next = line[i + 1];

		if (escaped) {
			escaped = false;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}

		if (inString) {
			if (char === inString) {
				inString = undefined;
			}
			continue;
		}

		if (inRegex) {
			if (char === "/") {
				inRegex = false;
			}
			continue;
		}

		if (char === "/" && next === "/") {
			return line.slice(0, i);
		}

		if (char === '"' || char === "'") {
			inString = char;
			continue;
		}

		if (char === "/") {
			inRegex = true;
		}
	}

	return line;
}
