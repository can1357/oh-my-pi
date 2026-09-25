import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type LocalProtocolOptions, resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import { ShellFsFileType, ShellFsOp } from "@oh-my-pi/pi-natives";

const READ = { read: true, write: false, append: false, truncate: false, create: false, createNew: false };
const CREATE = { read: false, write: true, append: false, truncate: true, create: true, createNew: false };

let tempDir: string;
let localOptions: LocalProtocolOptions;
let localRoot: string;

function shellFs(tier: "read" | "write" | "exec" = "exec"): InternalUrlFilesystem {
	return new InternalUrlFilesystem({ context: { localProtocolOptions: localOptions }, tier });
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
		const name = "we?ird #%41 a@b:1";
		const encoded = "we%3Fird%20%23%2541%20a@b:1";
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

	it("keeps a trailing read selector as part of the file name", async () => {
		await fs.mkdir(localRoot, { recursive: true });
		await fs.writeFile(path.join(localRoot, "notes.md"), "whole\n");

		const response = await shellFs().handle({ op: ShellFsOp.Open, path: "local://notes.md:1-2", open: READ });

		expect(response.error?.code).toBe("ENOENT");
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
		await fs.symlink("local://source.txt", path.join(localRoot, "link"));

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
		await fs.symlink("omp://README.md", path.join(localRoot, "doc"));

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
