import { afterEach, describe, expect, it, vi } from "bun:test";
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
import { StreamingEditGuard, type StreamGuardsHost } from "@oh-my-pi/pi-coding-agent/session/stream-guards";
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
	/** Awaited before `locate` answers, when it returns a promise (a host lookup that never ends). */
	holdLocate?: (url: InternalUrl) => Promise<void> | undefined;
}

/**
 * A remote, handler-written text scheme like `ssh://`, backed by `remote.files`.
 * `/~/` paths sit below {@link HOME}, which the "host" reports only after a
 * home-relative request contacted it, as ssh:// caches it. Like ssh://, the
 * canonical URL keeps the authority as written, while the destination it
 * resolves to ignores the host's case.
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
	const canonical = (url: InternalUrl) => `remotetest://${url.rawHost || url.host}${absolute(url)}`;
	const destination = (url: InternalUrl, cwd: string | undefined) => `${cwd ?? ""}|${url.hostname.toLowerCase()}`;
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
			// The "destination" an alias resolves to differs per project, like an `ssh.json` alias.
			async locate(url, context, options) {
				await remote.holdLocate?.(url);
				if (homeRelative(url) && !homeKnown) {
					if (options?.localOnly) return undefined;
					remote.io.push("home");
					homeKnown = true;
				}
				return { url: canonical(url), target: destination(url, context?.cwd), path: absolute(url) };
			},
			async fetch(url, context) {
				remote.io.push(`fetch ${canonical(url)}`);
				const content = remote.files.get(absolute(url));
				if (content === undefined) throw new RemoteEditMissingError(canonical(url));
				return {
					url: canonical(url),
					target: destination(url, context?.cwd),
					path: absolute(url),
					content,
					checksum: posixCksum(Buffer.from(content)),
				};
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
	notice?: string;
}

const DEFERRED = "Preview deferred: fetched when the edit runs";

/** How many aborts `edit.streamingAbort` raises for the final preview `files`. */
function streamingAborts(files: Preview[]): number {
	let aborts = 0;
	const guard = new StreamingEditGuard({
		agent: { abort: () => aborts++ },
		settings: Settings.isolated({ "edit.streamingAbort": true }),
		sessionManager: { getCwd: () => process.cwd() },
		model: () => undefined,
		isDisposed: () => false,
		promptGeneration: () => 0,
		promptSequence: () => 0,
		emitNotice() {},
		schedulePostPromptTask() {},
		discardAssistantTurn() {},
	} as unknown as StreamGuardsHost);
	guard.maybeAbort({
		type: "tool_stream_update",
		toolCallId: "guard",
		toolName: "edit",
		update: { generation: 1, streaming: false, files },
	});
	return aborts;
}

/**
 * Stream `args` into `tool` in small chunks and resolve with the final (untrimmed) preview's files.
 * `wire: "custom"` streams `args.input` verbatim, as the custom `apply_patch` wire does; JSON otherwise.
 */
async function streamPreview(
	tool: EditTool,
	toolCallId: string,
	args: Record<string, unknown>,
	wire: "json" | "custom" = "json",
): Promise<Preview[]> {
	const final = Promise.withResolvers<Preview[]>();
	const stream = tool.openArgStream({
		toolCallId,
		toolName: "edit",
		customWireName: wire === "custom" ? "apply_patch" : undefined,
		emit: update => {
			const batch = update as { streaming?: boolean; files?: Preview[] };
			if (batch.streaming === false) final.resolve(batch.files ?? []);
		},
	});
	const encoded = wire === "custom" ? String(args.input) : JSON.stringify(args);
	for (let offset = 0; offset < encoded.length; offset += 7) stream.push(encoded.slice(offset, offset + 7));
	stream.end(args);
	return final.promise;
}

