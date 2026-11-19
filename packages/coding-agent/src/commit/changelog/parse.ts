import type { UnreleasedSection } from "../../commit/types";

const UNRELEASED_PATTERN = /^##\s+\[?Unreleased\]?/i;
const SECTION_PATTERN = /^###\s+(.*)$/;

export function parseUnreleasedSection(content: string): UnreleasedSection {
	const lines = content.split("\n");
	const startIndex = lines.findIndex(line => UNRELEASED_PATTERN.test(line.trim()));
	if (startIndex === -1) {
		throw new Error("No [Unreleased] section found in changelog");
	}

	let endIndex = lines.length;
	for (let i = startIndex + 1; i < lines.length; i += 1) {
		if (lines[i]?.startsWith("## ")) {
			endIndex = i;
			break;
		}
	}

	const sectionLines = lines.slice(startIndex + 1, endIndex);
	const entries: Record<string, string[]> = {};
	let currentSection: string | null = null;
	for (const line of sectionLines) {
		const sectionMatch = line.match(SECTION_PATTERN);
		if (sectionMatch) {
			currentSection = sectionMatch[1]?.trim() || null;
			if (currentSection) {
				entries[currentSection] = entries[currentSection] ?? [];
			}
			continue;
		}

		if (!currentSection) continue;
		const trimmed = line.trim();
		if (!trimmed.startsWith("-")) continue;
		const entry = trimmed.replace(/^[-*]\s*/, "");
		if (entry) {
			entries[currentSection]?.push(entry);
		}
	}

	return { startLine: startIndex, endLine: endIndex, entries };
}
