/**
 * The daemon `settings` module and the client link. The store contracts run
 * the module's unit in this process behind in-memory tunnels, one tunnel per
 * simulated process, speaking the module's own tunnel lines; the link cases go
 * through `settingsLink()`, which under `bun test` serves the store in-process.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type {
	GlobalDocState,
	ProjectDocState,
	SettingsDocKey,
	SettingsDocUpdate,
	SettingsDown,
	SettingsUp,
	SettingsWrite,
} from "../../src/config/settings-store";
import * as daemonClients from "../../src/daemon/client";
import {
	disposeSettingsLinkForTest,
	SETTINGS_KIND,
	SETTINGS_VERSION,
	settingsLink,
	settingsModule,
} from "../../src/daemon/modules/settings";
import { type DaemonTunnel, GLOBAL_SCOPE } from "../../src/daemon/protocol";
import { lineReader } from "../../src/irc/mesh-protocol";
import { waitFor } from "../fixtures/daemon-harness";
import { delivered, LocalModuleDaemon } from "../fixtures/local-module-daemon";

type Reply = Extract<SettingsDown, { t: "reply" }>;
type Request = Extract<SettingsUp, { id: string }>;
/** A request without the id the process assigns. */
type RequestBody =
	| { t: "open"; doc: SettingsDocKey; mode: "read" | "write"; watch?: boolean }
	| { t: "flush"; doc: SettingsDocKey }
	| { t: "reload"; doc: SettingsDocKey };

/** YAML no parser accepts as a settings document: its root is not a mapping. */
const MALFORMED = "- not\n- a mapping\n";
const WAIT_MS = 3_000;

/** One simulated omp process: a tunnel to the settings unit and one channel (one open document) on it. */
class StoreProcess {
	/** Every state the store sent this process, pushes and reply states alike, oldest first. */
	readonly states: SettingsDocUpdate[] = [];
	/** States that arrived as `doc` pushes only. */
	readonly pushes: SettingsDocUpdate[] = [];
	readonly #tunnel: DaemonTunnel;
	readonly #replies = new Map<string, (reply: Reply) => void>();
	#lastRequest = 0;
	#lastSeq = 0;

	static async attach(daemon: LocalModuleDaemon): Promise<StoreProcess> {
		await daemon.open({ kind: SETTINGS_KIND, scope: GLOBAL_SCOPE, key: "store" });
		return new StoreProcess(await daemon.attach());
	}

	private constructor(tunnel: DaemonTunnel) {
		this.#tunnel = tunnel;
		tunnel.start(
			lineReader(line => {
				const { c, m } = line as { c: number; m: SettingsDown };
				if (c !== 1) return;
				if (m.t === "doc") {
					this.pushes.push(m.doc);
					this.states.push(m.doc);
					return;
				}
				if (m.doc) this.states.push(m.doc);
				this.#replies.get(m.id)?.(m);
				this.#replies.delete(m.id);
			}),
			() => {},
		);
	}

	#send(message: SettingsUp): void {
		this.#tunnel.send(`${JSON.stringify({ c: 1, m: message })}\n`);
	}

	/** Ask the store and resolve with its reply, error replies included. */
	request(body: RequestBody): Promise<Reply> {
		const id = String(++this.#lastRequest);
		const { promise, resolve } = Promise.withResolvers<Reply>();
		this.#replies.set(id, resolve);
		this.#send({ ...body, id } as Request);
		return promise;
	}

	/** Send one write; returns its seq. */
	write(doc: SettingsDocKey, writes: SettingsWrite[]): number {
		const seq = ++this.#lastSeq;
		this.#send({ t: "write", doc, seq, writes });
		return seq;
	}

	/** The first pushed state `matches` accepts. */
	pushed(matches: (update: SettingsDocUpdate) => boolean, what: string): Promise<SettingsDocUpdate> {
		return waitFor(() => this.pushes.find(matches), what, WAIT_MS);
	}
}

const daemons: LocalModuleDaemon[] = [];
const dirs: TempDir[] = [];

function localDaemon(): LocalModuleDaemon {
	const daemon = new LocalModuleDaemon(settingsModule);
	daemons.push(daemon);
	return daemon;
}

function tempDir(): string {
	const dir = TempDir.createSync("@omp-settings-module-");
	dirs.push(dir);
	return dir.path();
}

function globalState(update: SettingsDocUpdate | undefined): GlobalDocState {
	if (!update || update.doc.kind !== "global") throw new Error("expected a global document state");
	return update.state as GlobalDocState;
}

function projectState(update: SettingsDocUpdate | undefined): ProjectDocState {
	if (!update || update.doc.kind !== "project") throw new Error("expected a project document state");
	return update.state as ProjectDocState;
}