describe("edit on a remote handler-written URL", () => {
	afterEach(() => {
		// A timed-out fake-timer test never reaches its own `finally`.
		vi.useRealTimers();
		InternalUrlRouter.instance().unregister("remotetest");
	});

	function setup(shared?: Remote) {
		const dir = TempDir.createSync("@omp-edit-remote-");
		const remote: Remote = shared ?? { files: new Map(), io: [] };
		if (!shared) registerRemote(remote);
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
		// The deferred file shows a notice, not an error, so `edit.streamingAbort` does not
		// count it as a failed preview; the local file's preview renders.
		expect(previews).toHaveLength(2);
		const deferred = previews.find(file => file.path?.includes(`/~/${unique}.py`));
		expect(deferred?.notice).toBe(DEFERRED);
		expect(deferred?.error).toBeUndefined();
		expect(previews.find(file => file.diff !== undefined)?.diff).toContain("two");
		expect(streamingAborts(previews)).toBe(0);

		const result = await tool.execute("mixed", args);
		expect(result.isError).not.toBe(true);
		expect(remote.files.get(`${HOME}/${unique}.py`)).toBe("def f():\n    return 2\n");
		expect(await Bun.file(local).text()).toBe("two\n");
	});

	it.each(["json", "custom"] as const)(
		"renders the local sections of an atomic apply_patch batch whose remote file has no mirror (%s wire)",
		async wire => {
			const { dir, remote, edit, unique } = setup();
			using _dir = dir;
			const local = path.join(dir.path(), "local.txt");
			await Bun.write(local, "one\n");
			remote.files.set(`/tmp/${unique}.txt`, "alpha\n");
			const args = {
				input: [
					"*** Begin Patch",
					`*** Update File: remotetest://host/tmp/${unique}.txt`,
					"@@",
					"-alpha",
					"+beta",
					`*** Update File: ${local}`,
					"@@",
					"-one",
					"+two",
					"*** End Patch",
				].join("\n"),
			};
			const tool = edit("apply_patch");
			const previews = await streamPreview(tool, "atomic", args, wire);
			expect(remote.io).toEqual([]);
			expect(previews).toHaveLength(2);
			expect(previews.find(file => file.diff !== undefined)?.diff).toContain("two");
			const deferred = previews.find(file => file.path === `remotetest://host/tmp/${unique}.txt`);
			expect(deferred?.notice).toBe(DEFERRED);
			expect(deferred?.error).toBeUndefined();
			expect(streamingAborts(previews)).toBe(0);

			const result = await tool.execute("atomic", args);
			expect(result.isError).not.toBe(true);
			expect(remote.files.get(`/tmp/${unique}.txt`)).toBe("beta\n");
			expect(await Bun.file(local).text()).toBe("two\n");
		},
	);

	it("still emits the approval preview when recomputing an atomic patch never reports", async () => {
		const { dir, remote, read, edit, unique } = setup();
		using _dir = dir;
		remote.files.set(`/tmp/${unique}-read.txt`, "one\n");
		remote.files.set(`/tmp/${unique}-unread.txt`, "alpha\n");
		await read(`remotetest://host/tmp/${unique}-read.txt`);
		// Once the unread file is deferred, every later lookup hangs. Only the pass that
		// recomputes the patch without the deferred section looks the read file up again.
		let deferring = false;
		const stuck = Promise.withResolvers<void>();
		const hang = Promise.withResolvers<void>();
		remote.holdLocate = url => {
			if (deferring) {
				stuck.resolve();
				return hang.promise;
			}
			if (url.pathname.endsWith(`${unique}-unread.txt`)) deferring = true;
			return undefined;
		};
		const args = {
			input: [
				"*** Begin Patch",
				`*** Update File: remotetest://host/tmp/${unique}-read.txt`,
				"@@",
				"-one",
				"+two",
				`*** Update File: remotetest://host/tmp/${unique}-unread.txt`,
				"@@",
				"-alpha",
				"+beta",
				"*** End Patch",
			].join("\n"),
		};
		const tool = edit("apply_patch");
		vi.useFakeTimers();
		let previews: Preview[];
		try {
			const preview = streamPreview(tool, "stuck", args);
			await stuck.promise;
			// Past the recomputing pass's bound (5 s): it is abandoned.
			vi.advanceTimersByTime(5_000);
			previews = await preview;
		} finally {
			vi.useRealTimers();
			hang.resolve();
		}
		// The engine's own batch goes out, its deferral as a notice.
		expect(previews.map(file => [file.notice, file.error])).toEqual([[DEFERRED, undefined]]);
		expect(streamingAborts(previews)).toBe(0);

		remote.holdLocate = undefined;
		const result = await tool.execute("stuck", args);
		expect(result.isError).not.toBe(true);
		expect(remote.files.get(`/tmp/${unique}-read.txt`)).toBe("two\n");
		expect(remote.files.get(`/tmp/${unique}-unread.txt`)).toBe("beta\n");
	});

	it("refuses an explicit remote create in the preview without contacting the host", async () => {
		const { dir, remote, edit, unique } = setup();
		using _dir = dir;
		const local = path.join(dir.path(), "local.txt");
		await Bun.write(local, "one\n");
		const args = {
			input: [
				"*** Begin Patch",
				`*** Update File: ${local}`,
				"@@",
				"-one",
				"+two",
				`*** Add File: remotetest://host/tmp/${unique}.txt`,
				"+new",
				"*** End Patch",
			].join("\n"),
		};
		const refusal = `remotetest://host/tmp/${unique}.txt does not exist, and remotetest:// files can only be updated in place, so edit cannot create it`;
		const tool = edit("apply_patch");
		const previews = await streamPreview(tool, "create", args);
		expect(previews.some(file => file.error?.includes(refusal))).toBe(true);

		const result = await tool.execute("create", args);
		expect(result.isError).toBe(true);
		expect(text(result)).toContain(refusal);
		expect(remote.io).toEqual([]);
		expect(remote.files.has(`/tmp/${unique}.txt`)).toBe(false);
		expect(await Bun.file(local).text()).toBe("one\n");
	});

	it("never previews against a mirror read for a URL that resolved to another destination", async () => {
		const first = setup();
		using _first = first.dir;
		const second = setup(first.remote);
		using _second = second.dir;
		const file = `/tmp/${first.unique}.py`;
		first.remote.files.set(file, "def f():\n    return 1\n");
		const header = (await first.read(`remotetest://host${file}`)).split("\n")[0];
		first.remote.io.length = 0;

		// The second project resolves the same URL elsewhere: its preview waits for the
		// fetch instead of diffing the first project's copy.
		const args = { input: `${header}\nPUT 2.=2:\n+    return 2\n` };
		const previews = await streamPreview(second.edit("hashline"), "other-target", args);
		expect(previews.map(file => [file.notice, file.error])).toEqual([[DEFERRED, undefined]]);
		expect(first.remote.io).toEqual([]);
	});

	it("mirrors a remote file whose name is not a valid local filename", async () => {
		const { dir, remote, read, edit, unique } = setup();
		using _dir = dir;
		remote.files.set(`/tmp/${unique}-star*.txt`, "one\n");
		const header = (await read(`remotetest://host/tmp/${unique}-star%2A.txt`)).split("\n")[0];
		expect(header).toContain(`${unique}-star*.txt#`);

		const result = await edit("hashline").execute("star", { input: `${header}\nPUT 1.=1:\n+two\n` });
		expect(result.isError).not.toBe(true);
		expect(remote.files.get(`/tmp/${unique}-star*.txt`)).toBe("two\n");
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

	it("shares one mirror and tag between authorities that differ only in case", async () => {
		const { dir, remote, read, edit, unique } = setup();
		using _dir = dir;
		remote.files.set(`/tmp/${unique}.py`, "def f():\n    return 1\n");
		const header = (await read(`remotetest://HOST/tmp/${unique}.py`)).split("\n")[0];
		const tag = /#([0-9A-F]{4})\]$/.exec(header)?.[1];
		expect(header).toBe(`[remotetest://HOST/tmp/${unique}.py#${tag}]`);
		remote.io.length = 0;

		// Edited under the lowercase spelling, the read's mirror still serves the preview.
		const tool = edit("hashline");
		const args = { input: `[remotetest://host/tmp/${unique}.py#${tag}]\nPUT 2.=2:\n+    return 2\n` };
		const [preview] = await streamPreview(tool, "authority-case", args);
		expect(preview?.diff).toContain("return 2");
		expect(remote.io).toEqual([]);
		const result = await tool.execute("authority-case", args);
		expect(result.isError).not.toBe(true);
		expect(remote.files.get(`/tmp/${unique}.py`)).toBe("def f():\n    return 2\n");
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
