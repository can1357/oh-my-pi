import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type LocalProtocolOptions, resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import { executeShell, ShellFsFileType, ShellFsOp } from "@oh-my-pi/pi-natives";

const READ = { read: true, write: false, append: false, truncate: false, create: false, createNew: false };
const CREATE = { read: false, write: true, append: false, truncate: true, create: true, createNew: false };

let tempDir: string;
let localOptions: LocalProtocolOptions;
let localRoot: string;

function shellFs(tier: "read" | "write" | "exec" = "exec"): InternalUrlFilesystem {
	return new InternalUrlFilesystem({ context: { localProtocolOptions: localOptions }, tier });
}

/**
 * Create `link` holding the literal `target`, as the native shell's `ln -s` does.
 * Node's `fs.symlink` rewrites `/` to `\` in the target on Windows, mangling a URL.
 */
async function nativeSymlink(target: string, link: string): Promise<void> {
	const result = await executeShell({
		command: `ln -s '${target}' '${path.basename(link)}'`,
		cwd: path.dirname(link),
	});
	if (result.exitCode !== 0) throw new Error(`ln -s ${target} ${link} exited ${result.exitCode}`);
}

beforeEach(async () => {
	tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "url-fs-")));
	localOptions = { getArtifactsDir: () => tempDir, getSessionId: () => "session" };
	localRoot = resolveLocalRoot(localOptions);
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("InternalUrlFilesystem local://", () => {
	it("creates write targets in the session root, which exists like a mount point", async () => {
		const response = await shellFs().handle({ op: ShellFsOp.Open, path: "local://out.txt", open: CREATE });

		expect(response).toEqual({ local: path.join(localRoot, "out.txt") });
		expect((await fs.stat(localRoot)).isDirectory()).toBe(true);
	});

	it("addresses entry names that need percent-encoding, as the first segment and below", async () => {
		// `?` and `:` are illegal in Windows file names; the rest still needs encoding.
		const [name, encoded] =
			process.platform === "win32"
				? ["we ird #%41 a@b", "we%20ird%20%23%2541%20a@b"]
				: ["we?ird #%41 a@b:1", "we%3Fird%20%23%2541%20a@b:1"];
		await fs.mkdir(path.join(localRoot, name), { recursive: true });
		await fs.writeFile(path.join(localRoot, name, name), "x");

		await expect(shellFs().handle({ op: ShellFsOp.Metadata, path: `local://${encoded}` })).resolves.toEqual({
			local: path.join(localRoot, name),
		});
		await expect(
			shellFs().handle({ op: ShellFsOp.RemoveFile, path: `local://${encoded}/${encoded}` }),
		).resolves.toEqual({ local: path.join(localRoot, name, name) });
	});

	it("reports a missing file as ENOENT instead of creating it", async () => {
		const response = await shellFs().handle({ op: ShellFsOp.Open, path: "local://missing.txt", open: READ });

		expect(response.error?.code).toBe("ENOENT");
		await expect(fs.stat(path.join(localRoot, "missing.txt"))).rejects.toThrow();
	});

	it("keeps an existing entry whose name ends like a read selector", async () => {
		// `:` is illegal in Windows file names.
		if (process.platform === "win32") return;
		await fs.mkdir(localRoot, { recursive: true });
		await fs.writeFile(path.join(localRoot, "notes.md"), "one\ntwo\n");
		await fs.writeFile(path.join(localRoot, "notes.md:1"), "literal\n");

		await expect(shellFs().handle({ op: ShellFsOp.Open, path: "local://notes.md:1", open: READ })).resolves.toEqual({
			local: path.join(localRoot, "notes.md:1"),
		});
	});

	it("follows a symlink whose literal target is a URL while readlink keeps the link itself", async () => {
		await fs.mkdir(localRoot, { recursive: true });
		await fs.writeFile(path.join(localRoot, "source.txt"), "source\n");
		const link = await shellFs().handle({
			op: ShellFsOp.Symlink,
			path: "local://link",
			target: "local://source.txt",
		});
		expect(link).toEqual({ local: path.join(localRoot, "link") });
		// What the native side does with that redirect: the link stores the URL verbatim.
		await nativeSymlink("local://source.txt", path.join(localRoot, "link"));

		await expect(shellFs().handle({ op: ShellFsOp.Open, path: "local://link", open: READ })).resolves.toEqual({
			local: path.join(localRoot, "source.txt"),
		});
		await expect(shellFs().handle({ op: ShellFsOp.ReadLink, path: "local://link" })).resolves.toEqual({
			local: path.join(localRoot, "link"),
		});
		await expect(shellFs().handle({ op: ShellFsOp.Canonicalize, path: "local://link" })).resolves.toEqual({
			path: "local://source.txt",
		});
	});

	it("applies the link target's write policy when writing through a URL symlink", async () => {
		await fs.mkdir(localRoot, { recursive: true });
		await nativeSymlink("omp://README.md", path.join(localRoot, "doc"));

		const response = await shellFs().handle({ op: ShellFsOp.Open, path: "local://doc", open: CREATE });

		expect(response.error?.code).toBe("EROFS");
	});

	it("backs URLs onto host paths, including would-be paths of missing entries, without creating them", async () => {
		await fs.mkdir(path.join(localRoot, "dir"), { recursive: true });

		await expect(shellFs().handle({ op: ShellFsOp.BackingPath, path: "local://dir" })).resolves.toEqual({
			path: path.join(localRoot, "dir"),
		});
		await expect(shellFs().handle({ op: ShellFsOp.BackingPath, path: "local://dir/new/file.txt" })).resolves.toEqual({
			path: path.join(localRoot, "dir", "new", "file.txt"),
		});
		await expect(fs.stat(path.join(localRoot, "dir", "new"))).rejects.toThrow();
		await expect(shellFs().handle({ op: ShellFsOp.BackingPath, path: "omp://" })).resolves.toEqual({});
	});

	it("refuses renames that leave the URL namespace", async () => {
		await fs.mkdir(localRoot, { recursive: true });
		await fs.writeFile(path.join(localRoot, "a.txt"), "a");

		const response = await shellFs().handle({
			op: ShellFsOp.Rename,
			path: "local://a.txt",
			target: path.join(tempDir, "a.txt"),
		});

		expect(response.error?.code).toBe("EXDEV");
	});
});

