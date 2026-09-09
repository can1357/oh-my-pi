import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	};
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

function details(result: { details?: { madeExecutable?: boolean } }): { madeExecutable?: boolean } {
	return result.details ?? {};
}

describe("write tool shebang chmod", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-shebang-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("marks files starting with #! as executable and flags the result", async () => {
		const filePath = path.join(tmpDir, "run.sh");
		const tool = new WriteTool(createSession(tmpDir));

		const result = await tool.execute("call-1", {
			path: filePath,
			content: "#!/bin/sh\necho hi\n",
		});

		const stat = await fs.stat(filePath);
		// All three execute bits flipped on (chmod a+x semantics).
		expect(stat.mode & 0o111).toBe(0o111);
		// Notice remains model-facing so callers see that chmod changed the file mode.
		expect(details(result).madeExecutable).toBe(true);
		expect(resultText(result)).toContain("[Notice: Made executable via chmod +x]");
	});

	it("does not chmod files without a shebang", async () => {
		const filePath = path.join(tmpDir, "data.txt");
		const tool = new WriteTool(createSession(tmpDir));

		const result = await tool.execute("call-2", {
			path: filePath,
			content: "no shebang here\n",
		});

		const stat = await fs.stat(filePath);
		expect(stat.mode & 0o111).toBe(0);
		expect(details(result).madeExecutable).toBeUndefined();
	});

	it("does not re-flag when file is already executable", async () => {
		const filePath = path.join(tmpDir, "preexec.sh");
		await fs.writeFile(filePath, "#!/bin/sh\nold\n");
		await fs.chmod(filePath, 0o755);

		const tool = new WriteTool(createSession(tmpDir));
		const result = await tool.execute("call-3", {
			path: filePath,
			content: "#!/usr/bin/env python3\nprint('hi')\n",
		});

		const stat = await fs.stat(filePath);
		expect(stat.mode & 0o111).toBe(0o111);
		// Mode didn't change, so no flag.
		expect(details(result).madeExecutable).toBeUndefined();
	});
});
