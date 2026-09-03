import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computeFileHash } from "@oh-my-pi/hashline";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const FILE_CONTENT = "bridge write content\n";

interface SessionOptions {
	bridge?: ClientBridge;
	planMode?: PlanModeState;
}

function createSession(cwd: string, options: SessionOptions = {}): ToolSession {
	const getArtifactsDir = () => path.join(cwd, "artifacts");
	const getSessionId = () => "session-a";
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir,
		getSessionId,
		localProtocolOptions: { getArtifactsDir, getSessionId },
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		getClientBridge: options.bridge ? () => options.bridge : undefined,
		getPlanModeState: options.planMode ? () => options.planMode : undefined,
	};
}

function resultText(result: AgentToolResult): string {
	const text: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") text.push(block.text);
	}
	return text.join("\n");
}

describe("write tool ACP fs routing", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-acp-fs-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("routes plain text writes through the bridge and does not call Bun.write", async () => {
		const filePath = path.join(tmpDir, "output.txt");

		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => undefined,
		};

		const bridgeSpy = spyOn(bridge, "writeTextFile");
		const bunWriteSpy = spyOn(Bun, "write");

		try {
			const session = createSession(tmpDir, { bridge });
			const tool = new WriteTool(session);

			await tool.execute("call-1", { path: filePath, content: FILE_CONTENT });

			// Bridge was called with the exact path and content
			expect(bridgeSpy).toHaveBeenCalledTimes(1);
			expect(bridgeSpy).toHaveBeenCalledWith({ path: filePath, content: FILE_CONTENT });
			// Disk write must not have been called — bridge is the destination
			expect(bunWriteSpy).not.toHaveBeenCalled();
		} finally {
			bunWriteSpy.mockRestore();
		}
	});

	it("keys the returned snapshot header on bridge-transformed disk content", async () => {
		const filePath = path.join(tmpDir, "formatted.ts");
		const requested = "function f() {\n    return 1;\n}\n";
		const persisted = "function f() {\n\treturn 1;\n}\n";
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async ({ path: target, content }) => {
				await Bun.write(target, content.replace(/^ {4}/gm, "\t"));
			},
		};
		const session = createSession(tmpDir, { bridge });

		const result = await new WriteTool(session).execute("call-drift", { path: filePath, content: requested });
		const text = resultText(result);

		expect(await Bun.file(filePath).text()).toBe(persisted);
		expect(text).toContain(`[formatted.ts#${computeFileHash(persisted)}]`);
		expect(text).not.toContain(`[formatted.ts#${computeFileHash(requested)}]`);
	});

	it("emits a progress snapshot before filesystem writes complete", async () => {
		const filePath = path.join(tmpDir, "progress.txt");
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const updates: AgentToolResult[] = [];

		const result = await tool.execute(
			"call-progress",
			{ path: filePath, content: FILE_CONTENT },
			undefined,
			update => {
				updates.push(update);
			},
		);

		expect(updates).toHaveLength(1);
		expect(updates[0]?.content).toEqual([
			{ type: "text", text: `Writing ${FILE_CONTENT.length} bytes to progress.txt...` },
		]);
		expect(updates[0]?.details).toEqual({ resolvedPath: filePath });
		expect(resultText(result)).toContain(`Successfully wrote ${FILE_CONTENT.length} bytes to progress.txt`);
	});

	it("writes local plan artifacts to disk instead of the ACP bridge", async () => {
		const planPath = "local://PLAN.md";
		const planContent = "# Plan\n\nhello world\n";
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => {
				throw new Error("Internal error");
			},
		};
		const bridgeSpy = spyOn(bridge, "writeTextFile");
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: planPath, workflow: "parallel", reentry: false },
		});

		await new WriteTool(session).execute("call-plan", { path: planPath, content: planContent });

		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(
			await Bun.file(
				resolveLocalUrlToPath(planPath, {
					getArtifactsDir: session.getArtifactsDir,
					getSessionId: session.getSessionId,
				}),
			).text(),
		).toBe(planContent);
	});

	it("treats bracketed `[local://...#TAG]` headers as local artifacts, not bridge writes", async () => {
		const planPath = "local://PLAN.md";
		const scratchPath = "local://scratch.md";
		// Active plan file is unrelated to the scratch artifact we are writing.
		const bracketedScratch = `[${scratchPath}#ABCD]`;
		const scratchContent = "scratch notes\n";
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => undefined,
		};
		const bridgeSpy = spyOn(bridge, "writeTextFile");
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: planPath, workflow: "parallel", reentry: false },
		});

		await new WriteTool(session).execute("call-bracketed", { path: bracketedScratch, content: scratchContent });

		// Bracketed local headers must not slip past the bridge router — they are
		// still session-local artifacts and stay on disk under the local sandbox.
		expect(bridgeSpy).not.toHaveBeenCalled();
		expect(
			await Bun.file(
				resolveLocalUrlToPath(scratchPath, {
					getArtifactsDir: session.getArtifactsDir,
					getSessionId: session.getSessionId,
				}),
			).text(),
		).toBe(scratchContent);
	});

	it("rejects read-only internal URLs without creating scheme-looking paths on disk", async () => {
		const targetPath = "memory://root/memory_summary.md";
		const leakedPath = path.join(tmpDir, "memory:/root/memory_summary.md");
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);

		let rejection: unknown;
		try {
			await tool.execute("call-memory", { path: targetPath, content: "memory summary\n" });
		} catch (error) {
			rejection = error;
		}

		expect(await Bun.file(leakedPath).exists()).toBe(false);
		if (!(rejection instanceof Error)) throw new Error("Expected memory:// write to reject");
		expect(rejection.message).toContain("memory:// URLs are read-only for write");
	});
});
