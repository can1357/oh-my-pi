/** Per-user discovery for terminal clients; sidebar chats never publish an endpoint. */
import * as fs from "node:fs";
import * as path from "node:path";
import { getBrowserRelayInstallRegistryFile } from "@oh-my-pi/pi-utils/dirs";
import { getWslNetworkingMode } from "./wsl-networking";

function discoveryDir(): string {
	return path.join(path.dirname(getBrowserRelayInstallRegistryFile()), "endpoints");
}

/** Publish an OS-assigned port for this host's lifetime. */
export async function publishRelayEndpoint(port: number): Promise<() => Promise<void>> {
	const file = path.join(discoveryDir(), `${process.pid}-${port}`);
	await Bun.write(file, "", { mode: 0o600 });
	return () => fs.promises.unlink(file).catch(() => {});
}

// Mirrored loopback can reach Windows too. A live Linux PID is not proof that a
// record belongs to a Linux relay: both namespaces can assign the same PID.
function wslLoopbackListeners(): Map<number, string> {
	const listeners = new Map<number, string>();
	for (const row of fs.readFileSync("/proc/net/tcp", "utf8").split("\n")) {
		const [, address, , state, , , , , , inode] = row.trim().split(/\s+/, 10);
		if (state === "0A" && address?.startsWith("0100007F:") && inode) {
			listeners.set(Number.parseInt(address.slice(9), 16), `socket:[${inode}]`);
		}
	}
	return listeners;
}

function ownsListener(pid: number, socket: string): boolean {
	const dir = `/proc/${pid}/fd`;
	return fs.readdirSync(dir).some(fd => {
		try {
			return fs.readlinkSync(path.join(dir, fd)) === socket;
		} catch {
			return false;
		}
	});
}

/** Discover live local relay hosts, preferring the most recently started. */
export function discoverRelayEndpoints(): string[] {
	const dir = discoveryDir();
	let names: string[];
	let listeners: Map<number, string> | undefined;
	try {
		names = fs.readdirSync(dir);
		if (names.length) {
			const mode = getWslNetworkingMode();
			if (mode !== undefined && !/^(?:wsl1|nat|bridged|none|virtioproxy|consomme)$/.test(mode)) {
				listeners = wslLoopbackListeners();
			}
		}
	} catch {
		return [];
	}
	return names
		.flatMap(name => {
			const match = /^(\d+)-(\d+)$/.exec(name);
			if (!match) return [];
			const pid = Number(match[1]);
			const port = Number(match[2]);
			if (pid < 1 || port < 1 || port > 65535) return [];
			try {
				if (listeners) {
					const socket = listeners.get(port);
					if (!socket || !ownsListener(pid, socket)) return [];
				} else {
					process.kill(pid, 0);
				}
				return [{ port, started: fs.statSync(path.join(dir, name)).mtimeMs }];
			} catch {
				return [];
			}
		})
		.sort((a, b) => b.started - a.started)
		.map(({ port }) => `http://127.0.0.1:${port}`);
}
