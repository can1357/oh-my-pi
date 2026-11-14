import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { postProcessToolResult } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function getTextOutput(result: AgentToolResult): string {
	const texts: string[] = [];
	for (const block of result.content) if (block.type === "text") texts.push(block.text);
	return texts.join("\n");
}

describe("read tool artifacts without an artifacts directory", () => {
	let testDir: string;
	let manager: SessionManager;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-artifact-memory-"));
		manager = SessionManager.inMemory(testDir);
	});

	afterEach(async () => {
		resetRegisteredArtifactDirsForTests();
		await manager.close();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	function makeSession(): ToolSession {
		return {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => manager.getArtifactsDir(),
			sessionManager: manager,
			settings: Settings.isolated(),
		};
	}

	async function makeToolContext(): Promise<AgentToolContext> {
		return {
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(await AuthStorage.create(":memory:"), path.join(testDir, "models.yml")),
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};
	}

	it("reads the artifact a spill footer advertises back from the in-memory store", async () => {
		const fullOutput = Array.from({ length: 8_000 }, (_, index) => `spill line ${index + 1} ${"x".repeat(80)}`).join(
			"\n",
		);
		const spilled = await postProcessToolResult(
			{ content: [{ type: "text", text: fullOutput }], details: {} },
			"bash",
			await makeToolContext(),
		);
		const advertised = getTextOutput(spilled).match(/artifact:\/\/(\d+)/);
		expect(advertised).not.toBeNull();
		expect(manager.getArtifactsDir()).toBeNull();

		const tool = new ReadTool(makeSession());
		const head = getTextOutput(await tool.execute("call-head", { path: `artifact://${advertised![1]}` }));
		const tail = getTextOutput(
			await tool.execute("call-tail", { path: `artifact://${advertised![1]}:raw:8000-8000` }),
		);

		expect(head).toContain("spill line 1 ");
		expect(tail).toContain("spill line 8000 ");
	});

	it("pages an in-memory artifact with a line selector", async () => {
		const lines = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`);
		const id = await manager.saveArtifact(lines.join("\n"), "bash");
		if (id === undefined) throw new Error("expected an artifact id");

		const result = await new ReadTool(makeSession()).execute("call-range", { path: `artifact://${id}:raw:10-12` });
		const output = getTextOutput(result);

		expect(output).toContain("line-10");
		expect(output).toContain("line-12");
		expect(output).not.toContain("line-9");
		expect(output).not.toContain("line-13");
	});

	it("prefers the caller's in-memory artifact over another session's file with the same id", async () => {
		const id = await manager.saveArtifact("LOCAL SESSION OUTPUT", "bash");
		if (id === undefined) throw new Error("expected an artifact id");
		const foreignDir = path.join(testDir, "foreign-artifacts");
		await fs.mkdir(foreignDir);
		await Bun.write(path.join(foreignDir, `${id}.bash.log`), "FOREIGN SESSION OUTPUT");
		registerArtifactsDir(foreignDir);

		const output = getTextOutput(
			await new ReadTool(makeSession()).execute("call-own", { path: `artifact://${id}:raw` }),
		);

		expect(output).toContain("LOCAL SESSION OUTPUT");
		expect(output).not.toContain("FOREIGN");
	});

	it("pages an in-memory artifact larger than the inline resolution cap", async () => {
		const line = "y".repeat(1023);
		const lines = Array.from({ length: 8_200 }, (_, index) => `big-${index + 1} ${line}`);
		const content = lines.join("\n");
		expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(8 * 1024 * 1024);
		const id = await manager.saveArtifact(content, "bash");
		if (id === undefined) throw new Error("expected an artifact id");

		const output = getTextOutput(
			await new ReadTool(makeSession()).execute("call-big", { path: `artifact://${id}:raw:2-2` }),
		);

		expect(output).toContain("big-2 ");
		expect(output).not.toContain("big-3 ");
	});
});
