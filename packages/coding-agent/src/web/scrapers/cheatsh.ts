import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, loadPage } from "./types";

/**
 * Handle cheat.sh / cht.sh URLs for command cheatsheets
 *
 * API: Plain text at https://cheat.sh/{topic}?T (T flag removes ANSI colors)
 * Supports: commands, language/topic queries (e.g., python/list, go/slice)
 */
export const handleCheatSh: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "cheat.sh" && parsed.hostname !== "cht.sh") return null;

		// Extract topic from path (everything after /)
		const topic = parsed.pathname.slice(1);
		if (!topic || topic === "" || topic === "/") return null;

		const fetchedAt = new Date().toISOString();

		// Fetch from cheat.sh API with ?T to disable ANSI colors
		const apiUrl = `https://cheat.sh/${encodeURIComponent(topic)}?T`;
		const result = await loadPage(apiUrl, {
			timeout,
			signal,
			headers: {
				Accept: "text/plain",
			},
		});

		if (!result.ok || !result.content.trim()) return null;

		// Format the cheatsheet as markdown
		const decodedTopic = decodeURIComponent(topic);
		let md = `# cheat.sh/${decodedTopic}\n\n`;

		// The content is already plain text, wrap in code block for readability
		// Detect if it looks like code/commands vs prose
		const content = result.content.trim();
		const lines = content.split("\n");
		const hasCodeIndicators = lines.some(
			line =>
				line.startsWith("$") ||
				line.startsWith("#") ||
				line.includes("()") ||
				line.includes("=>") ||
				/^\s*(if|for|while|def|func|fn|let|const|var)\b/.test(line),
		);

		if (hasCodeIndicators || decodedTopic.includes("/")) {
			// Likely code examples - use code block
			// Try to detect language from topic
			const lang = decodedTopic.split("/")[0] || "bash";
			md += `\`\`\`${lang}\n${content}\n\`\`\`\n`;
		} else {
			// Command cheatsheet - format as-is (already has good structure)
			md += `\`\`\`\n${content}\n\`\`\`\n`;
		}

		return buildResult(md, { url, method: "cheat.sh", fetchedAt, notes: ["Fetched via cheat.sh"] });
	} catch {}

	return null;
};
