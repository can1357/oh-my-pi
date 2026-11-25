import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, resolveEquivalentPath, WhichCachePolicy } from "@oh-my-pi/pi-utils";
import { homebrewCellar, installRoot } from "./platform";
import { inheritedContainedEnv } from "./env";
import type { SandboxRuntime } from "./runtime";
import type { SandboxChild, SandboxNetworkMode } from "./types";

/**
 * Directories a contained process must read to start `command`: the directory of the resolved
 * executable and, when that is a symlink (`npx`, shims, Homebrew), what its real target needs: the
 * Homebrew Cellar holding it ({@link homebrewCellar}: the keg and the dependency kegs dyld loads),
 * else its {@link installRoot}, else (a target directly in home or a root child) its directory. A
 * command that resolves nowhere is reported here (as "`<what>` not found"), before the contained
 * spawn turns it into an opaque exit 127.
 */
async function commandReadRoots(
	command: string,
	cwd: string,
	env: Record<string, string | undefined>,
	what: string,
): Promise<string[]> {
	const resolved = path.isAbsolute(command)
		? command
		: // Fresh lookup: a cached miss would keep failing after the tool is installed, even on reconnect.
			($which(command, { PATH: env.PATH ?? env.Path ?? "", cwd, cache: WhichCachePolicy.Fresh }) ??
			path.resolve(cwd, command));
	let real: string;
	try {
		real = await fs.realpath(resolved);
	} catch {
		throw Object.assign(new Error(`${what} not found: ${command}`), { code: "ENOENT" });
	}
	if (real === resolved) return [path.dirname(resolved)];
	const home = resolveEquivalentPath(os.homedir());
	const root =
		homebrewCellar(real, home, process.platform) ?? installRoot(real, home, process.platform) ?? path.dirname(real);
	return [path.dirname(resolved), root];
}

/** What {@link spawnContainedCommand} starts. */
interface ContainedCommandSpawn {
	/** `argv[0]` is a command resolved on the contained env's `PATH` (or a path). */
	argv: string[];
	cwd: string;
	/** Names the command in the "not found" error (`MCP stdio command`, `LSP server command`, …). */
	what: string;
	/** Variables layered over the contained base env (an MCP server's `env`). */
	env?: Record<string, string | undefined>;
	network?: SandboxNetworkMode;
}

/**
 * Starts a workspace-resolvable command contained by `runtime`: omp's environment without its own
 * `.env` credentials or inherited git repo location ({@link inheritedContainedEnv}), plus read
 * access to the command's directory (and its symlink target's, {@link commandReadRoots}). The one
 * recipe contained MCP servers, language servers and linters share.
 */
export async function spawnContainedCommand(
	runtime: SandboxRuntime,
	{ argv, cwd, what, env, network }: ContainedCommandSpawn,
): Promise<SandboxChild> {
	const processEnv = inheritedContainedEnv(env);
	return await runtime.spawn({
		argv,
		cwd,
		env: processEnv,
		extraRead: await commandReadRoots(argv[0], cwd, processEnv, what),
		network,
	});
}
