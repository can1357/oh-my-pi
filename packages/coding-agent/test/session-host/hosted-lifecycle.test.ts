/**
 * How a hosted terminal comes and goes: moving to another host with `/attach`, ending with `/exit` or `/detach`, and
 * what it leaves on disk. Real session hosts over real sockets. The terminal is a recording `InteractiveModeContext`
 * where a test only needs the calls the link and the commands make on it, and a real `InteractiveMode` (its own
 * shutdown and teardown) where the question is what is left on disk.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ensurePrivateDir, privateEndpoint } from "@oh-my-pi/pi-coding-agent/ipc/private-endpoint";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { InteractiveModeContext, ShutdownOptions } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as prediction from "@oh-my-pi/pi-coding-agent/predict/client";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { HostedClientLink } from "@oh-my-pi/pi-coding-agent/session-host/hosted-client";
import { attachHostedUi, hostedReplicaDir } from "@oh-my-pi/pi-coding-agent/session-host/hosted-startup";
import {
	newHostId,
	SESSION_HOST_REGISTRY_VERSION,
	type SessionHostEntry,
	writeHostEntry,
} from "@oh-my-pi/pi-coding-agent/session-host/registry";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { attachCommand, resumeCommand } from "@oh-my-pi/pi-coding-agent/utils/resume-command";
import { postmortem } from "@oh-my-pi/pi-utils";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { setWordPredictionHost } from "@oh-my-pi/pi-tui/prompt/word-completion";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import { createTestSession } from "../helpers/rpc-server-harness";
import {
	type HostProxy,
	type IsolatedConfigRoot,
	isolateConfigRoot,
	listTree,
	SessionHostFixture,
	startProxy,
	type TestSessionHost,
	waitFor,
} from "../helpers/session-host-harness";

// The proxy is a unix socket in front of the host's endpoint; Windows hosts listen on named pipes.
const itPosix = it.skipIf(process.platform === "win32");

let fixture: SessionHostFixture;
let config: IsolatedConfigRoot;
const terminals: Terminal[] = [];
const hostedModes: HostedMode[] = [];
const proxies: HostProxy[] = [];
const servers: net.Server[] = [];

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	fixture = await SessionHostFixture.create();
	// The terminal's replica directory lives under the base config root.
	config = isolateConfigRoot();
});

afterEach(async () => {
	for (const terminal of terminals.splice(0)) await terminal.close();
	for (const hosted of hostedModes.splice(0)) await hosted.close();
	for (const proxy of proxies.splice(0)) proxy.close();
	for (const server of servers.splice(0)) server.close();
	setWordPredictionHost(undefined);
	vi.restoreAllMocks();
	await config.restore();
	await fixture.dispose();
	resetSettingsForTest();
});

/** The text of every user message a session holds, oldest first. */
function userTexts(session: AgentSession): string[] {
	return session.messages.flatMap(message => {
		if (message.role !== "user") return [];
		const { content } = message;
		if (typeof content === "string") return [content];
		return [content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("")];
	});
}

/** One finished turn on the host from a throwaway client. */
async function seedTurn(host: TestSessionHost, text: string): Promise<void> {
	const client = await fixture.client(host);
	await client.start();
	await client.promptAndWait(text);
	await client.detach();
}

/** A hosted terminal's context: a passive replica, and a record of what the link and the commands asked of it. */
class Terminal {
	readonly statuses: string[] = [];
	readonly errors: string[] = [];
	readonly shutdowns: (ShutdownOptions | undefined)[] = [];
	/** What the host selector offered each time it opened. */
	readonly offered: string[][] = [];
	/** The user's answer to the host selector. */
	readonly choice = Promise.withResolvers<string | undefined>();
	readonly ctx: InteractiveModeContext;

	private constructor(readonly local: AgentSession) {
		this.ctx = createInteractiveModeContext({
			session: local,
			sessionManager: local.sessionManager,
			hostedClientMode: true,
			eventController: {
				handleEvent: async () => {},
				resetTranscriptAnchors: () => {},
				takeDisplaceableComponents: () => [],
				restorePendingToolResults: () => {},
			},
			statusLine: { setCollabStatus: () => {} },
			editor: { setText: () => {} },
			showStatus: message => void this.statuses.push(message),
			showError: message => void this.errors.push(message),
			showHookSelector: async (_title, options) => {
				this.offered.push(options.map(option => (typeof option === "string" ? option : option.label)));
				return this.choice.promise;
			},
			shutdown: async options => void this.shutdowns.push(options),
		});
	}

