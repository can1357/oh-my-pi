/**
 * Reduced context profiles swap the bundled instruction template for a short
 * one and replace the eager skill inventory with bounded `skill://` discovery.
 * Full remains the compatibility baseline: making the setting explicit must
 * produce the exact provider-facing bytes emitted by the default.
 */
import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";

const EMPTY_TREE = { rootPath: "", rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] };

// Lines unique to the default instruction template.
const FULL_ONLY = ["# Engineering", "# 2. Research Before Editing", "# Exploration", "<completeness>"];

async function build(options: Parameters<typeof buildSystemPrompt>[0] = {}) {
	return await buildSystemPrompt({
		cwd: "/tmp",
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: ["read", "write", "bash", "grep"],
		personality: "none",
		workspaceTree: { ...EMPTY_TREE, rootPath: "/tmp" },
		...options,
	});
}

async function render(options: Parameters<typeof buildSystemPrompt>[0] = {}): Promise<string> {
	return (await build(options)).systemPrompt.join("\n\n");
}

describe("contextProfile", () => {
	it("keeps explicit full byte-identical to the default", async () => {
		expect(await render({ contextProfile: "full" })).toBe(await render());
		const custom = { resolvedCustomPrompt: "Custom system prompt." };
		expect(await render({ ...custom, contextProfile: "full" })).toBe(await render(custom));
	});

	it("uses the complete template by default", async () => {
		const rendered = await render();
		for (const marker of FULL_ONLY) expect(rendered).toContain(marker);
	});

	it("drops the long prose under reduced profiles", async () => {
		for (const contextProfile of ["balanced", "aggressive"] as const) {
			const rendered = await render({ contextProfile });
			for (const marker of FULL_ONLY) expect(rendered).not.toContain(marker);
			expect(rendered).toContain("§ Critical");
			expect(rendered).toContain("§ Delivery");
		}
	});

	it("is materially shorter than the full template on the same inputs", async () => {
		const full = await render({ contextProfile: "full" });
		const balanced = await render({ contextProfile: "balanced" });
		expect(balanced.length).toBeLessThan(full.length * 0.75);
	});

	it("keeps generated rules and xd:// while moving skills to discovery", async () => {
		const rendered = await render({
			contextProfile: "balanced",
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
		expect(rendered).not.toContain("deploy: How to ship");
		expect(rendered).toContain("api");
		expect(rendered).toContain("xd://");
	});

	it("keeps exact static source ownership for reporting", async () => {
		const result = await build({
			contextProfile: "full",
			skills: [
				{
					name: "deploy",
					description: "How to ship",
					filePath: "/tmp/deploy/SKILL.md",
					baseDir: "/tmp",
					source: "native",
				},
			],
		});
		const staticContext = result.staticContext;

		expect(staticContext.completeSystemPrompt).toEqual(result.systemPrompt);
		expect(staticContext.skillCatalog.join("\n\n")).toContain("deploy: How to ship");
		expect(staticContext.renderedSystemTemplate.join("\n\n")).not.toContain("deploy: How to ship");
		expect(staticContext.projectContextBlocks.join("\n\n")).toContain("<workstation>");
	});

	it("keeps presentation policy when a custom system prompt is active", async () => {
		const marker = "You are a code reviewer and never edit files.";
		const result = await build({
			contextProfile: "balanced",
			resolvedCustomPrompt: marker,
			xdevTools: [{ name: "lsp", summary: "Language server" }],
		});
		const rendered = result.systemPrompt.join("\n\n");

		expect(rendered).toContain(marker);
		expect(rendered).toContain("skill://?q=<term>");
		expect(rendered).toContain("xd://<tool>");
		expect(result.xdevCatalogNames).toEqual(["lsp"]);
		for (const full of FULL_ONLY) expect(rendered).not.toContain(full);
	});
});
