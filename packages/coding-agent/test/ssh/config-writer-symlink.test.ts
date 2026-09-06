import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { addSSHHost, readSSHConfigFile } from "../../src/ssh/config-writer";

// rename() over a symlink path replaces the LINK with a regular file, so an
// ssh.json managed via symlink (e.g. a dotfiles checkout) must be written at
// its referent. Skipped on Windows where unprivileged symlink creation is
// unavailable.
describe.skipIf(process.platform === "win32")("ssh config-writer symlinked configs", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-symlink-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("writes to the referent, keeping the ssh.json symlink and tightening its mode to owner-only", async () => {
		const target = path.join(dir, "real-ssh.json");
		await fs.writeFile(target, JSON.stringify({ hosts: {} }));
		await fs.chmod(target, 0o640);
		const link = path.join(dir, "ssh.json");
		await fs.symlink(target, link);

		await addSSHHost(link, "alpha", { host: "example.com" });

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		const config = await readSSHConfigFile(link);
		expect(Object.keys(config.hosts ?? {})).toEqual(["alpha"]);
		// Group/world bits are dropped (credential-adjacent file); owner bits
		// are preserved.
		expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
	});

	it("serializes read-modify-writes that alias one target through two symlinks", async () => {
		// Two configured paths, one physical ssh.json. The read-modify-write
		// must lock on the resolved target (and stage a per-writer temp) so
		// both mutations land; without the lock both read the same old JSON
		// and the last rename drops the other's host.
		const target = path.join(dir, "real-ssh.json");
		await fs.writeFile(target, JSON.stringify({ hosts: {} }));
		const linkA = path.join(dir, "ssh-a.json");
		const linkB = path.join(dir, "ssh-b.json");
		await fs.symlink(target, linkA);
		await fs.symlink(target, linkB);

		await Promise.all([
			addSSHHost(linkA, "alpha", { host: "alpha.example.com" }),
			addSSHHost(linkB, "bravo", { host: "bravo.example.com" }),
		]);

		const config = await readSSHConfigFile(linkA);
		expect(Object.keys(config.hosts ?? {}).sort()).toEqual(["alpha", "bravo"]);
	});
});
