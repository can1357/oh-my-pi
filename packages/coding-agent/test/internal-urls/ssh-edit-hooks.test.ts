import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as capability from "../../src/capability";
import type { CapabilityResult } from "../../src/capability/types";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { RemoteEditConflictError, RemoteEditMissingError } from "../../src/internal-urls/remote-edit";
import { SshProtocolHandler } from "../../src/internal-urls/ssh-protocol";
import { fakeSshTransport } from "../helpers/fake-ssh-transport";

/** `text` behind a UTF-8 BOM, as bytes: `Bun.file().text()` would drop the BOM. */
const bom = (text: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);

// The fake remote is the local filesystem behind a POSIX shell.
describe.skipIf(process.platform === "win32")("ssh:// edit hooks", () => {
	const handler = new SshProtocolHandler();
	const hooks = handler.edit;
	let home: string;
	let host: string;

	beforeEach(async () => {
		home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ssh-edit-")));
		host = `fixture-${crypto.randomUUID()}`;
		vi.spyOn(capability, "loadCapability").mockResolvedValue({
			items: [],
			all: [],
			warnings: [],
			providers: [],
		} as CapabilityResult<unknown>);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(home, { recursive: true, force: true });
	});

	it("keys HOME-relative and absolute spellings by one URL, contacting the host for HOME at most once", async () => {
		const transport = fakeSshTransport(() => home);
		const tilde = parseInternalUrl(`ssh://${host}/~/dir/a%20b.py`);
		expect(await hooks.locate(tilde, undefined, { localOnly: true })).toBeUndefined();
		expect(transport.commands).toHaveLength(0);

		const canonical = `ssh://${host}${home.split("/").map(encodeURIComponent).join("/")}/dir/a%20b.py`;
		const located = await hooks.locate(tilde);
		expect(located?.url).toBe(canonical);
		expect(await hooks.locate(tilde, undefined, { localOnly: true })).toEqual(located);
		expect(await hooks.locate(parseInternalUrl(canonical), undefined, { localOnly: true })).toEqual(located);
		expect(transport.commands).toHaveLength(1);
	});

	it("refuses to fetch a symbolic link for an edit, naming the link and its target", async () => {
		fakeSshTransport(() => home);
		await Bun.write(path.join(home, "real.txt"), "real\n");
		await fs.symlink(path.join(home, "real.txt"), path.join(home, "link.txt"));
		const url = parseInternalUrl(`ssh://${host}/~/link.txt`);

		const error = await hooks.fetch(url).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(`/link.txt is a symbolic link to ${path.join(home, "real.txt")}`);
		const update = await hooks.update(url, "replaced\n", "0 0").catch((caught: unknown) => caught);
		expect((update as Error).message).toContain("/link.txt is a symbolic link");
		expect((await fs.lstat(path.join(home, "link.txt"))).isSymbolicLink()).toBe(true);
		expect(await Bun.file(path.join(home, "real.txt")).text()).toBe("real\n");
	});

	it("writes in place only while the file still matches the fetched checksum", async () => {
		fakeSshTransport(() => home);
		const file = path.join(home, "a.txt");
		await fs.writeFile(file, bom("one\n"));
		await fs.chmod(file, 0o640);
		const url = parseInternalUrl(`ssh://${host}/~/a.txt`);

		const source = await hooks.fetch(url);
		expect(Buffer.from(source.content)).toEqual(bom("one\n"));
		await fs.writeFile(file, bom("two\n"));
		const conflict = await hooks
			.update(url, bom("three\n").toString(), source.checksum)
			.catch((caught: unknown) => caught);
		expect(conflict).toBeInstanceOf(RemoteEditConflictError);
		expect(await fs.readFile(file)).toEqual(bom("two\n"));

		const fresh = await hooks.fetch(url);
		await hooks.update(url, bom("three\n").toString(), fresh.checksum);
		expect(await fs.readFile(file)).toEqual(bom("three\n"));
		expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
		expect((await fs.readdir(home)).filter(name => name.includes(".omp-tmp."))).toEqual([]);
	});

	it("reports a missing file as missing, so edit refuses to create it", async () => {
		fakeSshTransport(() => home);
		const error = await hooks
			.fetch(parseInternalUrl(`ssh://${host}/~/absent.txt`))
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(RemoteEditMissingError);
	});
});
