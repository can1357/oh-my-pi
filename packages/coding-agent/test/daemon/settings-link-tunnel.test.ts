/**
 * The settings link on its production transport: a `SettingsStoreLink` whose
 * `connect` reaches the `settings` unit over a daemon tunnel, here the
 * in-memory one of `LocalModuleDaemon`. Replies arrive asynchronously, as
 * from a socket, so the journal, the reply bookkeeping and the re-dial after
 * a lost tunnel all run as they do against a real daemon.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { GlobalDocState, SettingsDocUpdate } from "../../src/config/settings-store";
import { type SettingsDaemon, SettingsStoreLink, settingsModule } from "../../src/daemon/modules/settings";
import { waitFor } from "../fixtures/daemon-harness";
import { delivered, LocalModuleDaemon } from "../fixtures/local-module-daemon";

/** YAML no parser accepts as a settings document: its root is not a mapping. */
const MALFORMED = "- not\n- a mapping\n";
const WAIT_MS = 3_000;

/** One simulated daemon connection, as the link's `connect` hands it out. */
interface Connection {
	readonly daemon: LocalModuleDaemon;
	/** What `connect` resolves with; the same object on every dial, like the process-wide client. */
	readonly client: SettingsDaemon;
	/** Unit leases the link gave back, oldest first. */
	readonly released: string[];
	/** The connection dropped and came back: every lease taken before is gone. */
	reconnect(): void;
}

const links: SettingsStoreLink[] = [];
const daemons: LocalModuleDaemon[] = [];
const dirs: TempDir[] = [];

