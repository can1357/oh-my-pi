import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter, LocalProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("local:// URL with the working directory prefixed", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
	});

	it("writes and reads session-local storage instead of creating a `local:` directory in cwd", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-url-prefix-"));
		try {
			const cwd = path.join(tempDir, "repo");
			const artifacts = path.join(tempDir, "artifacts");
			await fs.mkdir(cwd);
			LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifacts, getSessionId: () => "s" });
			const session: ToolSession = {
				cwd,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				settings: Settings.isolated(),
				enableLsp: false,
			};
			const prefixed = `${cwd}/local://rules.md`;

			await new WriteTool(session).execute("w", { path: prefixed, content: "shared rules\n" });
			const read = await new ReadTool(session).execute("r", { path: prefixed });
			const text = read.content.map(block => (block.type === "text" ? block.text : "")).join("\n");

			expect(await Bun.file(path.join(artifacts, "local", "rules.md")).text()).toBe("shared rules\n");
			expect(await fs.readdir(cwd)).toEqual([]);
			expect(text).toContain("shared rules");
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
