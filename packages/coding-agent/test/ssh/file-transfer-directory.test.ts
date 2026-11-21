import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ShellFsFileType } from "@oh-my-pi/pi-natives";
import * as connectionManager from "../../src/ssh/connection-manager";
import { listRemoteDir } from "../../src/ssh/file-transfer";
import { fakeSshTransport } from "../helpers/fake-ssh-transport";

const target = { name: "directory-fixture", host: "fixture" };

// The fake remote is the local filesystem behind a POSIX shell.
describe.skipIf(process.platform === "win32")("SSH structured directory transport", () => {
	let fixture: string;
	let onSpawn: (() => void) | undefined;

	beforeEach(async () => {
		fixture = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-directory-"));
		onSpawn = undefined;
		fakeSshTransport(
			() => fixture,
			() => onSpawn?.(),
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(fixture, { recursive: true, force: true });
	});

	it("preserves newline, whitespace and metacharacter filenames as single typed entries", async () => {
		await fs.mkdir(path.join(fixture, "sub directory"));
		for (const name of ["two words.txt", "line\nbreak.txt", "quote' #?% $.txt", ".hidden"]) {
			await Bun.write(path.join(fixture, name), "text\n");
		}
		await fs.symlink(path.join(fixture, "sub directory"), path.join(fixture, "link"));
		const entries = await listRemoteDir(target, fixture);
		expect(entries).toContainEqual({ name: "sub directory", fileType: ShellFsFileType.Dir });
		expect(entries).toContainEqual({ name: "link", fileType: ShellFsFileType.Symlink });
		for (const name of ["two words.txt", "line\nbreak.txt", "quote' #?% $.txt", ".hidden"]) {
			expect(entries).toContainEqual({ name, fileType: ShellFsFileType.File });
		}
		expect(entries).toHaveLength(6);
	});

	it("refuses an oversized directory response rather than returning an incomplete search scope", async () => {
		vi.spyOn(connectionManager, "buildRemoteCommand").mockResolvedValue(["--fixture", "head -c 1048577 /dev/zero"]);
		await expect(listRemoteDir(target, fixture)).rejects.toThrow(/directory listing.*1 MiB/i);
	});

	it("rejects malformed directory framing instead of inventing filenames", async () => {
		vi.spyOn(connectionManager, "buildRemoteCommand").mockResolvedValue([
			"--fixture",
			"printf 'file\\000unterminated'",
		]);
		await expect(listRemoteDir(target, fixture)).rejects.toThrow(/(?:invalid|malformed) directory/i);
	});

	it("reports missing directory and transport failures without an empty-success fallback", async () => {
		await expect(listRemoteDir(target, `${fixture}/missing`)).rejects.toThrow(/No such file|can't cd|cannot cd/i);
		vi.spyOn(connectionManager, "buildRemoteCommand").mockResolvedValue([
			"--fixture",
			"printf 'SSH transport disconnected' >&2; exit 255",
		]);
		await expect(listRemoteDir(target, fixture)).rejects.toThrow(/SSH transport disconnected/);
	});

	it("cancels an in-flight directory transfer without returning a partial listing", async () => {
		const controller = new AbortController();
		vi.spyOn(connectionManager, "buildRemoteCommand").mockResolvedValue(["--fixture", "sleep 30"]);
		onSpawn = () => controller.abort(new Error("directory transfer cancelled"));
		await expect(listRemoteDir(target, fixture, { signal: controller.signal })).rejects.toThrow(/cancel|abort/i);
	});
});