function connection(caps?: Record<string, number>): Connection {
	const daemon = new LocalModuleDaemon(settingsModule);
	daemons.push(daemon);
	const released: string[] = [];
	const listeners = new Set<Parameters<SettingsDaemon["onReconnect"]>[0]>();
	const client: SettingsDaemon = {
		welcome: caps ? { ...daemon.welcome, caps } : daemon.welcome,
		open: request => daemon.open(request),
		release: async lease => {
			released.push(lease);
		},
		attach: () => daemon.attach(),
		onReconnect: listener => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	return {
		daemon,
		client,
		released,
		reconnect: () => {
			for (const listener of [...listeners]) listener();
		},
	};
}

/** A started link that reaches its store through `connect`. */
async function startLink(connect: () => Promise<SettingsDaemon>): Promise<SettingsStoreLink> {
	const link = new SettingsStoreLink(connect);
	links.push(link);
	await link.start();
	return link;
}

function tempDir(): string {
	const dir = TempDir.createSync("@omp-settings-link-tunnel-");
	dirs.push(dir);
	return dir.path();
}

function settingsOf(update: SettingsDocUpdate): GlobalDocState["settings"] {
	if (update.doc.kind !== "global") throw new Error("expected a global document state");
	return (update.state as GlobalDocState).settings;
}

async function readYaml(filePath: string): Promise<unknown> {
	return YAML.parse(await fs.readFile(filePath, "utf8"));
}

afterEach(async () => {
	for (const link of links.splice(0)) link.close();
	// Stopping the unit saves what the store still holds, so it goes before the directories.
	for (const daemon of daemons.splice(0)) await daemon.stop();
	for (const dir of dirs.splice(0)) await dir.remove();
});

describe("settings link over a daemon tunnel", () => {
	it("opens a document on the daemon's store and returns the file's state under its resolved key", async () => {
		const agentDir = tempDir();
		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(configPath, "probe:\n  value: initial\n");
		const { daemon, client } = connection();
		const link = await startLink(async () => client);

		// A relative directory: the daemon may run with another cwd, so the key it is sent must be absolute.
		const subscription = await link.open(
			{ kind: "global", agentDir: path.relative(process.cwd(), agentDir) },
			{ mode: "write" },
		);

		expect(daemon.tunnels).toHaveLength(1);
		expect(subscription.key).toEqual({ kind: "global", agentDir });
		expect(subscription.update).toEqual({
			doc: { kind: "global", agentDir },
			state: { configPath, settings: { probe: { value: "initial" } } },
			acked: 0,
		});
	});

	it("saves a write on flush and shows it to a second subscription only once that one watches", async () => {
		const agentDir = tempDir();
		const configPath = path.join(agentDir, "config.yml");
		const { daemon, client } = connection();
		const link = await startLink(async () => client);
		const writer = await link.open({ kind: "global", agentDir }, { mode: "write" });
		const reader = await link.open({ kind: "global", agentDir }, { mode: "write" });
		// Both subscriptions are channels of the process's one tunnel.
		expect(daemon.tunnels).toHaveLength(1);
		const notified: SettingsDocUpdate[] = [];
		writer.onUpdate(update => notified.push(update));

		writer.write([{ segments: ["probe", "first"], value: "on" }]);
		// The writer reads its own write back before the store, a tunnel away, has answered.
		expect(settingsOf(writer.update)).toEqual({ probe: { first: "on" } });
		expect(writer.update.acked).toBe(0);
		expect(notified.map(settingsOf)).toEqual([{ probe: { first: "on" } }]);

		await writer.flush();
		expect(await readYaml(configPath)).toEqual({ probe: { first: "on" } });
		// The flush's answer carries the ack: the state is the store's now, not a local guess.
		expect(writer.update.acked).toBe(1);
		expect(settingsOf(writer.update)).toEqual({ probe: { first: "on" } });
		// One tunnel delivers in order, so a push to the reader would be in by now.
		await delivered();
		expect(settingsOf(reader.update)).toEqual({});

		reader.watch(true);
		writer.write([{ segments: ["probe", "second"], value: "on" }]);
		await waitFor(
			() => (settingsOf(reader.update).probe as { second?: string } | undefined)?.second === "on",
			"the watching subscription's update",
			WAIT_MS,
		);
		// A push is the whole state, so the write it missed comes with it.
		expect(settingsOf(reader.update)).toEqual({ probe: { first: "on", second: "on" } });
		// `acked` counts a subscription's own writes: the reader made none.
		expect(reader.update.acked).toBe(0);
	});

	it("leaves the config file untouched when a write repeats the value it already holds", async () => {
		const agentDir = tempDir();
		const configPath = path.join(agentDir, "config.yml");
		const { client } = connection();
		const link = await startLink(async () => client);
		const subscription = await link.open({ kind: "global", agentDir }, { mode: "write" });
		subscription.write([{ segments: ["probe", "value"], value: "on" }]);
		await subscription.flush();
		const before = { bytes: await fs.readFile(configPath, "utf8"), stat: await fs.stat(configPath) };

		subscription.write([{ segments: ["probe", "value"], value: "on" }]);
		await subscription.flush();

		// The repeat is still acknowledged, or the link would replay it on every new tunnel.
		expect(subscription.update.acked).toBe(2);
		const after = await fs.stat(configPath);
		expect(await fs.readFile(configPath, "utf8")).toBe(before.bytes);
		expect(after.mtimeMs).toBe(before.stat.mtimeMs);
	});

	it("adopts an outside edit on reload, and rejects a reload of a malformed file keeping its state", async () => {
		const agentDir = tempDir();
		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(configPath, "probe:\n  value: before\n");
		const { client } = connection();
		const link = await startLink(async () => client);
		const subscription = await link.open({ kind: "global", agentDir }, { mode: "write" });
		expect(settingsOf(subscription.update)).toEqual({ probe: { value: "before" } });

		await Bun.write(configPath, "probe:\n  value: after\n");
		await subscription.reload();
		expect(settingsOf(subscription.update)).toEqual({ probe: { value: "after" } });

		await Bun.write(configPath, MALFORMED);
		// The store's error reply crosses the tunnel as a rejection, not as a silent success.
		await expect(subscription.reload()).rejects.toThrow();
		expect(settingsOf(subscription.update)).toEqual({ probe: { value: "after" } });
	});

	it("rejects an open the daemon's store refused and leaves the link usable", async () => {
		const brokenDir = tempDir();
		await Bun.write(path.join(brokenDir, "config.yml"), MALFORMED);
		const agentDir = tempDir();
		const { client } = connection();
		const link = await startLink(async () => client);

		await expect(link.open({ kind: "global", agentDir: brokenDir }, { mode: "read" })).rejects.toThrow();

		// The refused channel is gone; the tunnel it was on still carries others.
		const subscription = await link.open({ kind: "global", agentDir }, { mode: "write" });
		subscription.write([{ segments: ["probe", "value"], value: "on" }]);
		await subscription.flush();
		expect(await readYaml(path.join(agentDir, "config.yml"))).toEqual({ probe: { value: "on" } });
	});

	it("resolves a flush and a reload pending at close, and refuses writes afterwards", async () => {
		const agentDir = tempDir();
		const { client } = connection();
		const link = await startLink(async () => client);
		const subscription = await link.open({ kind: "global", agentDir }, { mode: "write" });
		const notified: SettingsDocUpdate[] = [];
		subscription.onUpdate(update => notified.push(update));

		const flushing = subscription.flush();
		const reloading = subscription.reload();
		subscription.close();

		// Whoever awaited them sees the close as "nothing left to do", not as a failure to report.
		await expect(flushing).resolves.toBeUndefined();
		await expect(reloading).resolves.toBeUndefined();
		expect(() => subscription.write([{ segments: ["probe", "value"], value: "late" }])).toThrow(
			"Settings subscription is closed",
		);
		// Asked of a closed subscription they resolve at once too.
		await expect(subscription.flush()).resolves.toBeUndefined();
		await expect(subscription.reload()).resolves.toBeUndefined();
		// Nothing the store still sends reaches a closed subscription's sinks.
		await delivered();
		expect(notified).toEqual([]);
	});

	it("closes its subscriptions and gives the unit lease back when the link closes", async () => {
		const agentDir = tempDir();
		const { client, released } = connection();
		const link = await startLink(async () => client);
		const subscription = await link.open({ kind: "global", agentDir }, { mode: "write" });
		expect(released).toEqual([]);

		link.close();

		// A lease never given back would keep the daemon's unit from idling out.
		expect(released).toEqual(["lease-0"]);
		expect(() => subscription.write([{ segments: ["probe", "value"], value: "late" }])).toThrow();
		await expect(link.open({ kind: "global", agentDir }, { mode: "read" })).rejects.toThrow(
			"Settings link is closed",
		);
	});

	it("dials again after a lost tunnel, re-opens the document and replays the write the store never took", async () => {
		const agentDir = tempDir();
		const configPath = path.join(agentDir, "config.yml");
		const { daemon, client, released } = connection();
		const link = await startLink(async () => client);
		const subscription = await link.open({ kind: "global", agentDir }, { mode: "write" });
		subscription.write([{ segments: ["probe", "kept"], value: "on" }]);
		await subscription.flush();

		// The tunnel dies in the turn of the write, before it delivers: the store never sees this one.
		subscription.write([{ segments: ["probe", "replayed"], value: "on" }]);
		daemon.tunnels[0].close();

		// Without a store the subscription serves its last state, unacked write included, and still takes writes.
		expect(settingsOf(subscription.update)).toEqual({ probe: { kept: "on", replayed: "on" } });
		subscription.write([{ segments: ["probe", "offline"], value: "on" }]);
		// Asked with no tunnel up: it waits for the next one instead of failing or resolving unsaved.
		await subscription.flush();

		expect(daemon.tunnels).toHaveLength(2);
		// The lost tunnel's lease went back; the new one is held.
		expect(released).toEqual(["lease-0"]);
		expect(await readYaml(configPath)).toEqual({ probe: { kept: "on", replayed: "on", offline: "on" } });
		expect(settingsOf(subscription.update)).toEqual({ probe: { kept: "on", replayed: "on", offline: "on" } });
		// A new peer counts acks from zero, but the journal's seqs carry over: all three are acknowledged.
		expect(subscription.update.acked).toBe(3);
	});

	it("moves to a new tunnel when the daemon connection reconnects, keeping writes made across the move", async () => {
		const agentDir = tempDir();
		const configPath = path.join(agentDir, "config.yml");
		const { daemon, client, released, reconnect } = connection();
		const link = await startLink(async () => client);
		const subscription = await link.open({ kind: "global", agentDir }, { mode: "write" });

		// The old tunnel still looks open, but its lease died with the connection.
		subscription.write([{ segments: ["probe", "before"], value: "on" }]);
		reconnect();
		await waitFor(() => daemon.tunnels.length === 2, "the dial after the reconnect", WAIT_MS);
		subscription.write([{ segments: ["probe", "after"], value: "on" }]);
		await subscription.flush();

		expect(released).toEqual(["lease-0"]);
		expect(await readYaml(configPath)).toEqual({ probe: { before: "on", after: "on" } });
		expect(settingsOf(subscription.update)).toEqual({ probe: { before: "on", after: "on" } });
	});

	it("runs the store in-process while the daemon is unreachable and moves onto it once a dial lands", async () => {
		const agentDir = tempDir();
		const configPath = path.join(agentDir, "config.yml");
		const { daemon, client } = connection();
		let dials = 0;
		const link = await startLink(async () => {
			if (++dials === 1) throw new Error("daemon unreachable");
			return client;
		});

		// The failed dial costs the caller nothing: the document opens on this process's own store.
		const subscription = await link.open({ kind: "global", agentDir }, { mode: "write" });
		expect(daemon.tunnels).toHaveLength(0);
		subscription.write([{ segments: ["probe", "local"], value: "on" }]);

		// A failed dial is never the last one: the retry lands and the subscription moves to the daemon.
		await waitFor(() => daemon.tunnels.length === 1, "the retried dial", WAIT_MS);
		subscription.write([{ segments: ["probe", "daemon"], value: "on" }]);
		await subscription.flush();

		expect(dials).toBe(2);
		expect(await readYaml(configPath)).toEqual({ probe: { local: "on", daemon: "on" } });
		expect(settingsOf(subscription.update)).toEqual({ probe: { local: "on", daemon: "on" } });
	});

	it("keeps the store in-process when the daemon serves another version of the settings protocol", async () => {
		const agentDir = tempDir();
		const configPath = path.join(agentDir, "config.yml");
		const { daemon, client } = connection({});
		const link = await startLink(async () => client);

		const subscription = await link.open({ kind: "global", agentDir }, { mode: "write" });
		subscription.write([{ segments: ["probe", "value"], value: "on" }]);
		await subscription.flush();

		// No unit opened, no tunnel attached: a daemon of another build is never spoken to in this protocol.
		expect(daemon.tunnels).toHaveLength(0);
		expect(await readYaml(configPath)).toEqual({ probe: { value: "on" } });
	});
});
