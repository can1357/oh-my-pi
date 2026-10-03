import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as endpoints from "@oh-my-pi/pi-coding-agent/ipc/local-endpoint-registry";
import type {
	LocalEndpointMetadata,
	LocalEndpointRegistry,
} from "@oh-my-pi/pi-coding-agent/ipc/local-endpoint-registry";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { MAILBOX_MAX_BODY_BYTES, MAILBOX_REGISTRY } from "@oh-my-pi/pi-coding-agent/mailbox/protocol";
import { formatMailboxState, MailboxService, type MailboxTargetState } from "@oh-my-pi/pi-coding-agent/mailbox/service";
import { cfgIrcCrossProcess } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

const services: MailboxService[] = [];
const directories: string[] = [];

afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	vi.restoreAllMocks();
	for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function registryFixture(): Promise<LocalEndpointRegistry> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mailbox-"));
	directories.push(dir);
	return { ...MAILBOX_REGISTRY, dir };
}

function makeService(registry: LocalEndpointRegistry, cwd: string) {
	const agentRegistry = new AgentRegistry();
	const bus = new IrcBus(agentRegistry, new AgentLifecycleManager(agentRegistry));
	const service = new MailboxService({ registry, bus, agentRegistry });
	service.initialize(cwd);
	services.push(service);
	bus.setRemoteRouter(service);
	return { service, bus, agentRegistry };
}

