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
		expect(await hooks.canonicalUrl(tilde, undefined, { localOnly: true })).toBeUndefined();
		expect(transport.commands).toHaveLength(0);

		const canonical = `ssh://${host}${home.split("/").map(encodeURIComponent).join("/")}/dir/a%20b.py`;
		expect(await hooks.canonicalUrl(tilde)).toBe(canonical);
		expect(await hooks.canonicalUrl(tilde, undefined, { localOnly: true })).toBe(canonical);
		expect(await hooks.canonicalUrl(parseInternalUrl(canonical), undefined, { localOnly: true })).toBe(canonical);
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
		await Bun.write(file, "﻿one\n");
		await fs.chmod(file, 0o640);
		const url = parseInternalUrl(`ssh://${host}/~/a.txt`);

		const source = await hooks.fetch(url);
		expect(source.content).toBe("﻿one\n");
		await Bun.write(file, "﻿two\n");
		const conflict = await hooks.update(url, "﻿three\n", source.checksum).catch((caught: unknown) => caught);
		expect(conflict).toBeInstanceOf(RemoteEditConflictError);
		expect(await Bun.file(file).text()).toBe("﻿two\n");

		const fresh = await hooks.fetch(url);
		await hooks.update(url, "﻿three\n", fresh.checksum);
		expect(await Bun.file(file).text()).toBe("﻿three\n");
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
