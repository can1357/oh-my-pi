import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { privateEndpoint } from "@oh-my-pi/pi-coding-agent/ipc/private-endpoint";
import {
	listSessionHosts,
	SESSION_HOST_REGISTRY_VERSION,
	type SessionHostEntry,
	writeHostEntry,
} from "@oh-my-pi/pi-coding-agent/session-host/registry";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let dir: string;
afterEach(async () => dir && (await removeWithRetries(dir)));

async function listenOn(registryDir: string, hostId: string): Promise<{ endpoint: string; close(): void }> {
	const endpoint = await privateEndpoint(registryDir, hostId, { prefix: "host", label: "test" });
	const server = net.createServer(socket => socket.on("error", () => {}));
	const listening = Promise.withResolvers<void>();
	server.listen(endpoint, () => listening.resolve());
	await listening.promise;
	return { endpoint, close: () => server.close() };
}

function entry(hostId: string, endpoint: string): SessionHostEntry {
	return {
		version: SESSION_HOST_REGISTRY_VERSION,
		hostId,
		pid: process.pid,
		endpoint,
		token: "t".repeat(64),
		cwd: dir,
		sessionFile: undefined,
		title: undefined,
		clients: 0,
		busy: false,
		startedAt: Date.now(),
	};
}

describe("session host registry", () => {
	it("lists live hosts and prunes an entry whose endpoint is gone", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hosts-"));
		const live = await listenOn(dir, "aaaaaaaaaaaaaaaa");
		await writeHostEntry(entry("aaaaaaaaaaaaaaaa", live.endpoint), dir);
		await writeHostEntry(entry("bbbbbbbbbbbbbbbb", path.join(dir, "gone.sock")), dir);
		expect((await listSessionHosts(dir)).map(e => e.hostId)).toEqual(["aaaaaaaaaaaaaaaa"]);
		expect(await Bun.file(path.join(dir, "bbbbbbbbbbbbbbbb.json")).exists()).toBe(false);
		live.close();
	});

	it("unlinks a dead host's own socket but never a crafted endpoint outside the registry", async () => {
		if (process.platform === "win32") return;
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hosts-"));
		const registryDir = path.join(dir, "registry");
		await fs.mkdir(registryDir, { mode: 0o700 });
		// Regular files refuse connections, so both entries probe dead.
		const victim = path.join(dir, "victim.txt");
		await Bun.write(victim, "keep");
		const ownSocket = path.join(registryDir, "dddddddddddddddd.sock");
		await Bun.write(ownSocket, "");
		await writeHostEntry(entry("cccccccccccccccc", `${registryDir}${path.sep}..${path.sep}victim.txt`), registryDir);
		await writeHostEntry(entry("dddddddddddddddd", ownSocket), registryDir);
		expect(await listSessionHosts(registryDir)).toEqual([]);
		expect(await fs.readdir(registryDir)).toEqual([]);
		expect(await Bun.file(victim).text()).toBe("keep");
	});

	it("hides another registry version's entry and prunes it only once its process is gone", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hosts-"));
		const exited = Bun.spawn([process.execPath, "-e", ""]);
		await exited.exited;
		// A newer schema need not carry this version's fields.
		const newer = (hostId: string, pid: number) => ({ version: SESSION_HOST_REGISTRY_VERSION + 1, hostId, pid });
		await Bun.write(path.join(dir, "eeeeeeeeeeeeeeee.json"), JSON.stringify(newer("eeeeeeeeeeeeeeee", process.pid)));
		await Bun.write(path.join(dir, "ffffffffffffffff.json"), JSON.stringify(newer("ffffffffffffffff", exited.pid)));
		expect(await listSessionHosts(dir)).toEqual([]);
		expect(await fs.readdir(dir)).toEqual(["eeeeeeeeeeeeeeee.json"]);
	});
});
