/** Pick a Markdown fence that cannot occur in the supplied exact value. */
export function markdownFenceFor(value: string): string {
	let longestRun = 0;
	let run = 0;
	for (const character of value) {
		if (character === "`") {
			run++;
			if (run > longestRun) longestRun = run;
		} else {
			run = 0;
		}
	}
	return "`".repeat(Math.max(3, longestRun + 1));
}
