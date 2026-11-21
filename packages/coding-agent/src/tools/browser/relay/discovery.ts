/** Per-user discovery for terminal clients; sidebar chats never publish an endpoint. */
import * as fs from "node:fs";
import * as path from "node:path";
import { getBrowserRelayInstallRegistryFile } from "@oh-my-pi/pi-utils/dirs";

function discoveryDir(): string {
	return path.join(path.dirname(getBrowserRelayInstallRegistryFile()), "endpoints");
}

/** Publish an OS-assigned port for this host's lifetime. */
export async function publishRelayEndpoint(port: number): Promise<() => Promise<void>> {
	const file = path.join(discoveryDir(), `${process.pid}-${port}`);
	await Bun.write(file, "", { mode: 0o600 });
	return () => fs.promises.unlink(file).catch(() => {});
}

/** Discover live local relay hosts, preferring the most recently started. */
export function discoverRelayEndpoints(): string[] {
	const dir = discoveryDir();
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names.flatMap(name => {
		const match = /^(\d+)-(\d+)$/.exec(name);
		if (!match) return [];
		const pid = Number(match[1]);
		const port = Number(match[2]);
		if (pid < 1 || port < 1 || port > 65535) return [];
		try {
			process.kill(pid, 0);
			return [{ port, started: fs.statSync(path.join(dir, name)).mtimeMs }];
		} catch {
			return [];
		}
	}).sort((a, b) => b.started - a.started).map(({ port }) => `http://127.0.0.1:${port}`);
}