async function readYaml(filePath: string): Promise<unknown> {
	return YAML.parse(await fs.readFile(filePath, "utf8"));
}

afterEach(async () => {
	// Stopping the unit saves what the store still holds, so it goes before the directories.
	for (const daemon of daemons.splice(0)) await daemon.stop();
	disposeSettingsLinkForTest();
	for (const dir of dirs.splice(0)) await dir.remove();
});

describe("daemon settings store", () => {
	it("advertises the kind and version a client's link looks for", () => {
		const daemon = localDaemon();
		expect(daemon.welcome.caps[SETTINGS_KIND]).toBe(SETTINGS_VERSION);
	});

	it("shows one process's write to another that watches the document and saves it on flush", async () => {
		const agentDir = tempDir();
		const configPath = path.join(agentDir, "config.yml");
		const doc: SettingsDocKey = { kind: "global", agentDir };
		const daemon = localDaemon();
		const a = await StoreProcess.attach(daemon);
		const b = await StoreProcess.attach(daemon);

		const opened = await a.request({ t: "open", doc, mode: "write" });
		expect(opened.error).toBeUndefined();
		expect(opened.doc).toEqual({ doc, state: { configPath, settings: {} }, acked: 0 });
		// Only a watching subscriber is told what another process changed.
		expect((await b.request({ t: "open", doc, mode: "write", watch: true })).error).toBeUndefined();

		const seq = a.write(doc, [{ segments: ["probe", "value"], value: "on" }]);
		const seenByB = await b.pushed(
			update => globalState(update).settings.probe !== undefined,
			"the other process's push",
		);
		expect(globalState(seenByB).settings).toEqual({ probe: { value: "on" } });
		// `acked` counts the receiver's own writes: B made none, A's is in.
		expect(seenByB.acked).toBe(0);
		expect((await a.pushed(update => update.acked === seq, "the writer's ack")).state).toEqual(seenByB.state);

		const flushed = await a.request({ t: "flush", doc });
		expect(flushed.error).toBeUndefined();
		expect(globalState(flushed.doc).settings).toEqual({ probe: { value: "on" } });
		expect(await readYaml(configPath)).toEqual({ probe: { value: "on" } });
	});

	it("keeps another process's write from a subscriber that does not watch until it asks", async () => {
		const agentDir = tempDir();
		const doc: SettingsDocKey = { kind: "global", agentDir };
		const daemon = localDaemon();
		const a = await StoreProcess.attach(daemon);
		const b = await StoreProcess.attach(daemon);
		await a.request({ t: "open", doc, mode: "write" });
		expect((await b.request({ t: "open", doc, mode: "write" })).error).toBeUndefined();

		const seq = a.write(doc, [{ segments: ["probe", "value"], value: "on" }]);
		// The writer is answered whoever watches: the push carries its ack.
		const acked = await a.pushed(update => update.acked === seq, "the writer's ack");
		expect(globalState(acked).settings).toEqual({ probe: { value: "on" } });

		// A tunnel delivers in order: a push the write had sent B is in before this reply, and one more
		// turn covers anything the save sent after it.
		const asked = await b.request({ t: "flush", doc });
		await delivered();
		expect(b.pushes).toEqual([]);
		// Not watching hides nothing from a process that asks.
		expect(asked.error).toBeUndefined();
		expect(globalState(asked.doc).settings).toEqual({ probe: { value: "on" } });
	});

	it("leaves the config file untouched when a write repeats the value it already holds", async () => {
		const agentDir = tempDir();
		const configPath = path.join(agentDir, "config.yml");
		const doc: SettingsDocKey = { kind: "global", agentDir };
		const a = await StoreProcess.attach(localDaemon());
		await a.request({ t: "open", doc, mode: "write" });
		a.write(doc, [{ segments: ["probe", "value"], value: "on" }]);
		expect((await a.request({ t: "flush", doc })).error).toBeUndefined();
		const before = { bytes: await fs.readFile(configPath, "utf8"), stat: await fs.stat(configPath) };

		const seq = a.write(doc, [{ segments: ["probe", "value"], value: "on" }]);
		// The repeat is still acknowledged, or the writer would replay it forever.
		await a.pushed(update => update.acked === seq, "the repeated write's ack");
		expect((await a.request({ t: "flush", doc })).error).toBeUndefined();

		const after = await fs.stat(configPath);
		expect(await fs.readFile(configPath, "utf8")).toBe(before.bytes);
		expect(after.mtimeMs).toBe(before.stat.mtimeMs);
		// An atomic rewrite of identical bytes would still replace the file.
		expect(after.ino).toBe(before.stat.ino);
	});

	it("refuses to open a malformed config for writing and moves it aside", async () => {
		const agentDir = tempDir();
		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(configPath, MALFORMED);
		const a = await StoreProcess.attach(localDaemon());

		const reply = await a.request({ t: "open", doc: { kind: "global", agentDir }, mode: "write" });

		expect(reply.error).toBeString();
		expect(reply.doc).toBeUndefined();
		const entries = await fs.readdir(agentDir);
		expect(entries).not.toContain("config.yml");
		const moved = entries.filter(entry => entry.startsWith("config.yml.broken-"));
		expect(moved).toHaveLength(1);
		// Moved, not rewritten: the user's bytes are what they repair.
		expect(await fs.readFile(path.join(agentDir, moved[0]), "utf8")).toBe(MALFORMED);
	});

	it("refuses to open a malformed config for reading and leaves it in place", async () => {
		const agentDir = tempDir();
		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(configPath, MALFORMED);
		const a = await StoreProcess.attach(localDaemon());

		const reply = await a.request({ t: "open", doc: { kind: "global", agentDir }, mode: "read" });

		expect(reply.error).toBeString();
		expect(reply.doc).toBeUndefined();
		expect(await fs.readdir(agentDir)).toEqual(["config.yml"]);
		expect(await fs.readFile(configPath, "utf8")).toBe(MALFORMED);
	});

	it("adopts an outside edit on reload, for the asker and every watching subscriber", async () => {
		const agentDir = tempDir();
		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(configPath, "probe:\n  value: before\n");
		const doc: SettingsDocKey = { kind: "global", agentDir };
		const daemon = localDaemon();
		const a = await StoreProcess.attach(daemon);
		const b = await StoreProcess.attach(daemon);
		expect(globalState((await a.request({ t: "open", doc, mode: "write" })).doc).settings).toEqual({
			probe: { value: "before" },
		});
		await b.request({ t: "open", doc, mode: "write", watch: true });

		await Bun.write(configPath, "probe:\n  value: after\n");
		const reloaded = await a.request({ t: "reload", doc });

		expect(reloaded.error).toBeUndefined();
		expect(globalState(reloaded.doc).settings).toEqual({ probe: { value: "after" } });
		const seenByB = await b.pushed(
			update => (globalState(update).settings.probe as { value?: string } | undefined)?.value === "after",
			"the reload's push to the other process",
		);
		expect(globalState(seenByB).settings).toEqual({ probe: { value: "after" } });
	});

	it("rejects a reload of a config that became malformed and keeps the state it had", async () => {
		const agentDir = tempDir();
		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(configPath, "probe:\n  value: good\n");
		const doc: SettingsDocKey = { kind: "global", agentDir };
		const daemon = localDaemon();
		const a = await StoreProcess.attach(daemon);
		const b = await StoreProcess.attach(daemon);
		await a.request({ t: "open", doc, mode: "write" });
		await b.request({ t: "open", doc, mode: "write" });

		await Bun.write(configPath, MALFORMED);
		const reloaded = await a.request({ t: "reload", doc });

		expect(reloaded.error).toBeString();
		expect(reloaded.doc).toBeUndefined();
		// Nothing pending, so this flush only reports the state the store still serves.
		const current = await a.request({ t: "flush", doc });
		expect(current.error).toBeUndefined();
		expect(globalState(current.doc).settings).toEqual({ probe: { value: "good" } });
		expect(globalState(b.states.at(-1)).settings).toEqual({ probe: { value: "good" } });
	});

	it("reports a project's settings files in merge order and writes model roles to its config.yml", async () => {
		const cwd = tempDir();
		const projectDir = getProjectAgentDir(cwd);
		const settingsPath = path.join(projectDir, "settings.json");
		const configPath = path.join(projectDir, "config.yml");
		await Bun.write(settingsPath, JSON.stringify({ probe: { fromJson: true } }));
		await Bun.write(configPath, "probe:\n  fromYaml: true\n");
		const doc: SettingsDocKey = { kind: "project", cwd };
		const a = await StoreProcess.attach(localDaemon());

		const opened = await a.request({ t: "open", doc, mode: "write" });

		expect(opened.error).toBeUndefined();
		const initial = projectState(opened.doc);
		expect(initial.items.map(item => ({ path: item.path, data: item.data }))).toEqual([
			{ path: settingsPath, data: { probe: { fromJson: true } } },
			{ path: configPath, data: { probe: { fromYaml: true } } },
		]);
		expect(initial.warnings).toEqual([]);
		expect(initial.nativeModelRoles).toBeUndefined();

		const seq = a.write(doc, [{ segments: ["modelRoles", "smol"], value: "probe-provider/probe-model" }]);
		const acked = await a.pushed(update => update.acked === seq, "the role write's ack");
		expect(projectState(acked).nativeModelRoles).toEqual({ smol: "probe-provider/probe-model" });
		const flushed = await a.request({ t: "flush", doc });

		expect(flushed.error).toBeUndefined();
		expect(projectState(flushed.doc).nativeModelRoles).toEqual({ smol: "probe-provider/probe-model" });
		expect(await readYaml(configPath)).toEqual({
			probe: { fromYaml: true },
			modelRoles: { smol: "probe-provider/probe-model" },
		});
		// The project's other file is read-only to the store.
		expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual({ probe: { fromJson: true } });
	});

	it("saves what a process wrote when the daemon stops the unit", async () => {
		const agentDir = tempDir();
		const doc: SettingsDocKey = { kind: "global", agentDir };
		const daemon = localDaemon();
		const a = await StoreProcess.attach(daemon);
		await a.request({ t: "open", doc, mode: "write" });
		const seq = a.write(doc, [{ segments: ["probe", "value"], value: "kept" }]);
		await a.pushed(update => update.acked === seq, "the write's ack");

		// No flush asked: an acknowledged write must survive a daemon shutdown or upgrade.
		await daemon.stop();

		expect(await readYaml(path.join(agentDir, "config.yml"))).toEqual({ probe: { value: "kept" } });
	});
});

