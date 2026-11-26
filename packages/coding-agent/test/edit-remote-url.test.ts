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

/** A remote, handler-written text scheme like `ssh://`, backed by a map; `beforeResolve` runs before each resolve. */
function remoteRouter(
	files: Map<string, string>,
	beforeResolve?: (pathname: string) => Promise<void>,
): InternalUrlRouter {
	const handler: ProtocolHandler = {
		scheme: "remotetest",
		spec: {
			backing: "remote",
			selectors: "lines",
			immutable: false,
			write: { via: "handler", payload: "text", scope: "workspace", tier: () => "exec" },
		},
		async resolve(url: InternalUrl): Promise<InternalResource> {
			await beforeResolve?.(url.pathname);
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

	it("keeps a multi-file edit's mirror when another session reads the same URL from its own registration mid-edit", async () => {
		using dir = TempDir.createSync("@omp-edit-remote-owners-");
		const session = (urlRouter: InternalUrlRouter): ToolSession =>
			({
				urlRouter,
				cwd: dir.path(),
				hasUI: false,
				getSessionFile: () => path.join(dir.path(), "session.jsonl"),
				getSessionSpawns: () => "*",
				getArtifactsDir: () => path.join(dir.path(), "artifacts"),
				settings: Settings.isolated(),
			}) as unknown as ToolSession;
		const x = "remotetest://host/tmp/x.py";
		const y = "remotetest://host/tmp/y.py";
		const filesB = new Map([["/tmp/x.py", "def b():\n    return 1\n"]]);
		const sessionB = session(remoteRouter(filesB));
		// While A's edit resolves its second target, B reads the first one through its own registration.
		let interleave = false;
		const filesA = new Map([
			["/tmp/x.py", "def a():\n    return 1\n"],
			["/tmp/y.py", "def y():\n    return 1\n"],
		]);
		const sessionA = session(
			remoteRouter(filesA, async pathname => {
				if (!interleave || pathname !== "/tmp/y.py") return;
				interleave = false;
				await new ReadTool(sessionB).execute("read-b", { path: x });
			}),
		);

		const headerX = text(await new ReadTool(sessionA).execute("read-ax", { path: x })).split("\n")[0];
		const headerY = text(await new ReadTool(sessionA).execute("read-ay", { path: y })).split("\n")[0];
		interleave = true;
		const result = await new EditTool(sessionA, "hashline").execute("edit-a", {
			input: `${headerX}\nPUT 2.=2:\n+    return 2\n${headerY}\nPUT 2.=2:\n+    return 3\n`,
		});

		expect(result.isError).not.toBe(true);
		expect(filesA.get("/tmp/x.py")).toBe("def a():\n    return 2\n");
		expect(filesA.get("/tmp/y.py")).toBe("def y():\n    return 3\n");
		expect(filesB.get("/tmp/x.py")).toBe("def b():\n    return 1\n");
	});
});
