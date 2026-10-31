import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";
import { writeRemoteFile } from "../../src/ssh/file-transfer";
import { fakeSshTransport } from "../helpers/fake-ssh-transport";

const target = { name: "update-fixture", host: "fixture" };
const content = new TextEncoder().encode("updated\n");

// The production remote script runs locally; it needs the same POSIX shell as an SSH host.
describe.skipIf(!Bun.which("sh"))("SSH targeted-update destination guard", () => {
	let dir: TempDir;
	let root: string;

	beforeEach(async () => {
		dir = await TempDir.create("@omp-ssh-update-");
		root = dir.path().replaceAll("\\", "/");
		fakeSshTransport(() => root);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await dir.remove();
	});

	it("reports a missing destination without creating it or retaining the staged file", async () => {
		await expect(
			writeRemoteFile(target, `${root}/missing.txt`, content, { requireRegularFile: true }),
		).rejects.toThrow("destination does not exist");
		expect(await fs.readdir(dir.path())).toEqual([]);
	});

	it("reports a directory destination without changing its contents or retaining the staged file", async () => {
		await fs.mkdir(dir.join("destination"));
		await expect(
			writeRemoteFile(target, `${root}/destination`, content, { requireRegularFile: true }),
		).rejects.toThrow("destination is a directory");
		expect(await fs.readdir(dir.join("destination"))).toEqual([]);
		expect(await fs.readdir(dir.path())).toEqual(["destination"]);
	});

	it("reports a symlink destination while preserving the link and its target", async () => {
		await fs.mkdir(dir.join("original"));
		await Bun.write(dir.join("original", "sentinel.txt"), "original\n");
		// A Windows junction exercises the POSIX shell's link check without elevation.
		await fs.symlink(dir.join("original"), dir.join("link"), process.platform === "win32" ? "junction" : "dir");
		const originalLink = await fs.readlink(dir.join("link"));
		await expect(writeRemoteFile(target, `${root}/link`, content, { requireRegularFile: true })).rejects.toThrow(
			"symlinks are not supported",
		);
		expect(await fs.readlink(dir.join("link"))).toBe(originalLink);
		expect(await Bun.file(dir.join("original", "sentinel.txt")).text()).toBe("original\n");
		expect((await fs.readdir(dir.path())).sort()).toEqual(["link", "original"]);
	});

	it("still updates an existing regular file and removes the staged file", async () => {
		await Bun.write(dir.join("regular.txt"), "original\n");
		await writeRemoteFile(target, `${root}/regular.txt`, content, { requireRegularFile: true });
		expect(await Bun.file(dir.join("regular.txt")).text()).toBe("updated\n");
		expect(await fs.readdir(dir.path())).toEqual(["regular.txt"]);
	});
});
