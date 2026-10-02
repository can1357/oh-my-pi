/**
 * `/status` and `/sessions` rendering: state markers, the context bar, todo
 * checklists, and markup safety for names and directories that carry
 * markdown-significant characters.
 */
import { describe, expect, it } from "bun:test";
import { sessionListText, statusText, type TelegramStatusState } from "@oh-my-pi/pi-coding-agent/telegram/status";
import type { TopicEntry } from "@oh-my-pi/pi-coding-agent/telegram/types";

const STATE: TelegramStatusState = {
	model: { provider: "anthropic", id: "claude-opus-4" },
	thinkingLevel: "high",
	isStreaming: true,
	queuedMessageCount: 2,
	contextUsage: { tokens: 1100, contextWindow: 200_000, percent: 25 },
	todoPhases: [
		{
			name: "Preparation",
			tasks: [
				{ content: "Collect the facts", status: "completed" },
				{ content: "Fix the renderer", status: "in_progress" },
			],
		},
	],
};

const ENTRY: TopicEntry = {
	threadId: 7,
	name: "Renderer",
	cwd: "/home/dev/code/project",
	status: "running",
	sessionFile: null,
	sessionId: null,
	createdAt: 1,
	updatedAt: 1,
};

const barAt = (percent: number): string => {
	const text = statusText({ contextUsage: { percent } }, { name: "Agent", status: "idle" });
	return /- \*\*Context:\*\* (▰*▱*)/u.exec(text)?.[1] ?? "";
};

describe("status rendering", () => {
	it("renders session state as a header, labelled fields and a context bar", () => {
		const text = statusText(STATE, ENTRY);
		expect(text).toMatch(/^## 🟢 Renderer$/mu);
		expect(text).toContain("- **State:** running");
		expect(text).toContain("- **Directory:** `/home/dev/code/project`");
		expect(text).toContain("- **Model:** `anthropic/claude-opus-4`");
		expect(text).toContain("- **Turn:** running");
		expect(text).toContain("- **Queue:** 2");
		const bar = /- \*\*Context:\*\* (▰+▱+) 25% \(1 100 \/ 200 000\)/u.exec(text);
		expect(bar?.[1]).toHaveLength(10);
		expect([...(bar?.[1] ?? "")].filter(cell => cell === "▰")).toHaveLength(3);
	});

	it("lists todos as a checklist grouped by phase", () => {
		const text = statusText(STATE, ENTRY);
		expect(text).toContain("### Preparation\n- [x] Collect the facts\n- [ ] Fix the renderer");
	});

	it("maps a percentage to ten bar cells and rounds to the nearest one", () => {
		expect(barAt(0)).toBe("▱".repeat(10));
		expect(barAt(5)).toBe(`▰${"▱".repeat(9)}`);
		expect(barAt(50)).toBe(`${"▰".repeat(5)}${"▱".repeat(5)}`);
		expect(barAt(44.1)).toBe(`${"▰".repeat(4)}${"▱".repeat(6)}`);
		expect(barAt(100)).toBe("▰".repeat(10));
	});

	it("gives every known status its own marker and names an unknown one", () => {
		const marker = (status: TopicEntry["status"]): string =>
			/^## (.)/u.exec(statusText(null, { name: "Agent", cwd: "/tmp", status }))?.[1] ?? "";
		expect([marker("running"), marker("idle"), marker("closed"), marker("mirror")]).toEqual(["🟢", "💤", "⚫", "🖥"]);
		const unknown = statusText(null, { name: "Agent", status: "something else" as TopicEntry["status"] });
		expect(unknown).toMatch(/^## ⚪ Agent$/mu);
		expect(unknown).toContain("- **State:** something else");
	});

	it("invents no session data when the session did not answer", () => {
		const text = statusText(null, { name: "Agent", cwd: "/tmp", status: "idle" });
		expect(text).toContain("- **Model:** `—`");
		expect(text).toContain("- **Turn:** none");
		expect(text).toContain("- **Context:** —");
		expect(text).toContain("- **Queue:** 0");
		expect(text).not.toContain("### ");
	});

	it("escapes markup-significant characters in names and directories", () => {
		const text = statusText(null, { name: "star *bold* <b>", cwd: "/tmp/a|b_$", status: "idle" });
		expect(text).not.toContain("<b>");
		expect(text).not.toContain("*bold*");
		expect(text).toContain("\\*bold\\*");
		expect(text).toContain("`/tmp/a|b_$`");
	});

	it("renders the session list as a GFM table with word states and code directories", () => {
		const text = sessionListText([
			{ name: "Renderer", cwd: "/home/dev/a", status: "running" },
			{ name: "Review", cwd: "/home/dev/b", status: "closed" },
			{ name: "Terminal", cwd: "/home/dev/c", status: "mirror" },
		]);
		const [head, rule, ...rows] = text.split("\n");
		expect(head).toBe("| # | Session | State | Directory |");
		expect(rule).toBe("| --- | --- | --- | --- |");
		expect(rows).toHaveLength(3);
		expect(rows[0]).toBe("| 1 | Renderer | 🟢 running | `/home/dev/a` |");
		expect(rows[1]).toContain("⚫ closed");
		expect(rows[2]).toContain("🖥 runs in the terminal");
		expect(sessionListText([])).toBe("No sessions yet: write to the bot to create the first one.");
	});

	it("keeps a table cell intact when a name or directory holds a pipe or a star", () => {
		const [, , row] = sessionListText([{ name: "a|b *c*", cwd: "/tmp/x|y", status: "idle" }]).split("\n");
		expect(row).toBe("| 1 | a\\|b \\*c\\* | 💤 waiting | `/tmp/x\\|y` |");
	});
});
