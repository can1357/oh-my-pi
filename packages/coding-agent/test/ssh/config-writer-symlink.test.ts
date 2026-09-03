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

	it("writes to the referent, keeping the ssh.json symlink and its mode intact", async () => {
		const target = path.join(dir, "real-ssh.json");
		await fs.writeFile(target, JSON.stringify({ hosts: {} }), { mode: 0o640 });
		await fs.chmod(target, 0o640);
		const link = path.join(dir, "ssh.json");
		await fs.symlink(target, link);

		await addSSHHost(link, "alpha", { host: "example.com" });

		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		const config = await readSSHConfigFile(link);
		expect(Object.keys(config.hosts ?? {})).toEqual(["alpha"]);
		expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
	});
});
