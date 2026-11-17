import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { getActiveClients, shutdownAll } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { configCache } from "@oh-my-pi/pi-coding-agent/lsp/config";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// Issue #18205: `write`/`edit` started language servers even with `lsp.enabled: false`.
// The observable contract is that no LSP client is ever created for the project, so the
// assertions read the live client registry rather than any spawn counter.

const FILE_TYPE = ".18205xyz";
const STUB_SERVER = path.join(import.meta.dir, "fixtures", "fake-lsp-server.ts");

function stubClients() {
	return getActiveClients().filter(client => client.fileTypes.includes(FILE_TYPE));
}

function createSession(cwd: string, overrides: Record<string, unknown> = {}): ToolSession {
	const getArtifactsDir = () => path.join(cwd, "artifacts");
	const getSessionId = () => "session-18205";
	return {
		cwd,
		hasUI: false,
		enableLsp: true,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir,
		getSessionId,
		localProtocolOptions: { getArtifactsDir, getSessionId },
		settings: Settings.isolated({ "lsp.diagnosticsOnWrite": true, "lsp.formatOnWrite": false, ...overrides }),
	} as unknown as ToolSession;
}

describe("lsp.enabled gates the write/edit writethrough (#18205)", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lsp-writethrough-gate-"));
		// A real stub language server: reaching it means a process was spawned and handshook.
		await Bun.write(
			path.join(cwd, "lsp.json"),
			JSON.stringify({
				servers: {
					"issue-18205-stub": {
						command: process.execPath,
						args: ["run", STUB_SERVER],
						fileTypes: [FILE_TYPE],
						rootMarkers: ["lsp.json"],
					},
				},
			}),
		);
	});

	afterEach(async () => {
		await shutdownAll();
		configCache.delete(cwd);
		await removeWithRetries(cwd);
	});

	it("starts the stub server when LSP is enabled", async () => {
		const tool = new WriteTool(createSession(cwd));

		await tool.execute("control", { path: path.join(cwd, `control${FILE_TYPE}`), content: "export const a = 1;\n" });

		expect(stubClients().map(client => client.status)).toEqual(["ready"]);
	}, 20_000);

	it("does not start a language server for a write when LSP is disabled", async () => {
		const tool = new WriteTool(createSession(cwd, { "lsp.enabled": false }));

		await tool.execute("write", { path: path.join(cwd, `write${FILE_TYPE}`), content: "export const a = 1;\n" });

		expect(stubClients()).toEqual([]);
	}, 20_000);

	it("starts the stub server for an edit when LSP is enabled", async () => {
		const target = `control-edit${FILE_TYPE}`;
		await Bun.write(path.join(cwd, target), "old\n");
		const tool = new EditTool(createSession(cwd, { "lsp.diagnosticsOnEdit": true }), "apply_patch");

		await tool.execute("control-edit", {
			input: `*** Begin Patch\n*** Update File: ${target}\n@@\n-old\n+new\n*** End Patch`,
		});

		expect(stubClients().map(client => client.status)).toEqual(["ready"]);
	}, 20_000);

	it("does not start a language server for an edit when LSP is disabled", async () => {
		const target = `edit${FILE_TYPE}`;
		await Bun.write(path.join(cwd, target), "old\n");
		const tool = new EditTool(
			createSession(cwd, { "lsp.enabled": false, "lsp.diagnosticsOnEdit": true }),
			"apply_patch",
		);

		await tool.execute("edit", {
			input: `*** Begin Patch\n*** Update File: ${target}\n@@\n-old\n+new\n*** End Patch`,
		});

		expect(stubClients()).toEqual([]);
	}, 20_000);
});
