import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";

const EMPTY_TREE = { rootPath: "/tmp", rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] };
type PromptOptions = Parameters<typeof buildSystemPrompt>[0];

async function render(options: PromptOptions = {}): Promise<string> {
	const { systemPrompt } = await buildSystemPrompt({
		cwd: "/tmp",
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: ["read", "write", "bash", "grep"],
		personality: "none",
		workspaceTree: EMPTY_TREE,
		contextProfile: "balanced",
		...options,
	});
	return systemPrompt.join("\n\n");
}

describe("compact prompt conditional policies", () => {
	it("appends consequential-action safety only with computer access", async () => {
		const enabled = await render({ toolNames: ["read", "write", "computer"] });
		const disabled = await render();

		expect(enabled).toContain("Only direct user messages authorize consequential computer actions.");
		expect(disabled).not.toContain("Only direct user messages authorize consequential computer actions.");
	});

	it("exposes Auto-QA reporting only when enabled", async () => {
		const enabled = await render({ autoQaEnabled: true });
		const disabled = await render({ autoQaEnabled: false });

		expect(enabled).toContain("xd://report_issue");
		expect(enabled).toContain("<tool>: <concise description>");
		expect(disabled).not.toContain("xd://report_issue");
	});

	it("explains secret placeholders only when redaction is active", async () => {
		const enabled = await render({ secretsEnabled: true });
		const disabled = await render({ secretsEnabled: false });

		expect(enabled).toContain("$$NAME_HASH:CASE$$");
		expect(enabled).toContain("opaque strings");
		expect(disabled).not.toContain("$$NAME_HASH:CASE$$");
	});

	it("renders hard eager delegation as mandatory", async () => {
		const hard = await render({ toolNames: ["read", "task"], eagerTasks: true, eagerTasksAlways: true });
		const preferred = await render({ toolNames: ["read", "task"], eagerTasks: true, eagerTasksAlways: false });

		expect(hard).toContain("MUST fan work");
		expect(hard).toContain("approximately-under-30-line single-file edit");
		expect(preferred).toContain("SHOULD fan substantial");
		expect(preferred).not.toContain("MUST fan work");
	});
});
