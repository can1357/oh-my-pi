/**
 * Attaching the hosting process's interactive session: a topic is created (or
 * reused) for its session file, Telegram messages are relayed as
 * `telegram-prompt` custom messages, an owned runtime for the same file is
 * superseded, and detaching stops the relay without touching the TUI session.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { CollabUiRequestDraft } from "@oh-my-pi/pi-wire";
import type { RemoteDialogHost } from "@oh-my-pi/pi-coding-agent/modes/remote-dialogs";
import type { AttachedSessionBinding } from "@oh-my-pi/pi-coding-agent/telegram/types";
import { bridgeHarness, fakeSession, message, update, type BridgeHarness, type FakeSession } from "./host-fixtures";

const live: BridgeHarness[] = [];

function harness(): BridgeHarness {
	const made = bridgeHarness();
	live.push(made);
	return made;
}

afterEach(async () => {
	for (const made of live.splice(0)) {
		await made.host.stop();
		made.cleanup();
	}
});

const TUI_FILE = "/tui/session.jsonl";

function attachable(
	session: FakeSession,
	fallbackTopicName = "terminal",
): {
	binding: AttachedSessionBinding;
	hosts: unknown[];
} {
	const hosts: unknown[] = [];
	const binding: AttachedSessionBinding = {
		session: session.session,
		addDialogHost: host => {
			hosts.push(host);
			return () => {
				const at = hosts.indexOf(host);
				if (at >= 0) hosts.splice(at, 1);
			};
		},
		fallbackTopicName,
	};
	return { binding, hosts };
}

const tuiSession = (): FakeSession => fakeSession({ file: TUI_FILE, name: "Refactor", id: "tui-1", cwd: "/tui" });

describe("attach", () => {
	it("creates a topic by the session file and relays messages as telegram-prompt custom messages", async () => {
		const h = harness();
		const session = tuiSession();
		const { binding, hosts } = attachable(session);
		await h.host.attach(binding);
		expect(h.api.of("createForumTopic").map(call => call.fields.name)).toEqual(["Refactor"]);
		const stored = h.readRegistry()[0];
		expect(stored.threadId).toBe(900);
		expect(stored.sessionFile).toBe(TUI_FILE);
		expect(stored.sessionId).toBe("tui-1");
		expect(h.host.status().attachedThreadId).toBe(900);
		expect(h.host.status().liveSessions).toBe(0);
		expect(hosts).toHaveLength(1);

		expect(
			await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "hello", messageId: 77 }) })),
		).toBe("prompt");
		expect(h.requests).toHaveLength(0);
		const relay = session.calls.find(call => call.method === "promptCustomMessage");
		expect(relay?.message).toMatchObject({
			customType: "telegram-prompt",
			content: "hello",
			display: true,
			details: { from: "Dev" },
			attribution: "user",
		});
		expect(relay?.options).toEqual({ streamingBehavior: "followUp", queueChipText: "hello" });
	});

	it("relays a photo as text plus an image content part", async () => {
		const h = harness();
		const session = tuiSession();
		await h.host.attach(attachable(session).binding);
		await h.host.handleUpdate(
			update({
				message: message({
					threadId: 900,
					text: "look",
					extra: { photo: [{ file_id: "big", file_unique_id: "b", width: 2, height: 2 }] },
				}),
			}),
		);
		const relay = session.calls.find(call => call.method === "promptCustomMessage");
		const content = (relay?.message as { content?: unknown[] } | undefined)?.content ?? [];
		expect(Array.isArray(content)).toBe(true);
		expect(content[0]).toEqual({ type: "text", text: "look" });
		expect((content[1] as { type?: string }).type).toBe("image");
	});

	it("reuses the topic already registered for the session file", async () => {
		const h = harness();
		h.queue(fakeSession({ file: TUI_FILE, id: "tui-1" }));
		await h.host.handleUpdate(update({ message: message({ text: "/new Refactor" }) }));
		const topicsBefore = h.api.of("createForumTopic").length;
		const session = tuiSession();
		await h.host.attach(attachable(session).binding);
		expect(h.api.of("createForumTopic")).toHaveLength(topicsBefore);
		expect(h.host.status().attachedThreadId).toBe(900);
	});

	it("stops an owned runtime holding the same file before relaying", async () => {
		const h = harness();
		const owned = fakeSession({ file: TUI_FILE, id: "owned" });
		h.queue(owned);
		await h.host.handleUpdate(update({ message: message({ text: "/new Refactor" }) }));
		expect(owned.calls.some(call => call.method === "dispose")).toBe(false);
		await h.host.attach(attachable(tuiSession()).binding);
		expect(owned.calls.some(call => call.method === "dispose")).toBe(true);
		expect(h.host.status().liveSessions).toBe(0);
		await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "hello" }) }));
		expect(h.requests).toHaveLength(1);
	});

	it("refuses a session without a session file", async () => {
		const h = harness();
		const session = fakeSession({ file: null });
		let thrown: unknown;
		try {
			await h.host.attach(attachable(session).binding);
		} catch (error) {
			thrown = error;
		}
		expect(thrown instanceof Error).toBe(true);
		expect((thrown as Error).message).toContain("no session file");
		expect(h.api.of("createForumTopic")).toHaveLength(0);
	});

	it("stops routing TUI dialogs into the topic once /close ends the relay", async () => {
		const h = harness();
		const session = tuiSession();
		const { binding, hosts } = attachable(session);
		await h.host.attach(binding);
		const dialogHost = hosts[0] as RemoteDialogHost;
		const request: CollabUiRequestDraft = { kind: "select", title: "Model", options: ["Fast"] };
		expect(dialogHost.requestGuestUi(request)).not.toBeNull();

		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "/close" }) }))).toBe("close");
		expect(dialogHost.requestGuestUi(request)).toBeNull();

		// The next message revives the relay, and dialogs are routed again.
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "again" }) }))).toBe("prompt");
		expect(dialogHost.requestGuestUi(request)).not.toBeNull();
	});

	it("keeps the TUI session's file protected between detach and the next attach", async () => {
		const h = harness();
		const session = tuiSession();
		await h.host.attach(attachable(session).binding);
		await h.host.detach();
		expect(h.host.status().attachedThreadId).toBeNull();
		expect(h.readRegistry()[0].status).toBe("idle");
		// The TUI session is still live in this process: its presence record must
		// stop a second writer from being raised on the same file.
		h.presence = [
			{
				pid: process.pid,
				kind: "interactive",
				sessionId: "tui-1",
				sessionFile: TUI_FILE,
				cwd: "/tui",
				sessionName: "Refactor",
				startedAt: 0,
				updatedAt: 0,
			},
		];
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "hello" }) }))).toBe(
			"busy_session",
		);
		expect(h.requests).toHaveLength(0);
		expect(session.calls.filter(call => call.method === "promptCustomMessage")).toHaveLength(0);
	});

	it("ends the relay on /close and re-attaches on the next message", async () => {
		const h = harness();
		const session = tuiSession();
		await h.host.attach(attachable(session).binding);
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "/close" }) }))).toBe("close");
		expect(h.readRegistry()[0].status).toBe("closed");
		expect(session.calls.some(call => call.method === "dispose")).toBe(false);
		session.calls.length = 0;
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "again" }) }))).toBe("prompt");
		expect(h.requests).toHaveLength(0);
		expect(session.calls.filter(call => call.method === "promptCustomMessage")).toHaveLength(1);
		expect(h.readRegistry()[0].status).toBe("idle");
		expect(h.host.status().attachedThreadId).toBe(900);
	});
});
