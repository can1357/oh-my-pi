/** Per-user discovery for terminal clients; sidebar chats never publish an endpoint. */
import * as fs from "node:fs/promises";
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
	return () => fs.unlink(file).catch(() => {});
}

// Mirrored loopback can reach Windows too. A live Linux PID is not proof that a
// record belongs to a Linux relay: both namespaces can assign the same PID.
async function wslLoopbackListeners(): Promise<Map<number, string>> {
	const listeners = new Map<number, string>();
	for (const row of (await fs.readFile("/proc/net/tcp", "utf8")).split("\n")) {
		const [, address, , state, , , , , , inode] = row.trim().split(/\s+/, 10);
		if (state === "0A" && address?.startsWith("0100007F:") && inode) {
			listeners.set(Number.parseInt(address.slice(9), 16), `socket:[${inode}]`);
		}
	}
	return listeners;
}

async function ownsListener(pid: number, socket: string): Promise<boolean> {
	const dir = `/proc/${pid}/fd`;
	for (const fd of await fs.readdir(dir)) {
		try {
			if ((await fs.readlink(path.join(dir, fd))) === socket) return true;
		} catch {
			// A descriptor can close between readdir and readlink.
		}
	}
	return false;
}

/** Discover live local relay hosts, preferring the most recently started. */
export async function discoverRelayEndpoints(): Promise<string[]> {
	const dir = discoveryDir();
	let names: string[];
	let listeners: Map<number, string> | undefined;
	try {
		names = await fs.readdir(dir);
		if (names.length) {
			const mode = getWslNetworkingMode();
			if (mode !== undefined && !/^(?:wsl1|nat|bridged|none|virtioproxy|consomme)$/.test(mode)) {
				listeners = await wslLoopbackListeners();
			}
		}
	} catch {
		return [];
	}
	const live: { port: number; started: number }[] = [];
	for (const name of names) {
		const match = /^(\d+)-(\d+)$/.exec(name);
		if (!match) continue;
		const pid = Number(match[1]);
		const port = Number(match[2]);
		if (pid < 1 || port < 1 || port > 65535) continue;
		try {
			if (listeners) {
				const socket = listeners.get(port);
				if (!socket || !(await ownsListener(pid, socket))) continue;
			} else {
				process.kill(pid, 0);
			}
			live.push({ port, started: (await fs.stat(path.join(dir, name))).mtimeMs });
		} catch {
			// The host may have exited or retired its record.
		}
	}
	return live.sort((a, b) => b.started - a.started).map(({ port }) => `http://127.0.0.1:${port}`);
}
