import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type SSHHost, sshCapability } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("ssh-config discovery", () => {
	let home = "";
	let cwd = "";

	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-config-home-"));
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-config-cwd-"));
		vi.spyOn(os, "homedir").mockReturnValue(home);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(home);
		await removeWithRetries(cwd);
	});

	/** Hosts from the temp home only; the machine's /etc/ssh/ssh_config may add its own. */
	async function load(providers: string[]): Promise<SSHHost[]> {
		const result = await loadCapability<SSHHost>(sshCapability.id, { cwd, providers });
		return result.items.filter(host => host._source.path.startsWith(home));
	}

	it("lists concrete Host aliases in config order, following Include", async () => {
		const sshDir = path.join(home, ".ssh");
		await fs.mkdir(path.join(sshDir, "config.d"), { recursive: true });
		await Bun.write(
			path.join(sshDir, "config"),
			[
				"# personal hosts",
				"Host web1 web2 *.corp !bastion",
				"  HostName 10.0.0.1",
				"Include config.d/*",
				"Match host foo exec true",
				"  User nobody",
				'Host=eq "quoted alias" # trailing comment',
				"HOST db?\r",
				"host upper\r",
				"Host *",
				"  ServerAliveInterval 30",
			].join("\n"),
		);
		await Bun.write(path.join(sshDir, "config.d", "b"), "Host from-b\n");
		await Bun.write(path.join(sshDir, "config.d", "a"), "Host from-a web1\nInclude ~/.ssh/config\n");
		const external = path.join(home, "dotfiles-host");
		await Bun.write(external, "Host linked\n");
		await fs.symlink(external, path.join(sshDir, "config.d", "c"));

		const hosts = await load(["ssh-config"]);

		expect(hosts.map(host => host.name)).toEqual([
			"web1",
			"web2",
			"from-a",
			"from-b",
			"linked",
			"eq",
			"quoted alias",
			"upper",
		]);
		// Only the alias is carried; OpenSSH resolves HostName/User/Port itself.
		expect(hosts[0]).toMatchObject({ name: "web1", host: "web1" });
		expect(hosts[0]?.username).toBeUndefined();
		expect(hosts.find(host => host.name === "from-a")?._source.path).toBe(path.join(sshDir, "config.d", "a"));
	});

	it("lets an ssh.json entry shadow the same-named ~/.ssh/config alias", async () => {
		await Bun.write(path.join(home, ".ssh", "config"), "Host prod staging\n");
		await Bun.write(path.join(cwd, "ssh.json"), JSON.stringify({ hosts: { prod: { host: "10.0.0.9" } } }));

		const result = await loadCapability<SSHHost>(sshCapability.id, { cwd, providers: ["ssh-json", "ssh-config"] });

		expect(result.items.find(host => host.name === "prod")).toMatchObject({ host: "10.0.0.9" });
		expect(result.items.find(host => host.name === "staging")).toMatchObject({ host: "staging" });
	});
});