function bind(
	host: { service: MailboxService; agentRegistry: AgentRegistry },
	options: {
		agentId?: string;
		conversation?: string | null;
		enabled?: boolean;
		receive?: boolean;
		notify?: (state: MailboxTargetState) => void;
	} = {},
) {
	const delivered: IrcMessage[] = [];
	let busy = false;
	let remoteWake = false;
	const session = {
		isRemoteWakeTurn: () => remoteWake,
		deliverIrcMessage: async (message: IrcMessage) => {
			delivered.push(message);
			return busy || message.noWake ? "injected" : "woken";
		},
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
	const agentId = options.agentId ?? "Main";
	host.agentRegistry.register({ id: agentId, displayName: "main", kind: "main", session });
	const settings = Settings.isolated({ "irc.crossProcess": options.enabled ?? true });
	const unbind = host.service.bindTarget({
		agentId,
		conversation: options.conversation ?? null,
		settings,
		receive: options.receive ?? true,
		describe: () => ({ title: "Test conversation", busy }),
		notify: options.notify,
	});
	return {
		settings,
		delivered,
		unbind,
		setBusy: (value: boolean) => {
			busy = value;
		},
		setRemoteWake: (value: boolean) => {
			remoteWake = value;
		},
	};
}

async function metadata(registry: LocalEndpointRegistry, service: MailboxService): Promise<LocalEndpointMetadata> {
	const entry = (await endpoints.readLocalEndpointEntries(registry)).find(
		item => item.meta.instanceId === service.address,
	);
	if (!entry) throw new Error("Missing mailbox publication");
	return entry.meta;
}

describe("MailboxService", () => {
	it("delivers idle and busy messages over the endpoint with the process address as sender", async () => {
		const registry = await registryFixture();
		const a = makeService(registry, "sender");
		const b = makeService(registry, "recipient");
		bind(a);
		const recipient = bind(b);
		await Promise.all([a.service.whenSettled(), b.service.whenSettled()]);

		expect(await a.bus.send({ from: "Main", to: b.service.address, body: "hello", replyTo: "thread" })).toEqual({
			to: "Main",
			outcome: "woken",
		});
		recipient.setBusy(true);
		expect((await a.bus.send({ from: "Main", to: b.service.address, body: "aside" })).outcome).toBe("injected");
		expect(
			await a.bus.send({ from: "Main", to: b.service.address, body: "x".repeat(MAILBOX_MAX_BODY_BYTES + 1) }),
		).toEqual({ to: b.service.address, outcome: "failed", error: "body_too_large" });
		expect(
			recipient.delivered.map(message => ({ from: message.from, body: message.body, remote: message.remote })),
		).toEqual([
			{ from: a.service.address, body: "hello", remote: true },
			{ from: a.service.address, body: "aside", remote: true },
		]);
		expect(recipient.delivered[0]?.replyTo).toBe("thread");
	});

	it("only reads metadata to resolve a send and guards a remote-woken reply against another wake", async () => {
		const registry = await registryFixture();
		const a = makeService(registry, "sender");
		const b = makeService(registry, "recipient");
		const sender = bind(a);
		const recipient = bind(b);
		await Promise.all([a.service.whenSettled(), b.service.whenSettled()]);
		sender.setRemoteWake(true);
		const query = endpoints.queryLocalEndpoint;
		vi.spyOn(endpoints, "queryLocalEndpoint").mockImplementation((reg, meta, request, timeout) => {
			if ("op" in request && request.op === "snapshot") throw new Error("Snapshot probing is unavailable");
			return query(reg, meta, request, timeout);
		});
		expect((await a.bus.send({ from: "Main", to: b.service.address, body: "reply" })).outcome).toBe("injected");
		expect(recipient.delivered[0]?.noWake).toBe(true);
	});

	it("reports unknown peers, disabled senders, and subagent sends without delivering", async () => {
		const registry = await registryFixture();
		const a = makeService(registry, "sender");
		const sender = bind(a);
		await a.service.whenSettled();
		const message: IrcMessage = { id: "test", ts: Date.now(), from: "Main", to: "missing-0123abcd", body: "hello" };
		expect((await a.service.send(message)).error).toBe(
			'No omp peer "missing-0123abcd" is running — read history:// to list peers.',
		);
		cfgIrcCrossProcess.override(sender.settings, false);
		await a.service.whenSettled();
		expect((await a.service.send(message)).error).toBe(
			"Cross-process peers are off for this session — run /peers on.",
		);
		expect((await a.service.send({ ...message, from: "0-Sub" })).error).toBe(
			"Only main agents can message other omp processes.",
		);
		expect(a.service.handles(message.to)).toBe(false);
	});

	it("checks forged senders, UTF-8 body size, target existence, and reception in that order", async () => {
		const registry = await registryFixture();
		const host = makeService(registry, "recipient");
		const root = bind(host);
		bind(host, { agentId: "acp:off", conversation: "0123abcd", enabled: false });
		await host.service.whenSettled();
		const meta = await metadata(registry, host.service);
		const query = (request: object) =>
			endpoints.queryLocalEndpoint(registry, meta, { op: "deliver", ...request }, 1500);
		const body = "é".repeat(MAILBOX_MAX_BODY_BYTES / 2 + 1);
		for (const from of ["Main", host.service.address, `${host.service.address}.0123abcd`]) {
			const result = await query({ from, to: "not-found", body });
			expect(result).toMatchObject({ status: "skip", error: "invalid_sender" });
		}
		expect(await query({ from: "sender-0123abcd", to: "not-found", body })).toMatchObject({
			status: "skip",
			error: "body_too_large",
		});
		expect(await query({ from: "sender-0123abcd", to: "not-found", body: "hello" })).toMatchObject({
			status: "skip",
			error: "unknown_target",
		});
		expect(await query({ from: "sender-0123abcd", to: "0123abcd", body: "hello" })).toMatchObject({
			status: "skip",
			error: "not_receiving",
		});
		expect(root.delivered).toEqual([]);
		expect(
			await query({ from: "sender-0123abcd", to: null, body: "é".repeat(MAILBOX_MAX_BODY_BYTES / 2) }),
		).toMatchObject({
			status: "ok",
			value: { ok: true, receipt: { outcome: "woken" } },
		});
	});

	it("publishes only receiving targets and notifies after effective override-driven withdrawal", async () => {
		const registry = await registryFixture();
		const host = makeService(registry, "print");
		const states: MailboxTargetState[] = [];
		const target = bind(host, { receive: false, notify: state => states.push(state) });
		await host.service.whenSettled();
		expect(await endpoints.readLocalEndpointEntries(registry)).toEqual([]);
		expect(formatMailboxState(states[0]!)).toBe(`Peers: on (send-only) — this session is ${host.service.address}`);
		target.unbind();
		const receiving = bind(host, { notify: state => states.push(state) });
		await host.service.whenSettled();
		expect(await endpoints.readLocalEndpointEntries(registry)).toHaveLength(1);
		expect(formatMailboxState(states[1]!)).toBe(`Peers: on — this session is ${host.service.address}`);
		cfgIrcCrossProcess.override(receiving.settings, false);
		await host.service.whenSettled();
		expect(await endpoints.readLocalEndpointEntries(registry)).toEqual([]);
		expect(states[2]).toEqual({ enabled: false });
		cfgIrcCrossProcess.set(receiving.settings, true);
		await host.service.whenSettled();
		expect(host.service.state("Main")).toEqual({ enabled: false });
		expect(states).toHaveLength(3);
	});

	it("unbinds the last receiving target and freezes the initialized address", async () => {
		const registry = await registryFixture();
		const host = makeService(registry, "original");
		const address = host.service.address;
		host.service.initialize("changed");
		expect(host.service.address).toBe(address);
		const target = bind(host);
		await host.service.whenSettled();
		target.unbind();
		target.unbind();
		await host.service.whenSettled();
		expect(await endpoints.readLocalEndpointEntries(registry)).toEqual([]);
	});

	it("lists only other processes and expands enabled ACP conversations into separately messageable peers", async () => {
		const registry = await registryFixture();
		const a = makeService(registry, "sender");
		const b = makeService(registry, "acp");
		bind(a, { agentId: "acp:sender", conversation: "fedcba98" });
		const first = bind(b, { agentId: "acp:first", conversation: "0123abcd" });
		const second = bind(b, { agentId: "acp:second", conversation: "89abcdef" });
		second.setBusy(true);
		bind(b, { agentId: "acp:disabled", conversation: "11111111", enabled: false });
		await Promise.all([a.service.whenSettled(), b.service.whenSettled()]);
		expect((await a.service.listPeers()).map(peer => ({ address: peer.address, busy: peer.busy }))).toEqual([
			{ address: `${b.service.address}.0123abcd`, busy: false },
			{ address: `${b.service.address}.89abcdef`, busy: true },
		]);
		expect(
			(await a.bus.send({ from: "acp:sender", to: `${b.service.address}.0123abcd`, body: "conversation hello" }))
				.outcome,
		).toBe("woken");
		expect(first.delivered[0]?.from).toBe(`${a.service.address}.fedcba98`);
		expect(second.delivered).toEqual([]);
		expect((await a.bus.send({ from: "acp:sender", to: `${b.service.address}.11111111`, body: "hello" })).error).toBe(
			`Peer ${b.service.address}.11111111 is not receiving messages.`,
		);
		expect(() =>
			b.service.bindTarget({
				agentId: "duplicate",
				conversation: "0123abcd",
				settings: Settings.isolated(),
				receive: true,
				describe: () => ({ title: null, busy: false }),
			}),
		).toThrow("already bound");
	});

	it("reports an unreachable peer, then prunes its stale metadata during listing", async () => {
		const registry = await registryFixture();
		const a = makeService(registry, "sender");
		const b = makeService(registry, "recipient");
		bind(a);
		bind(b);
		await Promise.all([a.service.whenSettled(), b.service.whenSettled()]);
		const entry = (await endpoints.readLocalEndpointEntries(registry)).find(
			item => item.meta.instanceId === b.service.address,
		);
		if (!entry) throw new Error("Missing peer metadata");
		await b.service.close();
		const metadataPath = path.join(registry.dir, `${entry.entryId}.json`);
		await Bun.write(metadataPath, JSON.stringify(entry.meta));
		await fs.chmod(metadataPath, 0o600);
		expect((await a.bus.send({ from: "Main", to: b.service.address, body: "hello" })).error).toBe(
			`Peer ${b.service.address} is not reachable.`,
		);
		expect(await a.service.listPeers()).toEqual([]);
		expect((await endpoints.readLocalEndpointEntries(registry)).map(item => item.meta.instanceId)).toEqual([
			a.service.address,
		]);
	});

	it("reports publication errors without disabling send-only access to another peer", async () => {
		const registry = await registryFixture();
		const b = makeService(registry, "recipient");
		const recipient = bind(b);
		await b.service.whenSettled();
		const publish = endpoints.publishLocalEndpoint;
		vi.spyOn(endpoints, "publishLocalEndpoint").mockImplementation(async (reg, handler, options) => {
			if (options?.instanceId?.startsWith("failed-")) throw new Error("publication denied");
			return publish(reg, handler, options);
		});
		const a = makeService(registry, "failed");
		const states: MailboxTargetState[] = [];
		bind(a, { notify: state => states.push(state) });
		await a.service.whenSettled();
		expect(formatMailboxState(states[0]!)).toBe("Peers: on, but receiving failed — publication denied");
		expect((await a.bus.send({ from: "Main", to: b.service.address, body: "still sending" })).outcome).toBe("woken");
		expect(recipient.delivered[0]?.body).toBe("still sending");
	});

	it("rejects deliveries once close begins even while endpoint withdrawal is pending", async () => {
		const registry = await registryFixture();
		const publish = endpoints.publishLocalEndpoint;
		const gate = Promise.withResolvers<void>();
		vi.spyOn(endpoints, "publishLocalEndpoint").mockImplementation(async (reg, handler, options) => {
			const publication = await publish(reg, handler, options);
			const close = publication.close.bind(publication);
			vi.spyOn(publication, "close").mockImplementation(async () => {
				await gate.promise;
				await close();
			});
			return publication;
		});
		const host = makeService(registry, "closing");
		const target = bind(host);
		await host.service.whenSettled();
		const meta = await metadata(registry, host.service);
		const closing = host.service.close();
		try {
			expect(
				await endpoints.queryLocalEndpoint(
					registry,
					meta,
					{ op: "deliver", from: "sender-0123abcd", to: null, body: "late" },
					1500,
				),
			).toMatchObject({ status: "skip", error: "not_receiving" });
			expect(target.delivered).toEqual([]);
		} finally {
			gate.resolve();
			await closing;
		}
		expect(await endpoints.readLocalEndpointEntries(registry)).toEqual([]);
		await host.service.close();
	});
});