describe("InternalUrlFilesystem read selectors", () => {
	/** Bytes a command reading `url` receives, or the errno its open fails with. */
	async function readUrl(url: string): Promise<string> {
		const filesystem = shellFs();
		const opened = await filesystem.handle({ op: ShellFsOp.Open, path: url, open: READ });
		if (opened.error) return opened.error.code;
		if (opened.local !== undefined) return fs.readFile(opened.local, "utf-8");
		const handle = opened.handle;
		if (handle === undefined) throw new Error(`open ${url} returned neither a path nor a handle`);
		const read = await filesystem.handle({ op: ShellFsOp.Read, handle, offset: 0n, length: 1 << 20 });
		await filesystem.handle({ op: ShellFsOp.Close, handle });
		return Buffer.from(read.data ?? []).toString("utf-8");
	}

	beforeEach(async () => {
		await fs.mkdir(localRoot, { recursive: true });
		await fs.writeFile(path.join(localRoot, "7.log"), '{"n":1}\n{"n":2}\n{"n":3}\n{"n":4}');
	});

	it("opens the backing file itself for :raw, so external programs receive its path too", async () => {
		const filesystem = shellFs();
		const backing = path.join(localRoot, "7.log");

		await expect(filesystem.handle({ op: ShellFsOp.Open, path: "local://7.log:raw", open: READ })).resolves.toEqual({
			local: backing,
		});
		await expect(filesystem.handle({ op: ShellFsOp.BackingPath, path: "local://7.log:raw" })).resolves.toEqual({
			path: backing,
		});
	});

	it("serves exactly the selected lines, each with its terminator", async () => {
		expect(await readUrl("local://7.log:2")).toBe('{"n":2}\n');
		expect(await readUrl("local://7.log:raw:2-3")).toBe('{"n":2}\n{"n":3}\n');
		expect(await readUrl("local://7.log:2-3:raw")).toBe('{"n":2}\n{"n":3}\n');
		expect(await readUrl("local://7.log:1,3")).toBe('{"n":1}\n{"n":3}\n');
		expect(await readUrl("local://7.log:2+2")).toBe('{"n":2}\n{"n":3}\n');
		// The last line has no terminator in the spill, so none is invented.
		expect(await readUrl("local://7.log:3-")).toBe('{"n":3}\n{"n":4}');
		expect(await readUrl("local://7.log:-2")).toBe('{"n":3}\n{"n":4}');
		expect(await readUrl("local://7.log:1,-1")).toBe('{"n":1}\n{"n":4}');
	});

	it("reports the selected bytes as the file's size and refuses to write through a line selector", async () => {
		const filesystem = shellFs();

		await expect(filesystem.handle({ op: ShellFsOp.Metadata, path: "local://7.log:2-3" })).resolves.toEqual({
			metadata: { fileType: ShellFsFileType.File, size: 16, mode: 0o444 },
		});
		const removed = await filesystem.handle({ op: ShellFsOp.RemoveFile, path: "local://7.log:2-3" });
		expect(removed.error?.code).toBe("EROFS");
	});

	it("selects nothing past the end and keeps missing resources missing", async () => {
		expect(await readUrl("local://7.log:9-12")).toBe("");
		expect(await readUrl("local://404.log:raw")).toBe("ENOENT");
		expect(await readUrl("local://404.log:1-2")).toBe("ENOENT");
		expect(await readUrl("local://missing.json:1-2")).toBe("ENOENT");
	});

	it("rejects a malformed selector instead of reading the whole resource", async () => {
		expect(await readUrl("local://7.log:0")).toBe("EINVAL");
		expect(await readUrl("local://7.log:3-1")).toBe("EINVAL");
	});

	it("selects lines of local:// files and of rendered resources", async () => {
		await fs.mkdir(localRoot, { recursive: true });
		await fs.writeFile(path.join(localRoot, "rows.jsonl"), "a\nb\nc\n");
		const filesystem = shellFs();
		const listing = await filesystem.handle({ op: ShellFsOp.ReadDir, path: "omp://" });
		const entry = listing.entries?.find(item => item.fileType === ShellFsFileType.File);
		if (!entry) throw new Error("omp:// listed no documents");
		const whole = await readUrl(`omp://${entry.name}`);

		expect(await readUrl("local://rows.jsonl:raw:2")).toBe("b\n");
		expect(await readUrl("local://rows.jsonl:-1")).toBe("c\n");
		expect(await readUrl(`omp://${entry.name}:1`)).toBe(whole.slice(0, whole.indexOf("\n") + 1));
	});
});

