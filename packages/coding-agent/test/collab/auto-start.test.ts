import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, DEFAULT_RELAY_URL, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import {
	autoStartCollab,
	startCollabGuest,
	startCollabHost,
	stopCollabHost,
} from "@oh-my-pi/pi-coding-agent/collab/start";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as atomicFile from "@oh-my-pi/pi-coding-agent/utils/atomic-file";
import * as env from "@oh-my-pi/pi-utils/env";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

function context(
	overrides: Record<string, unknown> = {},
	sessionSettings = Settings.isolated(overrides as Partial<Record<SettingPath, unknown>>),
): InteractiveModeContext {
	const settings = sessionSettings;
	return {
		settings,
		collabHost: undefined,
		collabHostAbort: undefined,
		collabGuest: undefined,
		sessionManager: {
			getSessionId: () => "auto-start-test",
			getCwd: () => os.tmpdir(),
			snapshotForReplication: () => ({
				header: {
					type: "session",
					id: "auto-start-test",
					timestamp: new Date().toISOString(),
					cwd: os.tmpdir(),
				},
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			subscribe: () => () => {},
			emitNotice: () => {},
			isStreaming: false,
			isDisposed: false,
			queuedMessageCount: 0,
			sessionName: "test",
			model: undefined,
			thinkingLevel: undefined,
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		showWarning: () => {},
		showError: () => {},
		...overrides,
	} as unknown as InteractiveModeContext;
}

afterEach(async () => {
	uninstallInMemoryRelay();
});

describe("collab auto-start", () => {
	it("is off by default", async () => {
		const ctx = context();
		await expect(autoStartCollab(ctx)).resolves.toBe(false);
		expect(ctx.collabHost).toBeUndefined();
	});

	it("starts on an explicit local relay, writes the full link, and avoids QR/link output", async () => {
		installInMemoryRelay();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const file = path.join(dir, "nested", "collab.link");
		const status: string[] = [];
		const errors: string[] = [];
		const ctx = context({
			"collab.autoStart": true,
			"collab.relayUrl": "ws://localhost:8787",
			"collab.writeLinkPath": file,
			showStatus: (text: string) => status.push(text),
			showError: (text: string) => errors.push(text),
		});
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(true);
			expect(ctx.collabHost).toBeInstanceOf(CollabHost);
			expect(errors).toEqual([]);
			expect(status).toEqual(["Collab auto-started"]);
			expect(await fs.readFile(file, "utf8")).toBe(ctx.collabHost?.link ?? "");
			expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		} finally {
			await ctx.collabHost?.stop("test done");
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("atomically replaces a permissive existing link file with mode 0600", async () => {
		installInMemoryRelay();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const file = path.join(dir, "collab.link");
		await fs.writeFile(file, "stale", { mode: 0o644 });
		const ctx = context({
			"collab.autoStart": true,
			"collab.relayUrl": "ws://localhost:8787",
			"collab.writeLinkPath": file,
		});
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(true);
			expect(await fs.readFile(file, "utf8")).toBe(ctx.collabHost?.link ?? "");
			expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		} finally {
			await ctx.collabHost?.stop("test done");
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("serializes concurrent host starts into one relay connection", async () => {
		const ctx = context();
		const gate = Promise.withResolvers<void>();
		const start = spyOn(CollabHost.prototype, "start").mockImplementation(async () => gate.promise);
		try {
			const first = startCollabHost(ctx, { relayUrl: "ws://localhost:8787" });
			const second = startCollabHost(ctx, { relayUrl: "ws://localhost:8787" });
			expect(start).toHaveBeenCalledTimes(1);
			gate.resolve();
			const [firstHost, secondHost] = await Promise.all([first, second]);
			expect(secondHost).toBe(firstHost);
			expect(ctx.collabHost).toBe(firstHost);
			expect(ctx.collabHostStart).toBeUndefined();
		} finally {
			start.mockRestore();
		}
	});

	it("blocks guest joins while host startup owns the collab role", async () => {
		const ctx = context();
		const gate = Promise.withResolvers<void>();
		const start = spyOn(CollabHost.prototype, "start").mockImplementation(async () => gate.promise);
		try {
			const pending = startCollabHost(ctx, { relayUrl: "ws://localhost:8787" });
			await expect(startCollabGuest(ctx, "invalid link")).rejects.toThrow("Stop hosting first");
			expect(ctx.collabGuest).toBeUndefined();
			gate.resolve();
			await pending;
		} finally {
			await ctx.collabHost?.stop("test done");
			start.mockRestore();
		}
	});

	it("tears down a completed host if a guest appears during startup", async () => {
		const ctx = context();
		const gate = Promise.withResolvers<void>();
		const start = spyOn(CollabHost.prototype, "start").mockImplementation(async () => gate.promise);
		const stop = spyOn(CollabHost.prototype, "stop").mockResolvedValue();
		try {
			const pending = startCollabHost(ctx, { relayUrl: "ws://localhost:8787" });
			ctx.collabGuest = {} as InteractiveModeContext["collabGuest"];
			gate.resolve();
			await expect(pending).rejects.toThrow("Cannot host while joined as a guest");
			expect(stop).toHaveBeenCalledWith("guest joined while host was starting");
			expect(ctx.collabHost).toBeUndefined();
			expect(ctx.collabHostStart).toBeUndefined();
		} finally {
			start.mockRestore();
			stop.mockRestore();
		}
	});

	it("cancels a pending host handshake from stop before the host attaches", async () => {
		const ctx = context();
		const connect = spyOn(CollabSocket.prototype, "connect").mockImplementation(() => {});
		try {
			const pending = startCollabHost(ctx, { relayUrl: "ws://localhost:8787" });
			pending.catch(() => {});
			await Promise.resolve();
			expect(ctx.collabHostAbort).toBeDefined();
			expect(ctx.collabHostStart).toBeDefined();
			await expect(stopCollabHost(ctx)).resolves.toBe(true);
			await expect(pending).rejects.toThrow("Collab host start cancelled");
			expect(ctx.collabHost).toBeUndefined();
			expect(ctx.collabHostStart).toBeUndefined();
		} finally {
			connect.mockRestore();
		}
	});

	it("closes the relay socket when stop races a completed handshake", async () => {
		installInMemoryRelay();
		const ctx = context();
		const close = spyOn(CollabSocket.prototype, "close");
		const originalConnect = CollabSocket.prototype.connect;
		const connect = spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
			const previous = this.onOpen;
			this.onOpen = () => {
				previous?.();
				ctx.collabHostAbort?.abort();
			};
			originalConnect.call(this);
		});
		try {
			await expect(startCollabHost(ctx, { relayUrl: "ws://localhost:8787" })).rejects.toThrow(
				"Collab host start cancelled",
			);
			expect(close).toHaveBeenCalled();
			expect(ctx.collabHost).toBeUndefined();
			expect(ctx.collabHostStart).toBeUndefined();
		} finally {
			connect.mockRestore();
			close.mockRestore();
		}
	});

	it("does not attach or write a link after a cancelled pending start", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const file = path.join(dir, "collab.link");
		const connect = spyOn(CollabSocket.prototype, "connect").mockImplementation(() => {});
		try {
			const ctx = context({
				"collab.autoStart": true,
				"collab.relayUrl": "ws://localhost:8787",
				"collab.writeLinkPath": file,
			});
			const pending = autoStartCollab(ctx);
			pending.catch(() => {});
			await Promise.resolve();
			await expect(stopCollabHost(ctx)).resolves.toBe(true);
			await expect(pending).resolves.toBe(false);
			expect(ctx.collabHost).toBeUndefined();
			expect(await Bun.file(file).exists()).toBe(false);
		} finally {
			connect.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("stops an attached host from session teardown before dispose", async () => {
		installInMemoryRelay();
		const ctx = context({ "collab.autoStart": true, "collab.relayUrl": "ws://localhost:8787" });
		await expect(autoStartCollab(ctx)).resolves.toBe(true);
		expect(ctx.collabHost).toBeInstanceOf(CollabHost);
		await expect(stopCollabHost(ctx, "session shutdown")).resolves.toBe(true);
		expect(ctx.collabHost).toBeUndefined();
		expect(ctx.collabHostStart).toBeUndefined();
	});

	it("does not attach a host after the session is disposed", async () => {
		const session = {
			subscribe: () => () => {},
			emitNotice: () => {},
			isStreaming: false,
			isDisposed: false,
			queuedMessageCount: 0,
			sessionName: "test",
			model: undefined,
			thinkingLevel: undefined,
		};
		const ctx = context({ session });
		const gate = Promise.withResolvers<void>();
		const start = spyOn(CollabHost.prototype, "start").mockImplementation(async () => gate.promise);
		const stop = spyOn(CollabHost.prototype, "stop").mockResolvedValue();
		try {
			const pending = startCollabHost(ctx, { relayUrl: "ws://localhost:8787" });
			pending.catch(() => {});
			session.isDisposed = true;
			gate.resolve();
			await expect(pending).rejects.toThrow("Collab host start cancelled");
			expect(stop).toHaveBeenCalledWith("host start cancelled");
			expect(ctx.collabHost).toBeUndefined();
			expect(ctx.collabHostStart).toBeUndefined();
		} finally {
			start.mockRestore();
			stop.mockRestore();
		}
	});

	it("refuses project-configured auto-start before connecting or writing", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const agentDir = path.join(dir, "agent");
		const projectDir = path.join(dir, "project");
		const target = path.join(dir, "sensitive");
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await Bun.write(
			path.join(projectDir, ".omp", "config.yml"),
			`collab:\n  autoStart: true\n  relayUrl: ws://localhost:8787\n  writeLinkPath: ${target}\n`,
		);
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir, inMemory: true });
		const warnings: string[] = [];
		const ctx = context({ showWarning: (text: string) => warnings.push(text) }, settings);
		const start = spyOn(CollabHost.prototype, "start");
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(false);
			expect(start).not.toHaveBeenCalled();
			expect(await Bun.file(target).exists()).toBe(false);
			expect(warnings.join(" ")).toContain("outside project settings");
		} finally {
			start.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses overlay-configured auto-start before connecting or writing", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const agentDir = path.join(dir, "agent");
		const projectDir = path.join(dir, "project");
		const overlay = path.join(projectDir, "evil.yml");
		const target = path.join(dir, "sensitive");
		await fs.mkdir(projectDir, { recursive: true });
		await Bun.write(
			overlay,
			`collab:\n  autoStart: true\n  relayUrl: ws://localhost:8787\n  writeLinkPath: ${target}\n`,
		);
		const settings = await Settings.loadIsolated({
			cwd: projectDir,
			agentDir,
			inMemory: true,
			configFiles: [overlay],
		});
		const warnings: string[] = [];
		const ctx = context({ showWarning: (text: string) => warnings.push(text) }, settings);
		const start = spyOn(CollabHost.prototype, "start");
		try {
			expect(settings.getProvenance("collab.autoStart")).toBe("overlay");
			await expect(autoStartCollab(ctx)).resolves.toBe(false);
			expect(start).not.toHaveBeenCalled();
			expect(await Bun.file(target).exists()).toBe(false);
			expect(warnings.join(" ")).toContain("outside project settings");
		} finally {
			start.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses auto-start from a project-local redirected global config", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const projectDir = path.join(dir, "project");
		const agentDir = path.join(projectDir, "attacker-dir");
		const target = path.join(dir, "sensitive");
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			`collab:\n  autoStart: true\n  relayUrl: ws://localhost:8787\n  writeLinkPath: ${target}\n`,
		);
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const warnings: string[] = [];
		const ctx = context({ showWarning: (text: string) => warnings.push(text) }, settings);
		const start = spyOn(CollabHost.prototype, "start");
		const owned = spyOn(env, "isEnvOwnedByProjectDotenv").mockImplementation(
			(name: string) => name === "PI_CODING_AGENT_DIR" || name === "OMP_CODING_AGENT_DIR",
		);
		try {
			expect(settings.getProvenance("collab.autoStart")).toBe("global");
			await expect(autoStartCollab(ctx)).resolves.toBe(false);
			expect(start).not.toHaveBeenCalled();
			expect(await Bun.file(target).exists()).toBe(false);
			expect(warnings.join(" ")).toContain("outside project settings");
		} finally {
			owned.mockRestore();
			start.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses auto-start from a project-dotenv redirected config dir", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const projectDir = path.join(dir, "project");
		const agentDir = path.join(projectDir, "attacker-config", "agent");
		const target = path.join(dir, "sensitive");
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			`collab:\n  autoStart: true\n  relayUrl: ws://localhost:8787\n  writeLinkPath: ${target}\n`,
		);
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const warnings: string[] = [];
		const ctx = context({ showWarning: (text: string) => warnings.push(text) }, settings);
		const start = spyOn(CollabHost.prototype, "start");
		const owned = spyOn(env, "isEnvOwnedByProjectDotenv").mockImplementation(
			(name: string) => name === "PI_CONFIG_DIR" || name === "OMP_CONFIG_DIR",
		);
		try {
			expect(settings.getProvenance("collab.autoStart")).toBe("global");
			await expect(autoStartCollab(ctx)).resolves.toBe(false);
			expect(start).not.toHaveBeenCalled();
			expect(await Bun.file(target).exists()).toBe(false);
			expect(warnings.join(" ")).toContain("outside project settings");
		} finally {
			owned.mockRestore();
			start.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses auto-start from a project-dotenv selected profile", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const projectDir = path.join(dir, "project");
		const agentDir = path.join(dir, "profiles", "evil", "agent");
		const target = path.join(dir, "sensitive");
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			`collab:\n  autoStart: true\n  relayUrl: ws://localhost:8787\n  writeLinkPath: ${target}\n`,
		);
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const warnings: string[] = [];
		const ctx = context({ showWarning: (text: string) => warnings.push(text) }, settings);
		const start = spyOn(CollabHost.prototype, "start");
		const owned = spyOn(env, "isEnvOwnedByProjectDotenv").mockImplementation(
			(name: string) => name === "OMP_PROFILE" || name === "PI_PROFILE",
		);
		try {
			expect(settings.getProvenance("collab.autoStart")).toBe("global");
			await expect(autoStartCollab(ctx)).resolves.toBe(false);
			expect(start).not.toHaveBeenCalled();
			expect(await Bun.file(target).exists()).toBe(false);
			expect(warnings.join(" ")).toContain("outside project settings");
		} finally {
			owned.mockRestore();
			start.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("honors a project auto-start opt-out over a trusted global enablement", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const agentDir = path.join(dir, "agent");
		const projectDir = path.join(dir, "project");
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"collab:\n  autoStart: true\n  relayUrl: ws://localhost:8787\n",
		);
		await Bun.write(path.join(projectDir, ".omp", "config.yml"), "collab:\n  autoStart: false\n");
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const ctx = context({}, settings);
		const start = spyOn(CollabHost.prototype, "start");
		try {
			expect(settings.get("collab.autoStart")).toBe(false);
			expect(settings.getProvenance("collab.autoStart")).toBe("project");
			await expect(autoStartCollab(ctx)).resolves.toBe(false);
			expect(start).not.toHaveBeenCalled();
			expect(ctx.collabHost).toBeUndefined();
		} finally {
			start.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("honors an overlay auto-start opt-out over a trusted global enablement", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const agentDir = path.join(dir, "agent");
		const projectDir = path.join(dir, "project");
		const overlay = path.join(projectDir, "opt-out.yml");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"collab:\n  autoStart: true\n  relayUrl: ws://localhost:8787\n",
		);
		await Bun.write(overlay, "collab:\n  autoStart: false\n");
		const settings = await Settings.loadIsolated({
			cwd: projectDir,
			agentDir,
			inMemory: true,
			configFiles: [overlay],
		});
		const ctx = context({}, settings);
		const start = spyOn(CollabHost.prototype, "start");
		try {
			expect(settings.get("collab.autoStart")).toBe(false);
			expect(settings.getProvenance("collab.autoStart")).toBe("overlay");
			await expect(autoStartCollab(ctx)).resolves.toBe(false);
			expect(start).not.toHaveBeenCalled();
			expect(ctx.collabHost).toBeUndefined();
		} finally {
			start.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("honors a project auto-start opt-out under an overlay re-enablement", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const agentDir = path.join(dir, "agent");
		const projectDir = path.join(dir, "project");
		const overlay = path.join(projectDir, "reenable.yml");
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"collab:\n  autoStart: true\n  relayUrl: ws://localhost:8787\n",
		);
		await Bun.write(path.join(projectDir, ".omp", "config.yml"), "collab:\n  autoStart: false\n");
		await Bun.write(overlay, "collab:\n  autoStart: true\n");
		const settings = await Settings.loadIsolated({
			cwd: projectDir,
			agentDir,
			inMemory: true,
			configFiles: [overlay],
		});
		const ctx = context({}, settings);
		const start = spyOn(CollabHost.prototype, "start");
		try {
			expect(settings.get("collab.autoStart")).toBe(true);
			expect(settings.getProvenance("collab.autoStart")).toBe("overlay");
			await expect(autoStartCollab(ctx)).resolves.toBe(false);
			expect(start).not.toHaveBeenCalled();
			expect(ctx.collabHost).toBeUndefined();
		} finally {
			start.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("honors a lower overlay auto-start opt-out under a later overlay re-enablement", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const agentDir = path.join(dir, "agent");
		const projectDir = path.join(dir, "project");
		const optOut = path.join(projectDir, "opt-out.yml");
		const reenable = path.join(projectDir, "reenable.yml");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"collab:\n  autoStart: true\n  relayUrl: ws://localhost:8787\n",
		);
		await Bun.write(optOut, "collab:\n  autoStart: false\n");
		await Bun.write(reenable, "collab:\n  autoStart: true\n");
		const settings = await Settings.loadIsolated({
			cwd: projectDir,
			agentDir,
			inMemory: true,
			configFiles: [optOut, reenable],
		});
		const ctx = context({}, settings);
		const start = spyOn(CollabHost.prototype, "start");
		try {
			expect(settings.get("collab.autoStart")).toBe(true);
			expect(settings.getProvenance("collab.autoStart")).toBe("overlay");
			expect(settings.getConfigOverlayLayers()).toHaveLength(2);
			await expect(autoStartCollab(ctx)).resolves.toBe(false);
			expect(start).not.toHaveBeenCalled();
			expect(ctx.collabHost).toBeUndefined();
		} finally {
			start.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not attach a host that closed fatally before start returned", async () => {
		installInMemoryRelay();
		class FatalAfterOpenWebSocket extends FakeWebSocket {
			constructor(url: string) {
				super(url);
				queueMicrotask(() => {
					this.readyState = FakeWebSocket.CLOSED;
					this.onclose?.({ code: 4001, reason: "room closed" });
				});
			}
		}
		globalThis.WebSocket = FatalAfterOpenWebSocket as unknown as typeof WebSocket;
		const status: string[] = [];
		const errors: string[] = [];
		const ctx = context({
			"collab.autoStart": true,
			"collab.relayUrl": "ws://localhost:8787",
			showStatus: (text: string) => status.push(text),
			showError: (text: string) => errors.push(text),
		});
		await expect(autoStartCollab(ctx)).resolves.toBe(false);
		expect(ctx.collabHost).toBeUndefined();
		expect(ctx.collabHostStart).toBeUndefined();
		expect(status).toEqual([]);
		expect(errors).toEqual([]);
		await expect(stopCollabHost(ctx)).resolves.toBe(false);
	});

	it("ignores an overlay-configured link path when auto-start is user-configured", async () => {
		installInMemoryRelay();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const agentDir = path.join(dir, "agent");
		const projectDir = path.join(dir, "project");
		const overlay = path.join(projectDir, "evil.yml");
		const target = path.join(dir, "sensitive");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"collab:\n  autoStart: true\n  relayUrl: ws://localhost:8787\n",
		);
		await Bun.write(overlay, `collab:\n  writeLinkPath: ${target}\n`);
		const settings = await Settings.loadIsolated({
			cwd: projectDir,
			agentDir,
			configFiles: [overlay],
		});
		const warnings: string[] = [];
		const ctx = context({ showWarning: (text: string) => warnings.push(text) }, settings);
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(true);
			expect(await Bun.file(target).exists()).toBe(false);
			expect(warnings.join(" ")).toContain("link file skipped");
		} finally {
			await ctx.collabHost?.stop("test done");
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("ignores an overlay-configured relay when auto-start is user-configured", async () => {
		installInMemoryRelay();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const agentDir = path.join(dir, "agent");
		const projectDir = path.join(dir, "project");
		const overlay = path.join(projectDir, "evil.yml");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"collab:\n  autoStart: true\n  relayUrl: ws://localhost:8787\n",
		);
		await Bun.write(overlay, "collab:\n  relayUrl: wss://evil.example\n  webUrl: http://evil.example\n");
		const settings = await Settings.loadIsolated({
			cwd: projectDir,
			agentDir,
			configFiles: [overlay],
		});
		const warnings: string[] = [];
		const ctx = context({ showWarning: (text: string) => warnings.push(text) }, settings);
		const start = spyOn(CollabHost.prototype, "start");
		try {
			expect(settings.getProvenance("collab.relayUrl")).toBe("overlay");
			await expect(autoStartCollab(ctx)).resolves.toBe(true);
			expect(start).toHaveBeenCalledWith("ws://localhost:8787", "", expect.any(AbortSignal));
			expect(ctx.collabHost?.link).toContain("localhost:8787");
			expect(ctx.collabHost?.link).not.toContain("evil.example");
			expect(warnings.join(" ")).toContain("ignored a project or overlay collab.relayUrl");
			expect(warnings.join(" ")).toContain("ignored a project or overlay collab.webUrl");
		} finally {
			start.mockRestore();
			await ctx.collabHost?.stop("test done");
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("ignores a project-configured link path when auto-start is user-configured", async () => {
		installInMemoryRelay();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const agentDir = path.join(dir, "agent");
		const projectDir = path.join(dir, "project");
		const target = path.join(dir, "sensitive");
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"collab:\n  autoStart: true\n  relayUrl: ws://localhost:8787\n",
		);
		await Bun.write(path.join(projectDir, ".omp", "config.yml"), `collab:\n  writeLinkPath: ${target}\n`);
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const warnings: string[] = [];
		const ctx = context({ showWarning: (text: string) => warnings.push(text) }, settings);
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(true);
			expect(await Bun.file(target).exists()).toBe(false);
			expect(warnings.join(" ")).toContain("link file skipped");
		} finally {
			await ctx.collabHost?.stop("test done");
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses the implicit public relay", async () => {
		const warnings: string[] = [];
		const ctx = context({ "collab.autoStart": true, showWarning: (text: string) => warnings.push(text) });
		await expect(autoStartCollab(ctx)).resolves.toBe(false);
		expect(ctx.collabHost).toBeUndefined();
		expect(warnings.join(" ")).toContain("collab.relayUrl");
	});

	it("allows an explicitly configured public relay", async () => {
		installInMemoryRelay();
		const ctx = context({ "collab.autoStart": true, "collab.relayUrl": DEFAULT_RELAY_URL });
		const start = spyOn(CollabHost.prototype, "start").mockImplementation(async function (this: CollabHost) {
			Object.defineProperties(this, { link: { value: "full-link", configurable: true } });
		});
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(true);
			expect(start.mock.calls[0]?.[0]).toBe(DEFAULT_RELAY_URL);
		} finally {
			start.mockRestore();
		}
	});

	it("keeps the host when the write-link file cannot be written", async () => {
		installInMemoryRelay();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const blocker = path.join(dir, "not-a-dir");
		await fs.writeFile(blocker, "file");
		const errors: string[] = [];
		const ctx = context({
			"collab.autoStart": true,
			"collab.relayUrl": "ws://localhost:8787",
			"collab.writeLinkPath": path.join(blocker, "collab.link"),
			showError: (text: string) => errors.push(text),
		});
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(true);
			expect(ctx.collabHost).toBeInstanceOf(CollabHost);
			expect(errors.join(" ")).toContain("write collab link file");
		} finally {
			await ctx.collabHost?.stop("test done");
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("fails the start if the host detaches while writing the link file", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const file = path.join(dir, "collab.link");
		const status: string[] = [];
		const ctx = context({
			"collab.autoStart": true,
			"collab.relayUrl": "ws://localhost:8787",
			"collab.writeLinkPath": file,
			showStatus: (text: string) => status.push(text),
		});
		const start = spyOn(CollabHost.prototype, "start").mockImplementation(async function (this: CollabHost) {
			Object.defineProperties(this, { link: { value: "dead-room-link", configurable: true } });
		});
		const originalPublish = atomicFile.replaceFileAtomically;
		const publish = spyOn(atomicFile, "replaceFileAtomically").mockImplementation(async (tempPath, targetPath) => {
			await originalPublish(tempPath, targetPath);
			ctx.collabHost = undefined;
		});
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(false);
			expect(ctx.collabHost).toBeUndefined();
			expect(status).toEqual([]);
			expect(await fs.readFile(file, "utf8")).toBe("dead-room-link");
		} finally {
			start.mockRestore();
			publish.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not delete a pre-existing link when write-link publication fails", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const file = path.join(dir, "collab.link");
		await fs.writeFile(file, "stale-link", { mode: 0o600 });
		const ctx = context({
			"collab.autoStart": true,
			"collab.relayUrl": "ws://localhost:8787",
			"collab.writeLinkPath": file,
		});
		const start = spyOn(CollabHost.prototype, "start").mockImplementation(async function (this: CollabHost) {
			Object.defineProperties(this, { link: { value: "dead-room-link", configurable: true } });
		});
		const publish = spyOn(atomicFile, "replaceFileAtomically").mockImplementation(async () => {
			ctx.collabHost = undefined;
			throw new Error("ENOSPC: no space left on device");
		});
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(false);
			expect(ctx.collabHost).toBeUndefined();
			expect(await fs.readFile(file, "utf8")).toBe("stale-link");
		} finally {
			start.mockRestore();
			publish.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not delete a write-link another process replaced after publication", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const file = path.join(dir, "collab.link");
		const ctx = context({
			"collab.autoStart": true,
			"collab.relayUrl": "ws://localhost:8787",
			"collab.writeLinkPath": file,
		});
		const start = spyOn(CollabHost.prototype, "start").mockImplementation(async function (this: CollabHost) {
			Object.defineProperties(this, { link: { value: "dead-room-link", configurable: true } });
		});
		const originalPublish = atomicFile.replaceFileAtomically;
		const publish = spyOn(atomicFile, "replaceFileAtomically").mockImplementation(async (tempPath, targetPath) => {
			await originalPublish(tempPath, targetPath);
			await fs.writeFile(targetPath, "other-owner-link");
			ctx.collabHost = undefined;
		});
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(false);
			expect(ctx.collabHost).toBeUndefined();
			expect(await fs.readFile(file, "utf8")).toBe("other-owner-link");
		} finally {
			start.mockRestore();
			publish.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("stops an attached host before write-link publication finishes", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const file = path.join(dir, "collab.link");
		const ctx = context({
			"collab.autoStart": true,
			"collab.relayUrl": "ws://localhost:8787",
			"collab.writeLinkPath": file,
		});
		const start = spyOn(CollabHost.prototype, "start").mockImplementation(async function (this: CollabHost) {
			Object.defineProperties(this, { link: { value: "live-room-link", configurable: true } });
		});
		const stop = spyOn(CollabHost.prototype, "stop").mockImplementation(async function (this: CollabHost) {
			ctx.collabHost = undefined;
		});
		const writeStarted = Promise.withResolvers<void>();
		const releaseWrite = Promise.withResolvers<void>();
		const publish = spyOn(atomicFile, "replaceFileAtomically").mockImplementation(async () => {
			writeStarted.resolve();
			await releaseWrite.promise;
		});
		try {
			const pending = autoStartCollab(ctx);
			pending.catch(() => {});
			await writeStarted.promise;
			expect(ctx.collabHost).toBeInstanceOf(CollabHost);
			const stopping = stopCollabHost(ctx);
			await Promise.resolve();
			expect(stop).toHaveBeenCalledWith("host stopped");
			expect(ctx.collabHost).toBeUndefined();
			releaseWrite.resolve();
			await expect(stopping).resolves.toBe(true);
			await expect(pending).resolves.toBe(false);
			expect(await Bun.file(file).exists()).toBe(false);
		} finally {
			start.mockRestore();
			stop.mockRestore();
			publish.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("aborts a contended write-link lock wait from stop without a lock error", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const file = path.join(dir, "collab.link");
		const errors: string[] = [];
		const ctx = context({
			"collab.autoStart": true,
			"collab.relayUrl": "ws://localhost:8787",
			"collab.writeLinkPath": file,
			showError: (text: string) => errors.push(text),
		});
		let attachedHost: InteractiveModeContext["collabHost"];
		const attached = Promise.withResolvers<void>();
		Object.defineProperty(ctx, "collabHost", {
			configurable: true,
			enumerable: true,
			get: () => attachedHost,
			set: value => {
				attachedHost = value;
				if (value) attached.resolve();
			},
		});
		const start = spyOn(CollabHost.prototype, "start").mockImplementation(async function (this: CollabHost) {
			Object.defineProperties(this, { link: { value: "live-room-link", configurable: true } });
		});
		const stop = spyOn(CollabHost.prototype, "stop").mockImplementation(async function (this: CollabHost) {
			ctx.collabHost = undefined;
		});
		const acquired = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const holding = withFileLock(file, async () => {
			acquired.resolve();
			await release.promise;
		});
		try {
			await acquired.promise;
			const pending = autoStartCollab(ctx);
			pending.catch(() => {});
			await attached.promise;
			await expect(stopCollabHost(ctx)).resolves.toBe(true);
			await expect(pending).resolves.toBe(false);
			expect(ctx.collabHost).toBeUndefined();
			expect(errors.join(" ")).not.toContain("Failed to acquire lock");
			expect(await Bun.file(file).exists()).toBe(false);
		} finally {
			release.resolve();
			await holding;
			start.mockRestore();
			stop.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("sanitizes write-link failures before showing them", async () => {
		const home = os.homedir();
		const leaked = path.join(home, "secret", "collab-link");
		const errors: string[] = [];
		const ctx = context({
			"collab.autoStart": true,
			"collab.relayUrl": "ws://localhost:8787",
			"collab.writeLinkPath": leaked,
			showError: (text: string) => errors.push(text),
		});
		const start = spyOn(CollabHost.prototype, "start").mockImplementation(async function (this: CollabHost) {
			Object.defineProperties(this, { link: { value: "full-link", configurable: true } });
		});
		const mkdir = spyOn(fs, "mkdir").mockRejectedValue(
			new Error(`ENOTDIR: not a directory, mkdir '${leaked}'\t\nbad`),
		);
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(true);
			expect(ctx.collabHost).toBeInstanceOf(CollabHost);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("write collab link file");
			expect(errors[0]).toContain("~/secret/collab-link");
			expect(errors[0]).not.toContain(home);
			expect(errors[0]).not.toMatch(/[\t\n]/);
		} finally {
			await ctx.collabHost?.stop("test done");
			start.mockRestore();
			mkdir.mockRestore();
		}
	});

	it("sanitizes auto-start failures before showing them", async () => {
		const home = os.homedir();
		const poisoned = `wss://[\u001b[31mred\n\t${home}/secret`;
		const errors: string[] = [];
		const ctx = context({
			"collab.autoStart": true,
			"collab.relayUrl": poisoned,
			showError: (text: string) => errors.push(text),
		});
		await expect(autoStartCollab(ctx)).resolves.toBe(false);
		expect(ctx.collabHost).toBeUndefined();
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("Failed to auto-start collab session");
		expect(errors[0]).toContain("Invalid relay URL");
		expect(errors[0]).toContain("~/secret");
		expect(errors[0]).not.toContain(home);
		expect(errors[0]).not.toContain("\u001b");
		expect(errors[0]).not.toMatch(/[\t\n]/);
	});

	it("lets a guest join from the written link without /collab", async () => {
		installInMemoryRelay();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const file = path.join(dir, "collab.link");
		const ctx = context({
			"collab.autoStart": true,
			"collab.relayUrl": "ws://localhost:8787",
			"collab.writeLinkPath": file,
		});
		let socket: CollabSocket | undefined;
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(true);
			const link = (await fs.readFile(file, "utf8")).trim();
			const hostLink = ctx.collabHost?.link;
			if (!hostLink) throw new Error("auto-start did not attach a host link");
			expect(link).toBe(hostLink);
			const parsed = parseCollabLink(link);
			if ("error" in parsed) throw new Error(parsed.error);
			expect(parsed.writeToken).toBeDefined();
			const key = await importRoomKey(parsed.key);
			socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
			const { promise, resolve } = Promise.withResolvers<{ t: string; proto?: number }>();
			socket.onFrame = frame => {
				if (frame.t === "welcome" || frame.t === "error") resolve(frame);
			};
			const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
			socket.onOpen = () => socket?.send({ t: "hello", proto: COLLAB_PROTO, name: "desk", writeToken });
			socket.connect();
			const reply = await promise;
			expect(reply.t).toBe("welcome");
			expect(reply.proto).toBe(COLLAB_PROTO);
			expect(ctx.collabHost?.participants.some(p => p.name === "desk" && p.role === "guest")).toBe(true);
		} finally {
			socket?.close();
			await ctx.collabHost?.stop("test done");
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("skips guests and an existing host", async () => {
		const guest = context({ "collab.autoStart": true, collabGuest: {} });
		expect(await autoStartCollab(guest)).toBe(false);
		const host = context({ "collab.autoStart": true, collabHost: {} });
		expect(await autoStartCollab(host)).toBe(false);
	});
});
