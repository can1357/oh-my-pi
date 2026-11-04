import { expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpcServer } from "@oh-my-pi/pi-natives";
import { startAgentAttachService, type AgentAttachService } from "../../src/agent-attach/service";
import type { AgentRegistryApi } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { EventBus } from "../../src/utils/event-bus";

it("keeps rapid owner switches distinct and removes all discovery endpoints when closed during publication", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attach-switch-"));
	const withdrawalStarted = Promise.withResolvers<void>();
	const releaseWithdrawal = Promise.withResolvers<void>();
	const finalPublicationStarted = Promise.withResolvers<void>();
	const releaseFinalPublication = Promise.withResolvers<void>();
	const publishedOwners: string[] = [];
	let ownerSessionId = "owner-one";
	let onSessionChange: (() => void) | undefined;
	let firstServer: IpcServer | undefined;
	let service: AgentAttachService | undefined;
	const listen = IpcServer.listen.bind(IpcServer);
	const rename = fs.rename;
	vi.spyOn(IpcServer, "listen").mockImplementation(async (...args) => {
		const server = await listen(...args);
		firstServer ??= server;
		return server;
	});
	vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		await rename(from, to);
		if (path.dirname(String(to)) !== dir || !String(to).endsWith(".json")) return;
		const metadata = (await Bun.file(String(to)).json()) as { ownerSessionId: string };
		publishedOwners.push(metadata.ownerSessionId);
		if (metadata.ownerSessionId === "owner-three") {
			finalPublicationStarted.resolve();
			await releaseFinalPublication.promise;
		}
	});
	try {
		service = await startAgentAttachService({
			dir,
			session: {
				sessionManager: { getSessionId: () => ownerSessionId },
				registerSessionChangeCallback(callback: () => void) {
					onSessionChange = callback;
					return () => {};
				},
				emitNotice() {},
			} as unknown as AgentSession,
			registry: { onChange: () => () => {} } as unknown as AgentRegistryApi,
			eventBus: new EventBus(),
			subagentEventBus: new EventBus(),
		});
		if (!firstServer || !onSessionChange) throw new Error("Owner publication did not initialize");
		const close = firstServer.close.bind(firstServer);
		vi.spyOn(firstServer, "close").mockImplementationOnce(async () => {
			withdrawalStarted.resolve();
			await releaseWithdrawal.promise;
			await close();
		});
		ownerSessionId = "owner-two";
		onSessionChange();
		await withdrawalStarted.promise;
		ownerSessionId = "owner-three";
		onSessionChange();
		releaseWithdrawal.resolve();
		await finalPublicationStarted.promise;
		const closing = service.close();
		releaseFinalPublication.resolve();
		await closing;
		expect(publishedOwners).toEqual(["owner-one", "owner-two", "owner-three"]);
		expect(await fs.readdir(dir)).toEqual([]);
	} finally {
		releaseWithdrawal.resolve();
		releaseFinalPublication.resolve();
		await service?.close();
		vi.restoreAllMocks();
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 10_000);