describe("InternalUrlFilesystem cancellation", () => {
	it("refuses new work after the run is cancelled but still serves the shell's cleanup", async () => {
		const controller = new AbortController();
		const filesystem = new InternalUrlFilesystem({
			context: { localProtocolOptions: localOptions, signal: controller.signal },
			tier: "exec",
		});
		await fs.mkdir(localRoot, { recursive: true });
		controller.abort();

		const work = await filesystem.handle({ op: ShellFsOp.Open, path: "local://t.tmp", open: CREATE });
		const cleanup = await filesystem.handle({ op: ShellFsOp.RemoveFile, path: "local://t.tmp", cleanup: true });

		expect(work.error?.code).toBe("ECANCELED");
		expect(cleanup).toEqual({ local: path.join(localRoot, "t.tmp") });
	});
});

describe("InternalUrlFilesystem policy", () => {
	it("refuses shell writes to handler-written schemes", async () => {
		const response = await shellFs().handle({ op: ShellFsOp.Open, path: "agent://Worker", open: CREATE });

		expect(response.error?.code).toBe("EROFS");
		expect(response.error?.message).toContain("write tool");
	});

	it("refuses schemes whose read tier exceeds the command's approval tier", async () => {
		const response = await shellFs("write").handle({ op: ShellFsOp.Metadata, path: "ssh://host/etc/hosts" });

		expect(response.error?.code).toBe("EACCES");
	});
});

describe("InternalUrlFilesystem rendered resources", () => {
	it("serves omp:// as a read-only tree whose files hold the rendered bytes", async () => {
		const filesystem = shellFs();
		const listing = await filesystem.handle({ op: ShellFsOp.ReadDir, path: "omp://" });
		const entry = listing.entries?.find(item => item.fileType === ShellFsFileType.File);
		if (!entry) throw new Error("omp:// listed no documents");
		const url = `omp://${entry.name}`;

		const opened = await filesystem.handle({ op: ShellFsOp.Open, path: url, open: READ });
		const handle = opened.handle;
		if (handle === undefined) throw new Error(`open ${url} returned no handle`);
		const metadata = await filesystem.handle({ op: ShellFsOp.FileMetadata, handle });
		const read = await filesystem.handle({ op: ShellFsOp.Read, handle, offset: 0n, length: 1 << 20 });
		const rendered = await filesystem.handle({ op: ShellFsOp.Open, path: url, open: CREATE });
		await filesystem.handle({ op: ShellFsOp.Close, handle });

		expect(metadata.metadata).toEqual({
			fileType: ShellFsFileType.File,
			size: read.data?.length ?? -1,
			mode: 0o444,
		});
		expect(read.data?.length).toBeGreaterThan(0);
		expect(rendered.error?.code).toBe("EROFS");
	});
});