	static async open(): Promise<Terminal> {
		const dir = await fs.mkdtemp(path.join(fixture.dir, "terminal-"));
		const mock = { handler: { content: ["never asked"] } };
		const local = await createTestSession(dir, mock, undefined, { passiveReplica: true });
		const terminal = new Terminal(local);
		terminals.push(terminal);
		return terminal;
	}

	/** The connection this terminal is on now. */
	get link(): HostedClientLink {
		const { hostedClient } = this.ctx;
		if (!hostedClient) throw new Error("the terminal is not attached");
		return hostedClient;
	}

	/** The user messages the terminal shows. */
	get transcript(): string[] {
		return userTexts(this.local);
	}

	/** The `/attach` slash command as the editor submits it: with `target`, or without one to pick from a selector. */
	async slashAttach(target?: string): Promise<void> {
		await executeBuiltinSlashCommand(target === undefined ? "/attach" : `/attach ${target}`, { ctx: this.ctx });
	}

	async close(): Promise<void> {
		await this.ctx.hostedClient?.detach();
		await this.local.dispose();
	}
}

/** A terminal attached to `host` as `omp attach` attaches it; `via`: another entry for the same host, such as a proxy's. */
async function attached(host: TestSessionHost, via?: SessionHostEntry): Promise<Terminal> {
	const terminal = await Terminal.open();
	const entry = via ?? (await fixture.entry(host));
	await attachHostedUi(terminal.ctx, {
		entry,
		launch: { cwd: fixture.dir, args: [], registryDir: fixture.registryDir },
	});
	return terminal;
}

interface StandIn {
	entry: SessionHostEntry;
	/** How many clients have said hello. */
	hellos(): number;
	/** End the connection of every client that is being held. */
	dropClients(): void;
}

/**
 * A registered endpoint that looks live to the registry but is not a session host. A client that says hello is
 * dropped at once or, with `hold`, left waiting until `dropClients`: a connect still in flight.
 */
async function standInHost(hold: boolean): Promise<StandIn> {
	await ensurePrivateDir(fixture.registryDir, "test");
	const hostId = newHostId();
	const endpoint = await privateEndpoint(fixture.registryDir, hostId, { prefix: "host", label: "test" });
	const held: net.Socket[] = [];
	let hellos = 0;
	const server = net.createServer(socket => {
		socket.on("error", () => {});
		// The registry's liveness probe connects and stays silent; a client speaks first.
		socket.once("data", () => {
			hellos++;
			if (hold) held.push(socket);
			else socket.destroy();
		});
	});
	servers.push(server);
	const listening = Promise.withResolvers<void>();
	server.listen(endpoint, () => listening.resolve());
	await listening.promise;
	const entry: SessionHostEntry = {
		version: SESSION_HOST_REGISTRY_VERSION,
		hostId,
		pid: process.pid,
		endpoint,
		token: "t".repeat(64),
		cwd: fixture.dir,
		sessionFile: undefined,
		title: undefined,
		clients: 0,
		busy: false,
		startedAt: Date.now(),
	};
	await writeHostEntry(entry, fixture.registryDir);
	return {
		entry,
		hellos: () => hellos,
		dropClients: () => {
			for (const socket of held.splice(0)) socket.destroy();
		},
	};
}

