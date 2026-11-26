import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import {
	InternalUrlRouter,
	posixCksum,
	RemoteEditConflictError,
	RemoteEditMissingError,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { InternalResource, InternalUrl, ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import type { EditMode } from "@oh-my-pi/pi-coding-agent/edit";
import { TempDir } from "@oh-my-pi/pi-utils";

const text = (result: AgentToolResult<unknown>): string =>
	result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

const HOME = "/home/u";

/** A fake remote host: its files, and every operation that would contact it. */
interface Remote {
	files: Map<string, string>;
	io: string[];
	/** Runs inside `update`, before its checksum comparison (a concurrent writer). */
	beforeUpdate?: () => void;
}

/**
 * A remote, handler-written text scheme like `ssh://`, backed by `remote.files`.
 * `/~/` paths sit below {@link HOME}, which the "host" reports only after a
 * home-relative request contacted it, as ssh:// caches it.
 */
function registerRemote(remote: Remote): void {
	let homeKnown = false;
	const homeRelative = (url: InternalUrl) => {
		const raw = url.rawPathname ?? url.pathname;
		return raw === "/~" || raw.startsWith("/~/");
	};
	const absolute = (url: InternalUrl) => {
		const decoded = decodeURIComponent(url.rawPathname ?? url.pathname);
		return homeRelative(url) ? `${HOME}${decoded.slice(2)}` : decoded;
	};
	const canonical = (url: InternalUrl) => `remotetest://host${absolute(url)}`;
	const handler: ProtocolHandler = {
		scheme: "remotetest",
		spec: {
			backing: "remote",
			selectors: "lines",
			immutable: false,
			write: { via: "handler", payload: "text", scope: "workspace", tier: () => "exec", edits: "update" },
		},
		async resolve(url: InternalUrl): Promise<InternalResource> {
			remote.io.push(`resolve ${url.href}`);
			if (homeRelative(url)) homeKnown = true;
			const content = remote.files.get(absolute(url));
			if (content === undefined) throw new Error(`missing ${url.pathname}`);
			return { url: url.href, content, contentType: "text/plain", size: Buffer.byteLength(content) };
		},
		async write(url: InternalUrl, content: string): Promise<void> {
			remote.io.push(`write ${url.href}`);
			remote.files.set(absolute(url), content);
		},
		edit: {
			async canonicalUrl(url, _context, options) {
				if (homeRelative(url) && !homeKnown) {
					if (options?.localOnly) return undefined;
					remote.io.push("home");
					homeKnown = true;
				}
				return canonical(url);
			},
			async fetch(url) {
				remote.io.push(`fetch ${canonical(url)}`);
				const content = remote.files.get(absolute(url));
				if (content === undefined) throw new RemoteEditMissingError(canonical(url));
				return { url: canonical(url), content, checksum: posixCksum(Buffer.from(content)) };
			},
			async update(url, content, checksum) {
				remote.io.push(`update ${canonical(url)}`);
				remote.beforeUpdate?.();
				const current = remote.files.get(absolute(url)) ?? "";
				if (posixCksum(Buffer.from(current)) !== checksum) throw new RemoteEditConflictError(canonical(url));
				remote.files.set(absolute(url), content);
			},
		},
	};
	InternalUrlRouter.instance().register(handler);
}

interface Preview {
	path?: string;
	displayPath?: string;
	diff?: string;
	error?: string;
}

/** Stream `args` into `tool` in small chunks and resolve with the final (untrimmed) preview's files. */
async function streamPreview(tool: EditTool, toolCallId: string, args: Record<string, unknown>): Promise<Preview[]> {
	const final = Promise.withResolvers<Preview[]>();
	const stream = tool.openArgStream({
		toolCallId,
		toolName: "edit",
		emit: update => {
			const batch = update as { streaming?: boolean; files?: Preview[] };
			if (batch.streaming === false) final.resolve(batch.files ?? []);
		},
	});
	const encoded = JSON.stringify(args);
	for (let offset = 0; offset < encoded.length; offset += 7) stream.push(encoded.slice(offset, offset + 7));
	stream.end(args);
	return final.promise;
}

describe("edit on a remote handler-written URL", () => {
	afterEach(() => {
		InternalUrlRouter.instance().unregister("remotetest");
	});

	function setup() {
		const dir = TempDir.createSync("@omp-edit-remote-");
		const remote: Remote = { files: new Map(), io: [] };
		registerRemote(remote);
		const session = {
			cwd: dir.path(),
			hasUI: false,
			getSessionFile: () => path.join(dir.path(), "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(dir.path(), "artifacts"),
			settings: Settings.isolated(),
		} as unknown as ToolSession;
		const read = async (target: string) => text(await new ReadTool(session).execute("read", { path: target }));
		const edit = (mode: EditMode) => new EditTool(session, mode);
		// Mirrors outlive a test, so every test names its own remote files.
		const unique = crypto.randomUUID();
		return { dir, remote, read, edit, unique };
	}

	it("previews against the read's mirror and contacts the host only once the edit runs", async () => {
		const { dir, remote, read, edit, unique } = setup();
		using _dir = dir;
		remote.files.set(`/tmp/${unique}.py`, "def f():\n    return 1\n");
		const header = (await read(`remotetest://host/tmp/${unique}.py`)).split("\n")[0];
		expect(header).toMatch(new RegExp(`^\\[remotetest://host/tmp/${unique}\\.py#[0-9A-F]{4}\\]$`));
		remote.io.length = 0;

		const tool = edit("hashline");
		const args = { input: `${header}\nPUT 2.=2:\n+    return 2\n` };
		const [preview] = await streamPreview(tool, "remote-preview", args);
		expect(preview?.diff).toContain("return 2");
		expect(remote.io).toEqual([]);

		const result = await tool.execute("remote-preview", args);
		expect(result.isError).not.toBe(true);
		expect(remote.files.get(`/tmp/${unique}.py`)).toBe("def f():\n    return 2\n");
		expect(remote.io).toEqual([
			`fetch remotetest://host/tmp/${unique}.py`,
			`update remotetest://host/tmp/${unique}.py`,
		]);
	});

	it("defers only the preview of a remote file it has no mirror for, then applies the whole batch", async () => {
		const { dir, remote, read, edit, unique } = setup();
		using _dir = dir;
		const local = path.join(dir.path(), "local.txt");
		await Bun.write(local, "one\n");
		remote.files.set(`${HOME}/${unique}.py`, "def f():\n    return 1\n");
		// Read by its absolute path, the file is edited by its HOME-relative spelling, which
		// names no mirror until the edit asks the host for HOME.
		const remoteTag = /#([0-9A-F]{4})\]/.exec(await read(`remotetest://host${HOME}/${unique}.py`))?.[1];
		const localHeader = (await read(local)).split("\n")[0];
		remote.io.length = 0;

		const tool = edit("hashline");
		const args = {
			input: [
				`[remotetest://host/~/${unique}.py#${remoteTag}]`,
				"PUT 2.=2:",
				"+    return 2",
				localHeader,
				"PUT 1.=1:",
				"+two",
				"",
			].join("\n"),
		};
		const previews = await streamPreview(tool, "mixed", args);
		expect(remote.io).toEqual([]);
		expect(previews).toHaveLength(2);
		expect(previews[0]?.diff).toBeUndefined();
		expect(previews[0]?.error).toContain(`Preview deferred: remotetest://host/~/${unique}.py`);
		expect(previews[1]?.diff).toContain("two");

		const result = await tool.execute("mixed", args);
		expect(result.isError).not.toBe(true);
		expect(remote.files.get(`${HOME}/${unique}.py`)).toBe("def f():\n    return 2\n");
		expect(await Bun.file(local).text()).toBe("two\n");
	});

	it("writes nothing when the remote file changed after the edit fetched it", async () => {
		const { dir, remote, read, edit, unique } = setup();
		using _dir = dir;
		const file = `/tmp/${unique}.py`;
		remote.files.set(file, "def f():\n    return 1\n");
		const header = (await read(`remotetest://host${file}`)).split("\n")[0];
		remote.beforeUpdate = () => remote.files.set(file, "def f():\n    return 3\n");

		const result = await edit("hashline").execute("conflict", { input: `${header}\nPUT 2.=2:\n+    return 2\n` });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain(`remotetest://host${file} changed on the remote host after this edit fetched it`);
		expect(text(result)).toContain(`Re-read remotetest://host${file} and retry the edit.`);
		expect(remote.files.get(file)).toBe("def f():\n    return 3\n");
	});

	it("refuses deleting a remote file in the preview, and the batch writes nothing", async () => {
		const { dir, remote, edit, unique } = setup();
		using _dir = dir;
		const local = path.join(dir.path(), "local.txt");
		await Bun.write(local, "one\n");
		remote.files.set(`/tmp/${unique}.txt`, "alpha\n");
		const args = {
			input: [
				"*** Begin Patch",
				`*** Update File: ${local}`,
				"@@",
				"-one",
				"+two",
				`*** Delete File: remotetest://host/tmp/${unique}.txt`,
				"*** End Patch",
			].join("\n"),
		};
		const refusal = `remotetest:// files can only be updated in place, so edit cannot delete remotetest://host/tmp/${unique}.txt`;
		const tool = edit("apply_patch");
		const previews = await streamPreview(tool, "delete", args);
		expect(previews.some(file => file.error?.includes(refusal))).toBe(true);
		expect(remote.io).toEqual([]);

		const result = await tool.execute("delete", args);
		expect(result.isError).toBe(true);
		expect(text(result)).toContain(refusal);
		expect(await Bun.file(local).text()).toBe("one\n");
		expect(remote.files.get(`/tmp/${unique}.txt`)).toBe("alpha\n");
		expect(remote.io).toEqual([]);
	});

	it("keys the read's tag and the edit's mirror by one canonical URL for HOME-relative spellings", async () => {
		const { dir, remote, read, edit, unique } = setup();
		using _dir = dir;
		remote.files.set(`${HOME}/${unique}.py`, "def f():\n    return 1\n");
		const header = (await read(`remotetest://host/~/${unique}.py`)).split("\n")[0];
		const tag = /#([0-9A-F]{4})\]$/.exec(header)?.[1];
		expect(header).toBe(`[remotetest://host${HOME}/${unique}.py#${tag}]`);
		remote.io.length = 0;

		// The tag the canonical header carries is honored under the `~` spelling too.
		const tool = edit("hashline");
		const args = { input: `[remotetest://host/~/${unique}.py#${tag}]\nPUT 2.=2:\n+    return 2\n` };
		const [preview] = await streamPreview(tool, "canonical", args);
		expect(preview?.diff).toContain("return 2");
		expect(remote.io).toEqual([]);
		const result = await tool.execute("canonical", args);
		expect(result.isError).not.toBe(true);
		expect(remote.files.get(`${HOME}/${unique}.py`)).toBe("def f():\n    return 2\n");
	});

	it("reads a remote notebook as its cells and edits it by the read's line numbers", async () => {
		const { dir, remote, read, edit, unique } = setup();
		using _dir = dir;
		const notebook = {
			cells: [{ cell_type: "code", metadata: {}, source: ["x = 1\n", "y = 2"], outputs: [], execution_count: null }],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5,
		};
		const url = `remotetest://host/tmp/${unique}.ipynb`;
		remote.files.set(`/tmp/${unique}.ipynb`, JSON.stringify(notebook, null, 1));
		expect(await read(`${url}:raw`)).toContain('"cell_type": "code"');
		const projected = await read(url);
		expect(projected).not.toContain("cell_type");
		expect(projected).toMatch(/2[^\n]*x = 1/);
		const header = projected.split("\n")[0];

		const result = await edit("hashline").execute("notebook", { input: `${header}\nPUT 2.=2:\n+x = 3\n` });
		expect(result.isError).not.toBe(true);
		const written = JSON.parse(remote.files.get(`/tmp/${unique}.ipynb`) ?? "{}") as typeof notebook;
		expect(written.cells[0]?.source).toEqual(["x = 3\n", "y = 2"]);
	});
});
