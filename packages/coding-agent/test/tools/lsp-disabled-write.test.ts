import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function session(cwd: string, formatOnWrite = false): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated({ "lsp.enabled": false, "lsp.formatOnWrite": formatOnWrite }),
		enableLsp: true,
	};
}

describe("lsp.enabled disables file-tool language servers", () => {
	let cwd: string;
	let started: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lsp-disabled-"));
		started = path.join(cwd, "lsp-started");
		const bin = path.join(cwd, "node_modules", ".bin");
		await fs.mkdir(bin, { recursive: true });
		await Bun.write(path.join(cwd, "tsconfig.json"), "{}\n");
		const executable = path.join(bin, "typescript-language-server");
		await Bun.write(executable, `#!/bin/sh\nprintf started > ${started}\n`);
		await fs.chmod(executable, 0o755);

		await Bun.write(
			path.join(cwd, "lsp.json"),
			JSON.stringify({
				servers: {
					"marker-server": {
						command: executable,
						fileTypes: [".ts"],
						rootMarkers: ["tsconfig.json"],
					},
				},
			}),
		);
	});
	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("writes TypeScript without launching a server when diagnostics on write is enabled", async () => {
		const file = path.join(cwd, "new.ts");
		await new WriteTool(session(cwd)).execute("write", { path: file, content: "export const value = 1;\n" });
		expect(await Bun.file(file).text()).toBe("export const value = 1;\n");
		expect(await Bun.file(started).exists()).toBe(false);
	});

	it("edits TypeScript without launching a server when format on write is enabled", async () => {
		const file = path.join(cwd, "existing.ts");
		await Bun.write(file, "export const value = 1;\n");
		await new EditTool(session(cwd, true), "apply_patch").execute("edit", {
			input: `*** Begin Patch\n*** Update File: ${file}\n@@\n-export const value = 1;\n+export const value = 2;\n*** End Patch\n`,
		});
		expect(await Bun.file(file).text()).toBe("export const value = 2;\n");
		expect(await Bun.file(started).exists()).toBe(false);
	});
});