describe("/attach in a hosted terminal", () => {
	it("leaves the previous host running and takes over the view of the chosen one", async () => {
		const first = await fixture.startHost();
		const second = await fixture.startHost();
		await seedTurn(first, "on the first host");
		await seedTurn(second, "on the second host");
		const terminal = await attached(first);
		expect(terminal.transcript).toEqual(["on the first host"]);

		await terminal.slashAttach(second.hostId);

		expect(terminal.link.hostId).toBe(second.hostId);
		expect(terminal.transcript).toEqual(["on the second host"]);
		await fixture.waitForClients(first, 0);
		await fixture.waitForClients(second, 1);
		expect(first.exited).toBe(false);
		expect(terminal.errors).toEqual([]);
		// One local copy, of the host on screen.
		expect((await listTree(hostedReplicaDir())).map(name => name.slice(0, 16))).toEqual([second.hostId]);
	}, 20_000);

	it("returns to the previous host with a fresh snapshot when the target cannot be reached", async () => {
		const host = await fixture.startHost();
		await seedTurn(host, "already here");
		const target = await standInHost(false);
		const terminal = await attached(host);
		const copyBefore = await listTree(hostedReplicaDir());

		await terminal.slashAttach(target.entry.hostId);

		expect(terminal.errors).toEqual([expect.stringContaining(`Could not attach to host ${target.entry.hostId}`)]);
		expect(terminal.statuses).toContain(`Back on session host ${host.hostId}`);
		expect(terminal.shutdowns).toEqual([]);
		expect(terminal.link.hostId).toBe(host.hostId);
		expect(terminal.transcript).toEqual(["already here"]);
		// The view was rebuilt from a new snapshot: a copy of its own, not the one the first connection left.
		const copyAfter = await listTree(hostedReplicaDir());
		expect(copyAfter).toHaveLength(1);
		expect(copyAfter).not.toEqual(copyBefore);
		// And it is a live connection: a prompt through it runs a turn on the host.
		await terminal.link.prompt("still connected");
		await waitFor(() => host.session.messages.filter(message => message.role === "assistant").length === 2);
		expect(userTexts(host.session)).toEqual(["already here", "still connected"]);
		expect(target.hellos()).toBe(1);
	}, 20_000);

	it("ends the process with status 1 when the target cannot be reached and the previous host is gone", async () => {
		const host = await fixture.startHost();
		const target = await standInHost(true);
		const terminal = await attached(host);

		const switching = terminal.slashAttach(target.entry.hostId);
		// The terminal has left the previous host and waits on the target.
		await waitFor(() => target.hellos() === 1);
		await host.stop();
		target.dropClients();
		await switching;

		const attempt = `Could not attach to host ${target.entry.hostId}, and could not return to host ${host.hostId}`;
		expect(terminal.shutdowns).toEqual([{ exitCode: 1, farewell: expect.stringContaining(attempt) }]);
		expect(terminal.ctx.hostedClient).toBeUndefined();
		expect(await listTree(hostedReplicaDir())).toEqual([]);
	}, 20_000);

	it("refuses a second /attach while a connection is in flight, and accepts one again afterwards", async () => {
		const first = await fixture.startHost();
		const second = await fixture.startHost();
		const target = await standInHost(true);
		const terminal = await attached(first);

		const switching = terminal.slashAttach(target.entry.hostId);
		await waitFor(() => target.hellos() === 1);
		await terminal.slashAttach(second.hostId);

		expect(terminal.statuses).toEqual(["Already switching session hosts"]);
		expect((await fixture.entry(second)).clients).toBe(0);

		target.dropClients();
		await switching;
		expect(terminal.link.hostId).toBe(first.hostId);

		await terminal.slashAttach(second.hostId);
		expect(terminal.link.hostId).toBe(second.hostId);
	}, 20_000);

	it("refuses a second /attach while the host selector is open, and follows the choice made in it", async () => {
		const first = await fixture.startHost();
		const second = await fixture.startHost();
		const terminal = await attached(first);

		const choosing = terminal.slashAttach();
		await waitFor(() => terminal.offered.length === 1);
		// The selector lists the other hosts only.
		expect(terminal.offered[0]).toHaveLength(1);
		expect(terminal.offered[0][0]).toContain(second.hostId);

		await terminal.slashAttach(second.hostId);
		expect(terminal.statuses).toEqual(["Already switching session hosts"]);
		expect(terminal.link.hostId).toBe(first.hostId);
		expect((await fixture.entry(second)).clients).toBe(0);

		terminal.choice.resolve(terminal.offered[0][0]);
		await choosing;
		expect(terminal.link.hostId).toBe(second.hostId);
	}, 20_000);
});

describe("/exit in a hosted terminal", () => {
	it("stops the host that has no other client, and exits normally", async () => {
		const host = await fixture.startHost();
		const terminal = await attached(host);

		await executeBuiltinSlashCommand("/exit", { ctx: terminal.ctx });

		await waitFor(() => host.exited);
		expect(terminal.shutdowns).toEqual([undefined]);
		expect(terminal.ctx.hostedClient).toBeUndefined();
	}, 20_000);

	itPosix(
		"exits with status 1 and names the host when the host refuses, leaving that host running",
		async () => {
			const host = await fixture.startHost();
			const proxy = await startProxy(await fixture.entry(host), fixture.dir, { refuseExit: "exit refused" });
			proxies.push(proxy);
			const terminal = await attached(host, proxy.entry);

			await executeBuiltinSlashCommand("/exit", { ctx: terminal.ctx });

			const farewell = `Could not stop session host ${host.hostId}: exit refused`;
			expect(terminal.shutdowns).toEqual([{ exitCode: 1, farewell }]);
			expect(terminal.ctx.hostedClient).toBeUndefined();
			await fixture.waitForClients(host, 0);
			expect(host.exited).toBe(false);
			expect(await listTree(hostedReplicaDir())).toEqual([]);
		},
		20_000,
	);
});

/**
 * A real `InteractiveMode` as a hosted terminal: its own shutdown and teardown run. `postmortem.quit` and stderr are
 * observed instead of taken, so a test sees the exit status and what the process told the user.
 */
