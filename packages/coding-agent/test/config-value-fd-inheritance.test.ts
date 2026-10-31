/**
 * `!command` config values must not leak inherited file descriptors into the
 * credential-resolving child.
 *
 * A launcher can legitimately hand omp an open descriptor (for example a
 * credential bundle) that is meant to stay single-consumer. The child spawned
 * for `auth.broker.url` / header `!command` resolution used to run through the
 * natives brush shell (executeShell), whose children inherit every inheritable
 * descriptor; the models.yml apiKey resolver (execSync) already spawned with
 * stdio pipes only. The fix converges the config-value path on ptree, which
 * keeps piped-only stdio while preserving executeShell's process-tree
 * termination on timeout.
 *
 * Oracle notes: the fd oracle must be an external helper script whose body is
 * `cat <&3` — brush rejects inline `<&3` in the command string while still
 * passing inherited fds to external children. A positive control runs first so
 * the fd assertion cannot pass vacuously (e.g. if the resolver stopped
 * executing commands at all). No /proc dependency, so the oracle
 * discriminates on every non-Windows platform.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const resolverUrl = pathToFileURL(path.join(import.meta.dir, "../src/config/resolve-config-value.ts")).href;

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")(
	"config !command children cannot read descriptors the launcher passed omp",
	async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-config-fd-"));
		roots.push(root);
		const canaryPath = path.join(root, "canary.txt");
		await fs.promises.writeFile(canaryPath, "CANARY-THAT-MUST-NOT-RESOLVE");
		const spyPath = path.join(root, "fd3-spy.sh");
		await fs.promises.writeFile(spyPath, "#!/usr/bin/env bash\ncat <&3\n", { mode: 0o755 });

		// The child receives fd 3 the way a launcher would pass one: an extra
		// stdio entry, dup2'd in regardless of close-on-exec state.
		const canary = await fs.promises.open(canaryPath, "r");
		try {
			// The resolver must load in a child process: fd inheritance only exists
			// across a real exec boundary, so the probe runs via --eval in a spawned
			// bun (same pattern as cli-provider-api-keys.test.ts). The positive
			// control asserts command execution works through the same resolver
			// before the fd case requires `undefined`.
			const script = `import { resolveConfigValue } from ${JSON.stringify(resolverUrl)};
const control = await resolveConfigValue("!echo positive-control-ok");
console.log(control === "positive-control-ok" ? "CONTROL-OK" : "CONTROL-BAD:" + control);
const value = await resolveConfigValue("!${spyPath}");
console.log(value === undefined ? "RESOLVED-UNDEFINED" : "LEAKED:" + value);
`;
			const proc = Bun.spawn({
				cmd: [process.execPath, "--eval", script],
				cwd: process.cwd(),
				stdio: ["ignore", "pipe", "pipe", canary.fd],
				timeout: 15_000,
			});
			const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			expect(exitCode, stdout).toBe(0);
			const lines = stdout.trim().split("\n");
			expect(lines[0], "positive control: commands must still resolve").toBe("CONTROL-OK");
			expect(lines[1], "fd oracle: the canary must not resolve").toBe("RESOLVED-UNDEFINED");
		} finally {
			await canary.close();
		}
	},
);

test.skipIf(process.platform === "win32")("resolves !commands when PATH omits the shell entirely", async () => {
	// A launcher may supply a minimal tool-only PATH; the resolver must still
	// find the OS shell. Probing in a subprocess so the stripped PATH cannot
	// affect this test process's own spawns.
	const script = `import { runShellCommand } from ${JSON.stringify(resolverUrl)};
const value = await runShellCommand("echo pathless-ok", 5_000);
console.log(value === "pathless-ok" ? "PATHLESS-OK" : "PATHLESS-BAD:" + value);`;
	const emptyPathDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-no-sh-in-path-"));
	roots.push(emptyPathDir);
	const proc = Bun.spawn({
		cmd: [process.execPath, "--eval", script],
		cwd: process.cwd(),
		env: { ...Bun.env, PATH: emptyPathDir },
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 15_000,
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	expect(exitCode, stdout).toBe(0);
	expect(stdout.trim()).toBe("PATHLESS-OK");
});
