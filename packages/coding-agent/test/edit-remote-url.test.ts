import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { InternalUrlRouter, UrlSchemeTable } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { InternalResource, InternalUrl, ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { TempDir } from "@oh-my-pi/pi-utils";

const text = (result: AgentToolResult<unknown>): string =>
	result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

/** A remote, handler-written text scheme like `ssh://`, backed by a map. */
function remoteRouter(files: Map<string, string>): InternalUrlRouter {
	const handler: ProtocolHandler = {
		scheme: "remotetest",
		spec: {
			backing: "remote",
			selectors: "lines",
			immutable: false,
			write: { via: "handler", payload: "text", scope: "workspace", tier: () => "exec" },
		},
		async resolve(url: InternalUrl): Promise<InternalResource> {
			const content = files.get(url.pathname);
			if (content === undefined) throw new Error(`missing ${url.pathname}`);
			return { url: url.href, content, contentType: "text/plain", size: Buffer.byteLength(content) };
		},
		async write(url: InternalUrl, content: string): Promise<void> {
			files.set(url.pathname, content);
		},
	};
	const schemes = new UrlSchemeTable("Test scheme");
	schemes.replace([handler]);
	return new InternalUrlRouter([schemes]);
}

describe("hashline edit on a remote handler-written URL", () => {
	it("tags the read and writes the patched text back through the handler", async () => {
		using dir = TempDir.createSync("@omp-edit-remote-");
		const files = new Map([["/tmp/x.py", "def f():\n    return 1\n"]]);
		const urlRouter = remoteRouter(files);
		const session = {
			urlRouter,
			cwd: dir.path(),
			hasUI: false,
			getSessionFile: () => path.join(dir.path(), "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(dir.path(), "artifacts"),
			settings: Settings.isolated(),
		} as unknown as ToolSession;

		const read = text(await new ReadTool(session).execute("read", { path: "remotetest://host/tmp/x.py" }));
		const header = read.split("\n")[0];
		expect(header).toMatch(/^\[remotetest:\/\/host\/tmp\/x\.py#[0-9A-F]{4}\]$/);

		const result = await new EditTool(session, "hashline").execute("edit", {
			input: `${header}\nPUT 2.=2:\n+    return 2\n`,
		});
		expect(result.isError).not.toBe(true);
		expect(files.get("/tmp/x.py")).toBe("def f():\n    return 2\n");
	});
});
