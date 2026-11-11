import { afterAll, afterEach, expect, it, vi } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as mailbox from "@oh-my-pi/pi-coding-agent/messaging/mailbox";
import { type MessagingHost, MessagingService, type RemoteDelivery } from "@oh-my-pi/pi-coding-agent/messaging/service";
import * as transport from "@oh-my-pi/pi-coding-agent/messaging/transport";

const services: MessagingService[] = [];
const directories: TempDir[] = [];
const realLock = mailbox.withOfflineMailboxLock;
const realDrain = mailbox.drainOffline;
const realPublish = transport.publishInbox;

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
	await Promise.all(services.map(service => service.close()));
	for (const dir of directories) dir[Symbol.dispose]();
});

function host(id: string) {
	const deliveries: RemoteDelivery[] = [];
	const value: MessagingHost = {
		sessionId: () => id,
		cwd: () => "/project",
		directPrint: false,
		sessionName: () => id,
		titleSource: () => "user",
		isBusy: () => false,
		isReceivingSuspended: () => false,
		isSessionTransitioning: () => false,
		permissionClass: () => "bypass",
		onPolicyInputsChange: () => () => {},
		deliverRemote: async batch => {
			deliveries.push(...batch);
			return true;
		},
		pendingRemoteCount: () => deliveries.length,
		showNotice: () => {},
		deliverNotice: async () => true,
		askApproval: undefined,
		currentRelayChain: () => [],
		lastFinished: () => undefined,
	};
	return { value, deliveries };
}

for (const scenario of ["startup", "idle-settle"] as const) {
	it(`admits offline mail once across concurrent ${scenario} drains`, async () => {
		const temp = TempDir.createSync("@omp-offline-race-");
		directories.push(temp);
		const dir = temp.path();
		vi.spyOn(transport, "publishInbox").mockImplementation((handler, options) =>
			realPublish(handler, { ...options, dir }),
		);
		const a = host("resumed-session");
		const b = host("resumed-session");
		const start = async (h: MessagingHost) => {
			const service = await MessagingService.start(h, Settings.isolated({}));
			services.push(service);
			service.markReady();
			return service;
		};
		const running = scenario === "idle-settle" ? await Promise.all([start(a.value), start(b.value)]) : [];
		await mailbox.enqueueOffline(
			"resumed-session",
			{
				id: "race-message",
				from: {
					sessionId: "sender-session",
					name: "sender",
					shortId: "12345678",
					cwd: "/sender",
					entryId: "sender-entry",
					class: "bypass",
				},
				body: "race body",
				chain: ["12345678"],
				sentAt: Date.now(),
			},
			{ dir },
		);
		const firstRead = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const barrier = async <T>(result: T): Promise<T> => {
			if (++calls === 1) {
				firstRead.resolve();
				await release.promise;
			} else release.resolve();
			return result;
		};
		// Pause after the real transaction unlocks. Before the fix this is before admission;
		// after the fix admission and removal have already completed under that lock.
		vi.spyOn(mailbox, "withOfflineMailboxLock").mockImplementation(
			async <T>(id: string, fn: () => Promise<T>, options?: Parameters<typeof realLock>[2]) =>
				barrier(await realLock(id, fn, options)),
		);
		if (scenario === "idle-settle") {
			vi.spyOn(mailbox, "drainOffline").mockImplementation(async (id, options) =>
				barrier(await realDrain(id, options)),
			);
			running[0].turnSettledIdle();
			await firstRead.promise;
			running[1].turnSettledIdle();
			// Retirement fences the idle drains and releases A even if B skipped an already-empty mailbox.
			await Promise.all(running.map(service => service.retireConversation()));
		} else {
			const first = start(a.value);
			await firstRead.promise;
			await Promise.all([first, start(b.value)]);
		}
		expect([...a.deliveries, ...b.deliveries].map(delivery => delivery.id)).toEqual(["race-message"]);
	}, 15_000);
}
