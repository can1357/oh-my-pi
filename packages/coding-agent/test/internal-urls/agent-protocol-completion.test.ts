import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import {
	publishLocalEndpoint,
	readLocalEndpointEntries,
	type LocalEndpointPublication,
	type LocalEndpointRegistry,
} from "@oh-my-pi/pi-coding-agent/ipc/local-endpoint-registry";
import { MAILBOX_REGISTRY, type MailboxSnapshot } from "@oh-my-pi/pi-coding-agent/mailbox/protocol";
import { MailboxService } from "@oh-my-pi/pi-coding-agent/mailbox/service";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TempDir } from "@oh-my-pi/pi-utils";

const address = "project-abcdef12";
const snapshot: MailboxSnapshot = {
	address,
	id: "remote-peer",
	pid: process.pid,
	cwd: "/other/project",
	startedAt: 1,
	targets: [{ conversation: null, title: null, busy: false, alias: "worker", cwd: null }],
};

let tempDir: TempDir;
let registry: LocalEndpointRegistry;
let mailbox: MailboxService;
let publication: LocalEndpointPublication | undefined;

describe("agent:// peer completion", () => {
	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
		tempDir = TempDir.createSync("omp-peer-completion-");
		registry = { ...MAILBOX_REGISTRY, dir: tempDir.path() };
		mailbox = new MailboxService({ registry, agentRegistry: new AgentRegistry() });
		mailbox.initialize("completion-reader");
		mailbox.bindTarget({
			agentId: "Main",
			conversation: null,
			settings: Settings.isolated({ "irc.crossProcess": true }),
			receive: false,
			describe: () => ({ title: null, busy: false }),
		});
		await mailbox.whenSettled();
		vi.spyOn(MailboxService, "global").mockReturnValue(mailbox);
		AgentRegistry.global().register({ id: "Main", displayName: "main", kind: "main", session: null });
	});

	afterEach(async () => {
		await publication?.close();
		publication = undefined;
		await mailbox.close();
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
		tempDir.removeSync();
	});

	it("offers canonical addresses and bare aliases, deduplicating same-named local outputs", async () => {
		publication = await publishLocalEndpoint(registry, () => ({ ok: true, snapshot }), { instanceId: address });
		const handler = new AgentProtocolHandler();
		expect((await handler.complete()).map(item => item.value)).toEqual([address, "worker"]);

		const artifactsDir = path.join(tempDir.path(), "artifacts");
		await Bun.write(path.join(artifactsDir, "worker.md"), "local worker output");
		registerArtifactsDir(artifactsDir);
		expect((await handler.complete()).map(item => item.value)).toEqual([address, "worker"]);
	});

	it("discards an aborted discovery response without pruning the peer endpoint", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		publication = await publishLocalEndpoint(
			registry,
			async () => {
				started.resolve();
				await release.promise;
				return { ok: true, snapshot };
			},
			{ instanceId: address },
		);
		const controller = new AbortController();
		const completion = new AgentProtocolHandler().complete("", { signal: controller.signal });
		try {
			await started.promise;
			controller.abort();
			release.resolve();
			expect(await completion).toEqual([]);
			expect((await readLocalEndpointEntries(registry)).map(entry => entry.meta.instanceId)).toEqual([address]);
		} finally {
			release.resolve();
			await completion;
		}
	});
});
