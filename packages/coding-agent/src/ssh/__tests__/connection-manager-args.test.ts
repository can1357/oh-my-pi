import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getRemoteHostDir } from "@pk-nerdsaver-ai/pi-utils";
import { buildRemoteCommand, getHostInfo, type SSHConnectionTarget, type SSHHostShell } from "../connection-manager";
import { buildSshTarget, sanitizeHostName } from "../utils";

const TARGET: SSHConnectionTarget = { name: "h", host: "h" };

describe("buildRemoteCommand stdin handling", () => {
	it("includes -n by default so ssh reads stdin from /dev/null", async () => {
		const args = await buildRemoteCommand(TARGET, "cat");
		expect(args).toContain("-n");
	});

	it("omits -n when allowStdin is set so the remote command reads piped stdin", async () => {
		const args = await buildRemoteCommand(TARGET, "cat", { allowStdin: true });
		expect(args).not.toContain("-n");
	});
});

describe("buildSshTarget argument-injection guard", () => {
	it("rejects a host that begins with '-' (ssh would parse it as an option)", () => {
		expect(() => buildSshTarget(undefined, "-oProxyCommand=touch /tmp/pwned")).toThrow(/must not begin with/);
	});

	it("rejects a username that begins with '-'", () => {
		expect(() => buildSshTarget("-oProxyCommand=x", "host")).toThrow(/must not begin with/);
	});

	it("renders a normal destination unchanged", () => {
		expect(buildSshTarget("user", "host")).toBe("user@host");
		expect(buildSshTarget(undefined, "host")).toBe("host");
	});

	it("rejects a dash-leading host through the real buildRemoteCommand path", async () => {
		await expect(buildRemoteCommand({ name: "x", host: "-oProxyCommand=x" }, "cat")).rejects.toThrow(
			/must not begin with/,
		);
	});
});

describe("ssh host shell classification", () => {
	it("treats fish/csh/tcsh as non-POSIX (unknown) and keeps real sh-family as sh", async () => {
		// parseHostInfo re-runs parseShell on the stored shell field, so getHostInfo
		// exercises the classifier through a public seam. The ensurePosixRemote
		// whitelist then refuses anything that isn't sh/bash/zsh.
		const cases: Array<[string, SSHHostShell]> = [
			["/usr/bin/fish", "unknown"],
			["/bin/csh", "unknown"],
			["/bin/tcsh", "unknown"],
			["/bin/dash", "sh"],
			["/bin/sh", "sh"],
			["/usr/bin/bash", "bash"],
			["/usr/bin/zsh", "zsh"],
		];
		for (const [shellValue, expected] of cases) {
			const name = `omp-shellclf-${crypto.randomUUID()}`;
			const file = path.join(getRemoteHostDir(), `${sanitizeHostName(name)}.json`);
			await Bun.write(file, JSON.stringify({ version: 3, os: "linux", shell: shellValue, compatEnabled: false }));
			try {
				const info = await getHostInfo(name);
				expect(info?.shell).toBe(expected);
			} finally {
				await fs.promises.rm(file, { force: true });
			}
		}
	});
});