describe("settings link", () => {
	it("serves a test run from an in-process store without dialing the daemon", async () => {
		const agentDir = tempDir();
		const configPath = path.join(agentDir, "config.yml");
		const dial = spyOn(daemonClients, "daemonClient");
		try {
			const link = await settingsLink();
			const writer = await link.open({ kind: "global", agentDir }, { mode: "write" });
			// Each subscription is a store peer of its own: the second sees the first's write because it watches.
			const reader = await link.open({ kind: "global", agentDir }, { mode: "write", watch: true });
			expect(writer.update.state).toEqual({ configPath, settings: {} });
			const notified: SettingsDocUpdate[] = [];
			writer.onUpdate(update => notified.push(update));

			writer.write([{ segments: ["probe", "value"], value: "on" }]);
			// The writer reads its own write back at once, before the store has answered.
			expect(globalState(writer.update).settings).toEqual({ probe: { value: "on" } });
			expect(notified.map(update => globalState(update).settings)).toEqual([{ probe: { value: "on" } }]);

			await writer.flush();
			expect(await readYaml(configPath)).toEqual({ probe: { value: "on" } });
			await waitFor(
				() => globalState(reader.update).settings.probe !== undefined,
				"the second subscription's update",
				WAIT_MS,
			);
			expect(globalState(reader.update).settings).toEqual({ probe: { value: "on" } });
			expect(dial).not.toHaveBeenCalled();
		} finally {
			dial.mockRestore();
		}
	});

	it("rejects a reload the store answered with an error, and an open of a malformed config", async () => {
		const agentDir = tempDir();
		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(configPath, "probe:\n  value: good\n");
		const link = await settingsLink();
		const subscription = await link.open({ kind: "global", agentDir }, { mode: "write" });

		await Bun.write(configPath, MALFORMED);
		await expect(subscription.reload()).rejects.toThrow();
		expect(globalState(subscription.update).settings).toEqual({ probe: { value: "good" } });

		const brokenDir = tempDir();
		await Bun.write(path.join(brokenDir, "config.yml"), MALFORMED);
		await expect(link.open({ kind: "global", agentDir: brokenDir }, { mode: "read" })).rejects.toThrow();
		expect(await fs.readdir(brokenDir)).toEqual(["config.yml"]);
	});

	it("closes the shared link's subscriptions on dispose and hands out a working link afterwards", async () => {
		const agentDir = tempDir();
		const configPath = path.join(agentDir, "config.yml");
		const first = await settingsLink();
		const stale = await first.open({ kind: "global", agentDir }, { mode: "write" });
		stale.write([{ segments: ["probe", "value"], value: "first" }]);
		await stale.flush();

		disposeSettingsLinkForTest();

		expect(() => stale.write([{ segments: ["probe", "value"], value: "lost" }])).toThrow();
		await Bun.write(configPath, "probe:\n  value: edited\n");
		const second = await settingsLink();
		// The new link reads the file as it is now, not what the disposed one last held.
		const reopened = await second.open({ kind: "global", agentDir }, { mode: "read" });
		expect(globalState(reopened.update).settings).toEqual({ probe: { value: "edited" } });
	});
});
