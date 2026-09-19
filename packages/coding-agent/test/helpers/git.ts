/**
 * Run a git command in `cwd`, failing the calling test if it exits non-zero.
 *
 * Global and system git config are neutralized so a developer's `~/.gitconfig` (hooks, aliases,
 * signing) cannot change what a fixture produces; identity is supplied per command. Every call
 * passes `-C`, so no process-wide cwd is touched and the helper stays safe under bun's
 * concurrent test runner.
 */
export function runGit(cwd: string, ...args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
	}
}
