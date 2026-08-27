/**
 * `promptProfile: "compact"` swaps the bundled instruction template for a short
 * one. It must keep every generated surface — skills, rules, context files,
 * tool inventory, the `xd://` protocol — because those are what makes the
 * prompt dynamic; only the fixed prose gets shorter. A custom `SYSTEM.md`
 * replaces the template outright and therefore ignores the profile.
 */
import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";

const EMPTY_TREE = { rootPath: "", rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] };

// Lines unique to the default instruction template.
const FULL_ONLY = ["# Engineering", "# 2. Research Before Editing", "# Exploration", "<completeness>"];

async function render(options: Parameters<typeof buildSystemPrompt>[0] = {}): Promise<string> {
	const { systemPrompt } = await buildSystemPrompt({
		cwd: "/tmp",
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: ["read", "write", "bash", "grep"],
		personality: "none",
		workspaceTree: { ...EMPTY_TREE, rootPath: "/tmp" },
		...options,
	});
	return systemPrompt.join("\n\n");
}

describe("promptProfile", () => {
	it("defaults to the full template", async () => {
		const rendered = await render();
		for (const marker of FULL_ONLY) expect(rendered).toContain(marker);
	});

	it("drops the long prose under the compact profile", async () => {
		const rendered = await render({ promptProfile: "compact" });
		for (const marker of FULL_ONLY) expect(rendered).not.toContain(marker);
		expect(rendered).toContain("§ Critical");
		expect(rendered).toContain("§ Delivery");
	});

	it("is materially shorter than the full template on the same inputs", async () => {
		const full = await render({ promptProfile: "full" });
		const compact = await render({ promptProfile: "compact" });
		expect(compact.length).toBeLessThan(full.length * 0.75);
	});

	it("keeps skills, rules, and the xd:// protocol section", async () => {
		const rendered = await render({
			promptProfile: "compact",
			skills: [
				{
					name: "deploy",
					description: "How to ship",
					filePath: "/tmp/deploy/SKILL.md",
					baseDir: "/tmp",
					source: "native",
				},
			],
			rules: [{ name: "api", description: "API conventions", path: "/tmp/api.md", globs: ["src/api/**"] }],
			xdevTools: [{ name: "lsp", summary: "Language server" }],
		} as Parameters<typeof buildSystemPrompt>[0]);
		expect(rendered).toContain("deploy: How to ship");
		expect(rendered).toContain("api");
		expect(rendered).toContain("xd://");
	});

	it("ignores the profile when a custom system prompt is active", async () => {
		const marker = "You are a code reviewer and never edit files.";
		const rendered = await render({ promptProfile: "compact", resolvedCustomPrompt: marker });
		expect(rendered).toContain(marker);
		for (const full of FULL_ONLY) expect(rendered).not.toContain(full);
	});
});
