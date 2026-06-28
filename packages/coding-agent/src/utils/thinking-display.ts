export function canonicalizeMessage(text: string | null | undefined): string {
	if (!text) return "";
	const trimmed = text.trim();
	for (let i = 0; i < trimmed.length; i++) {
		const code = trimmed.charCodeAt(i);
		if (code !== 0x2e && code !== 0x2026 && code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
			return trimmed;
		}
	}
	return "";
}

export function formatThinkingForDisplay(text: string, proseOnly: boolean): string {
	if (!proseOnly || !text) return text;

	const lines = text.split("\n");
	const resultLines: string[] = [];
	let inFence = false;
	let fenceChar = "";
	let fenceLen = 0;

	const FENCE = /^( {0,3})([`~]{3,})/;
	const appendEllipsis = () => {
		let lastLineIdx = resultLines.length - 1;
		while (lastLineIdx >= 0 && resultLines[lastLineIdx]!.trim() === "") {
			lastLineIdx--;
		}

		if (lastLineIdx >= 0) {
			const lastLine = resultLines[lastLineIdx]!;
			const trimmed = lastLine.trimEnd();
			if (trimmed.endsWith("...")) {
				resultLines[lastLineIdx] = trimmed;
			} else if (trimmed.endsWith(".")) {
				resultLines[lastLineIdx] = `${trimmed.slice(0, -1)}...`;
			} else {
				resultLines[lastLineIdx] = `${trimmed}...`;
			}
		} else {
			resultLines.push("...");
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const open = FENCE.exec(line);

		if (inFence) {
			// A closing fence is the same char, at least as long, with nothing else on the line.
			if (
				open &&
				open[2]![0] === fenceChar &&
				open[2]!.length >= fenceLen &&
				line.slice(open[1]!.length + open[2]!.length).trim() === ""
			) {
				inFence = false;
				fenceChar = "";
				fenceLen = 0;
			}
			// We skip all internal lines of a code fence.
		} else if (open) {
			const marker = open[2]!;
			const ch = marker[0]!;
			// A backtick fence's info string may not contain a backtick.
			if (!(ch === "`" && line.slice(open[1]!.length + marker.length).includes("`"))) {
				inFence = true;
				fenceChar = ch;
				fenceLen = marker.length;
				appendEllipsis();
			} else {
				resultLines.push(line);
			}
		} else {
			resultLines.push(line);
		}
	}

	const formatted = resultLines.join("\n");
	return formatted;
}

export function hasDisplayableThinking(
	text: string | null | undefined,
	formattedText: string | null | undefined,
): boolean {
	if (!text) return false;
	if (!formattedText) return false;
	return formattedText.length > 0 && canonicalizeMessage(text).length > 0;
}
