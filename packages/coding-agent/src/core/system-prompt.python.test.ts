import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "./system-prompt";

describe("buildSystemPrompt", () => {
	it("includes python tool details when enabled", async () => {
		const prompt = await buildSystemPrompt({
			cwd: "/tmp",
			toolNames: ["python"],
			contextFiles: [],
			skills: [],
			rules: [],
		});

		expect(prompt).toContain("python: Execute Python code via a session-backed IPython kernel");
		expect(prompt).toContain("What python IS for");
	});
});
