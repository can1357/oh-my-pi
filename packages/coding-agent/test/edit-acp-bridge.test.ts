import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hashlineFileHash } from "@oh-my-pi/pi-natives";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool, type EditToolDetails } from "@oh-my-pi/pi-coding-agent/edit";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

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
		settings: Settings.isolated({ "edit.enforceSeenLines": false }),
		getClientBridge: options.bridge ? () => options.bridge : undefined,
		getPlanModeState: options.planMode ? () => options.planMode : undefined,
	} as ToolSession;
}

function makeBridge(reformat = false) {
	const bridge: ClientBridge = {
		capabilities: { writeTextFile: true },
		writeTextFile: async ({ path: target, content }) => {
			await Bun.write(target, reformat ? content.replace(/^ {4}/gm, "\t") : content);
		},
	};
	return { bridge, spy: spyOn(bridge, "writeTextFile") };
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

let tmpDir: string;

beforeEach(async () => {
	resetSettingsForTest();
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-edit-"));
	await Settings.init({ inMemory: true, cwd: tmpDir });
});

afterEach(async () => {
	resetSettingsForTest();
	await removeWithRetries(tmpDir);
});

describe("EditTool ACP write routing", () => {
	it("routes replace writes through the ACP bridge", async () => {
		const target = path.join(tmpDir, "replace.txt");
		await Bun.write(target, "old content\n");
		const { bridge, spy } = makeBridge();

		const result = await new EditTool(createSession(tmpDir, { bridge }), "replace").execute("replace", {
			path: "replace.txt",
			old_string: "old content",
			new_string: "new content",
		});

		expect(result.isError).not.toBe(true);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith({ path: target, content: "new content\n" });
		expect((result.details as EditToolDetails).newText).toBe("new content\n");
	});

	it("routes patch writes through the ACP bridge", async () => {
		const target = path.join(tmpDir, "patch.txt");
		await Bun.write(target, "a\n");
		const { bridge, spy } = makeBridge();

		const result = await new EditTool(createSession(tmpDir, { bridge }), "patch").execute("patch", {
			path: "patch.txt",
			edits: [{ op: "update", diff: "@@\n-a\n+b" }],
		});

		expect(result.isError).not.toBe(true);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith({ path: target, content: "b\n" });
		expect((result.details as EditToolDetails).newText).toBe("b\n");
	});

	it("keeps local plan writes off the ACP bridge", async () => {
		const planUrl = "local://PLAN.md";
		const { bridge, spy } = makeBridge();
		const session = createSession(tmpDir, {
			bridge,
			planMode: { enabled: true, planFilePath: planUrl, workflow: "parallel", reentry: false },
		});
		const target = resolveLocalUrlToPath(planUrl, session.localProtocolOptions!);
		await Bun.write(target, "old plan\n");

		const result = await new EditTool(session, "replace").execute("plan", {
			path: planUrl,
			old_string: "old plan",
			new_string: "new plan",
		});

		expect(result.isError).not.toBe(true);
		expect(spy).not.toHaveBeenCalled();
		expect(await Bun.file(target).text()).toBe("new plan\n");
	});

	it("reports ACP formatting drift and returns the persisted bytes and tag", async () => {
		const target = path.join(tmpDir, "drift.ts");
		const original = "function f() {\n    return 1;\n}\n";
		await Bun.write(target, original);
		const { bridge } = makeBridge(true);
		const input = `[drift.ts#${hashlineFileHash(original)}]\nPUT 2-2:\n+    return 2;`;

		const result = await new EditTool(createSession(tmpDir, { bridge }), "hashline").execute("hashline", { input });
		const persisted = await Bun.file(target).text();
		const text = resultText(result);

		expect(result.isError).not.toBe(true);
		expect(persisted).toBe("function f() {\n\treturn 2;\n}\n");
		expect((result.details as EditToolDetails).newText).toBe(persisted);
		expect(text).toContain("Warnings:");
		expect(text).toMatch(/reformatted it on save/);
		expect(text).toContain(`#${hashlineFileHash(persisted)}]`);
	});

	it("does not report drift for a byte-perfect hashline bridge write", async () => {
		const target = path.join(tmpDir, "exact.txt");
		const original = "hello\nworld\n";
		await Bun.write(target, original);
		const { bridge } = makeBridge();
		const input = `[exact.txt#${hashlineFileHash(original)}]\nPUT 2-2:\n+earth`;

		const result = await new EditTool(createSession(tmpDir, { bridge }), "hashline").execute("hashline", { input });

		expect(result.isError).not.toBe(true);
		expect(resultText(result)).not.toMatch(/reformatted it on save/);
		expect((result.details as EditToolDetails).newText).toBe("hello\nearth\n");
	});
});