class HostedMode {
	readonly #stderr: string[] = [];
	/** Settles with the exit status once `shutdown` ended the process. */
	readonly exited = Promise.withResolvers<number>();

	private constructor(
		readonly mode: InteractiveMode,
		readonly local: AgentSession,
	) {
		vi.spyOn(postmortem, "quit").mockImplementation(async code => {
			this.exited.resolve(code ?? 0);
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			this.#stderr.push(String(chunk));
			return true;
		});
	}

	/** A mode on a fresh passive replica, initialized as a hosted terminal's is; not attached to a host yet. */
	static async open(): Promise<HostedMode> {
		const dir = await fs.mkdtemp(path.join(fixture.dir, "mode-"));
		const mock = { handler: { content: ["never asked"] } };
		const local = await createTestSession(dir, mock, undefined, { passiveReplica: true });
		vi.spyOn(prediction, "textPredictionBackend").mockReturnValue({
			complete: async () => null,
			feedback: () => {},
		});
		vi.spyOn(prediction, "syncTextPrediction").mockImplementation(() => {});
		const mode = new InteractiveMode(local, "test");
		mode.hostedClientMode = true;
		mode.ui.requestRender = vi.fn();
		mode.ui.terminal.drainInput = async () => {};
		// Painting the transcript is not what these tests are about.
		vi.spyOn(mode, "renderInitialMessages").mockResolvedValue(undefined);
		await mode.init({ suppressWelcomeIntro: true });
		const hosted = new HostedMode(mode, local);
		hostedModes.push(hosted);
		return hosted;
	}

	/** The startup wiring of `omp attach`: the link is registered, and a lost connection ends the process. */
	async attach(entry: SessionHostEntry): Promise<void> {
		await attachHostedUi(this.mode, {
			entry,
			launch: { cwd: fixture.dir, args: [], registryDir: fixture.registryDir },
		});
	}

	/** What the process printed to stderr, without styling. */
	get printed(): string {
		return Bun.stripANSI(this.#stderr.join(""));
	}

	async close(): Promise<void> {
		await this.mode.hostedClient?.detach();
		if (!this.mode.isShuttingDown) this.mode.stop();
		await this.local.dispose();
	}
}

describe("a hosted terminal's shutdown", () => {
	it("/detach leaves the host running and its own copy of the transcript gone, without a resume hint", async () => {
		const host = await fixture.startHost();
		await seedTurn(host, "a finished turn");
		const hosted = await HostedMode.open();
		await hosted.attach(await fixture.entry(host));
		// The copy exists while attached.
		expect(await listTree(hostedReplicaDir())).toEqual([expect.stringMatching(/\.jsonl$/)]);

		await executeBuiltinSlashCommand("/detach", { ctx: hosted.mode });

		expect(await hosted.exited.promise).toBe(0);
		expect(hosted.printed).toContain(attachCommand(host.hostId));
		expect(hosted.printed).not.toContain("--resume");
		// Disposing the replica's session after the link left must not write the copy back (the exit record).
		expect(await listTree(hostedReplicaDir())).toEqual([]);
		await fixture.waitForClients(host, 0);
		expect(host.exited).toBe(false);
	}, 20_000);

	itPosix(
		"saves no draft beside a copy that a lost connection already deleted",
		async () => {
			const host = await fixture.startHost();
			const proxy = await startProxy(await fixture.entry(host), fixture.dir);
			proxies.push(proxy);
			const hosted = await HostedMode.open();
			await hosted.attach(proxy.entry);
			hosted.mode.editor.setText("unsent words");

			proxy.drop();

			expect(await hosted.exited.promise).toBe(1);
			expect(hosted.printed).toContain("connection lost");
			expect(await listTree(hostedReplicaDir())).toEqual([]);
			await fixture.waitForClients(host, 0);
			expect(host.exited).toBe(false);
		},
		20_000,
	);

	it("does not offer to resume the host's session when it quits before the link is registered", async () => {
		const host = await fixture.startHost();
		await seedTurn(host, "a finished turn");
		const hosted = await HostedMode.open();
		// The window between the first snapshot being on screen and `ctx.hostedClient` being set.
		const link = await HostedClientLink.connect({
			ctx: hosted.mode,
			entry: await fixture.entry(host),
			replicaDir: hostedReplicaDir(),
			onClosed: () => {},
		});
		try {
			const sessionId = hosted.mode.sessionManager.getSessionId();
			// The copy is on disk, which is what a resume hint for an ordinary session requires.
			expect(hosted.mode.sessionManager.isSessionOnDisk()).toBe(true);

			await hosted.mode.shutdown();

			expect(hosted.printed).not.toContain(resumeCommand(sessionId));
		} finally {
			await link.detach();
		}
	}, 20_000);
});
