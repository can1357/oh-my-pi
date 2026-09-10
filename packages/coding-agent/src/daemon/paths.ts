import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir } from "@oh-my-pi/pi-utils";

export const DAEMON_TOKEN_FILE = "daemon.token";
export const DAEMON_SOCKET_FILE = "daemon.sock";
export const DAEMON_OWNER_FILE = "daemon.owner";

export async function readDaemonOwnerPid(runtimeDir: string): Promise<number | undefined> {
	try {
		const owner = (await Bun.file(path.join(runtimeDir, DAEMON_OWNER_FILE)).json()) as { pid?: unknown };
		return typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0 ? owner.pid : undefined;
	} catch {
		return undefined;
	}
}

/** Resolve a project root through symlinks when it exists. */
export async function canonicalProjectRoot(projectRoot: string): Promise<string> {
	const resolved = path.resolve(projectRoot);
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return resolved;
		throw error;
	}
}

/** Resolve the private runtime directory for the active profile daemon. */
export function daemonRuntimeDir(configRoot: string = getConfigRootDir()): string {
	return path.join(configRoot, "run", "daemon");
}

/** Resolve the Unix socket endpoint for a shard runtime directory. */
export function daemonEndpoint(runtimeDir: string): string {
	return path.join(runtimeDir, DAEMON_SOCKET_FILE);
}

/** Ensure the runtime directory is private to the current user. */
export async function ensureDaemonRuntimeDir(runtimeDir: string): Promise<void> {
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	await fs.chmod(runtimeDir, 0o700);
}

/** Return the token path for a runtime directory. */
export function daemonTokenPath(runtimeDir: string): string {
	return path.join(runtimeDir, DAEMON_TOKEN_FILE);
}

/** Read an existing token or atomically create a private cryptographic token. */
export async function readOrCreateDaemonToken(runtimeDir: string): Promise<string> {
	await ensureDaemonRuntimeDir(runtimeDir);
	const tokenPath = daemonTokenPath(runtimeDir);
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const token = (await Bun.file(tokenPath).text()).trim();
			if (token.length > 0) {
				await fs.chmod(tokenPath, 0o600);
				return token;
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		try {
			const handle = await fs.open(tokenPath, "wx", 0o600);
			try {
				const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
				await handle.writeFile(token, "utf8");
				return token;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
		await Bun.sleep(1);
	}
	throw new Error(`Timed out initializing daemon token in ${runtimeDir}`);
}
