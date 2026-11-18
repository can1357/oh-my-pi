import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { postProcessToolResult } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { spillUrlIds, spillUrl } from "@oh-my-pi/pi-utils";

function getTextOutput(result: AgentToolResult): string {
	const texts: string[] = [];
	for (const block of result.content) if (block.type === "text") texts.push(block.text);
	return texts.join("\n");
}

describe("spills of a session without a session file", () => {
	let testDir: string;
	let manager: SessionManager;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-spill-no-session-"));
		manager = SessionManager.inMemory(testDir);
	});

	afterEach(async () => {
		await manager.close();
		await fs.rm(path.join(os.tmpdir(), "omp-local", manager.getSessionId()), { recursive: true, force: true });
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("land at the tmp local:// root, and read reads the advertised local://N.log back", async () => {
		const fullOutput = Array.from({ length: 8_000 }, (_, index) => `spill line ${index + 1} ${"x".repeat(80)}`).join(
			"\n",
		);
		const context: AgentToolContext = {
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(await AuthStorage.create(":memory:"), path.join(testDir, "models.yml")),
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};
		const spilled = await postProcessToolResult(
			{ content: [{ type: "text", text: fullOutput }], details: {} },
			"bash",
			context,
		);
		const [id] = spillUrlIds(getTextOutput(spilled));
		expect(id).toBeDefined();
		expect(manager.getArtifactsDir()).toBeNull();

		const session: ToolSession = {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => manager.getArtifactsDir(),
			getSessionId: () => manager.getSessionId(),
			sessionManager: manager,
			settings: Settings.isolated(),
		};
		const tool = new ReadTool(session);
		const head = getTextOutput(await tool.execute("call-head", { path: spillUrl(id!) }));
		const tail = getTextOutput(await tool.execute("call-tail", { path: `${spillUrl(id!)}:raw:8000-8000` }));

		expect(head).toContain("spill line 1 ");
		expect(tail).toContain("spill line 8000 ");
	});
});
