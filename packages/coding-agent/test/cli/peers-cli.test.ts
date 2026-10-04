import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as peersCli from "@oh-my-pi/pi-coding-agent/cli/peers-cli";
import { resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";
import Peers from "@oh-my-pi/pi-coding-agent/commands/peers";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	readLocalEndpointEntries,
	type LocalEndpointRegistry,
} from "@oh-my-pi/pi-coding-agent/ipc/local-endpoint-registry";
import { IrcBus, IrcDeliveryRejectedError } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { MAILBOX_REGISTRY } from "@oh-my-pi/pi-coding-agent/mailbox/protocol";
import { MailboxService } from "@oh-my-pi/pi-coding-agent/mailbox/service";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { type CliConfig, CliUsageError } from "@oh-my-pi/pi-utils/cli";

const CONFIG: CliConfig = { bin: "omp", version: "0.0.0-test", commands: new Map() };
const services: MailboxService[] = [];
const directories: string[] = [];

async function registryFixture(): Promise<LocalEndpointRegistry> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-peers-cli-"));
	directories.push(dir);
	return { ...MAILBOX_REGISTRY, dir };
}

async function publishPeer(
	registry: LocalEndpointRegistry,
	options: { alias?: string; cwd?: string; title?: string; busy?: boolean; error?: string } = {},
) {
	const agentRegistry = new AgentRegistry();
	const bus = new IrcBus(agentRegistry, new AgentLifecycleManager(agentRegistry));
	const service = new MailboxService({ registry, bus, agentRegistry });
	services.push(service);
	service.initialize("recipient");
	const delivered: IrcMessage[] = [];
	const publicationsDuringDelivery: string[] = [];
	const session = {
		deliverIrcMessage: async (message: IrcMessage) => {
			if (options.error) throw new IrcDeliveryRejectedError(options.error);
			delivered.push(message);
			publicationsDuringDelivery.push(
				...(await readLocalEndpointEntries(registry)).map(entry => entry.meta.instanceId),
			);
			return options.busy ? "injected" : "woken";
		},
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
	agentRegistry.register({ id: "Main", displayName: "main", kind: "main", session });
	service.bindTarget({
		agentId: "Main",
		conversation: null,
		settings: Settings.isolated({ "irc.crossProcess": true, "irc.peerAlias": options.alias ?? "" }),
		receive: true,
		describe: () => ({
			title: options.title ?? "Test conversation",
			busy: options.busy ?? false,
			cwd: options.cwd ?? "/peer/work",
		}),
	});
	await service.whenSettled();
	return { service, delivered, publicationsDuringDelivery };
}

/** Parse the real command and use its real endpoint handler with isolated output. */
async function runCommand(argv: string[], registry: LocalEndpointRegistry) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const run = peersCli.runPeersCommand;
	const handlerSpy = spyOn(peersCli, "runPeersCommand").mockImplementation(args =>
		run({ ...args, registry }, line => stdout.push(line)),
	);
	const stderrSpy = spyOn(process.stderr, "write").mockImplementation(chunk => {
		stderr.push(String(chunk));
		return true;
	});
	const priorExitCode = process.exitCode;
	try {
		await new Peers(argv, CONFIG).run();
		return { stdout: stdout.join("\n"), stderr: stderr.join(""), exitCode: Number(process.exitCode ?? 0) };
	} finally {
		process.exitCode = priorExitCode;
		stderrSpy.mockRestore();
		handlerSpy.mockRestore();
	}
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const service of services.splice(0)) await service.close();
	for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("Peers CLI", () => {
	it("reports an empty registry without publishing its own receiver", async () => {
		const registry = await registryFixture();
		expect(await runCommand(["list"], registry)).toEqual({
			stdout: "No other omp processes have peers on.",
			stderr: "",
			exitCode: 0,
		});
		expect(await runCommand(["list", "--json"], registry)).toEqual({ stdout: "[]", stderr: "", exitCode: 0 });
		expect(await readLocalEndpointEntries(registry)).toEqual([]);
	});

	it("prints a bare peer array as JSON including aliases and conversation workspaces", async () => {
		const registry = await registryFixture();
		const { service } = await publishPeer(registry, { alias: "worker", busy: true });
		const result = await runCommand(["list", "--json"], registry);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual([
			{
				address: service.address,
				id: service.id,
				pid: process.pid,
				conversation: null,
				alias: "worker",
				cwd: "/peer/work",
				title: "Test conversation",
				busy: true,
			},
		]);
	});

	it("lists sanitized, width-bounded peer rows rather than emitting terminal controls", async () => {
		const registry = await registryFixture();
		const { service } = await publishPeer(registry, {
			alias: "worker",
			cwd: "/peer/\u001b]52;c;payload\u0007\nwork",
			title: "Review\nSession\t\u001b[31m",
		});
		const result = await runCommand(["list"], registry);
		expect(result.stdout).toContain(`${service.address} (worker)  /peer/ work  "Review Session"  idle`);
		expect(result.stdout).not.toMatch(/[\u001b\u0007\t\r\n]/);
		expect(Bun.stringWidth(result.stdout)).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);
		await publishPeer(registry, { title: "x".repeat(TRUNCATE_LENGTHS.LINE * 2) });
		const long = await runCommand(["list"], registry);
		for (const line of long.stdout.split("\n"))
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);
	});

	it("sends a multi-word message to an address and exits zero without publishing a sender endpoint", async () => {
		const registry = await registryFixture();
		const peer = await publishPeer(registry);
		expect(await runCommand(["send", peer.service.address, "hello", "from", "the", "shell"], registry)).toEqual({
			stdout: `Delivered to ${peer.service.address} (woken).`,
			stderr: "",
			exitCode: 0,
		});
		expect(peer.delivered.map(message => ({ body: message.body, remote: message.remote }))).toEqual([
			{ body: "hello from the shell", remote: true },
		]);
		expect(peer.publicationsDuringDelivery).toEqual([peer.service.address]);
	});

	it("resolves an alias and reports an injected receipt for a busy recipient", async () => {
		const registry = await registryFixture();
		const peer = await publishPeer(registry, { alias: "worker", busy: true });
		expect(await runCommand(["send", "worker", "aside"], registry)).toEqual({
			stdout: "Delivered to worker (injected).",
			stderr: "",
			exitCode: 0,
		});
		expect(peer.delivered[0]?.body).toBe("aside");
	});

	it("prints a recipient's failed receipt to stderr and exits one", async () => {
		const registry = await registryFixture();
		const peer = await publishPeer(registry, {
			error: "Recipient is switching or compacting its session; retry shortly.",
		});
		expect(await runCommand(["send", peer.service.address, "hello"], registry)).toEqual({
			stdout: "",
			stderr: "Recipient is switching or compacting its session; retry shortly.\n",
			exitCode: 1,
		});
		expect(peer.delivered).toEqual([]);
	});

	it.each([
		{ argv: ["list", "worker"] },
		{ argv: ["send"] },
		{ argv: ["send", "worker"] },
		{ argv: ["send", "worker", "   "] },
		{ argv: ["send", "worker", "hello", "--json"] },
		{ argv: ["unknown"] },
	])("rejects invalid usage $argv before opening a mailbox", async ({ argv }) => {
		const run = spyOn(peersCli, "runPeersCommand");
		await expect(new Peers([...argv], CONFIG).run()).rejects.toBeInstanceOf(CliUsageError);
		expect(run).not.toHaveBeenCalled();
	});

	it("routes peer list and send requests as commands, not launch prompts", () => {
		expect(resolveCliArgv(["peers", "list", "--json"])).toEqual({ argv: ["peers", "list", "--json"] });
		expect(resolveCliArgv(["--cwd", "/tmp", "peers", "send", "worker", "hello"])).toEqual({
			argv: ["peers", "send", "worker", "hello"],
		});
	});
});
