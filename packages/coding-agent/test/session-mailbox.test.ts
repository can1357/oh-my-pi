import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	claimMail,
	deliveryTarget,
	isMailDone,
	listClaimedMail,
	listNewMail,
	MAX_MAIL_ATTEMPTS,
	newMailId,
	postMail,
	recordMailAttempt,
} from "@oh-my-pi/pi-coding-agent/mailbox/mailbox";
import { MAILBOX_DIR_ENV, MAILBOX_ENV, mailDir } from "@oh-my-pi/pi-coding-agent/mailbox/paths";
import { listSessionPresence } from "@oh-my-pi/pi-coding-agent/mailbox/presence";
import { SessionMailbox } from "@oh-my-pi/pi-coding-agent/mailbox/watcher";
import { TempDir } from "@oh-my-pi/pi-utils";

const SESSION_STORAGE_MODULE = path.resolve(import.meta.dir, "../src/session/session-storage.ts");

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

/** Text of every message one model request carried, in order. */
function requestTexts(context: Context): string[] {
	return context.messages.map(message =>
		typeof message.content === "string"
			? message.content
			: message.content.map(part => ("text" in part ? part.text : "")).join(""),
	);
}

describe("session mailbox delivery", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let previousRoot: string | undefined;
	let previousSwitch: string | undefined;
	let sessions: AgentSession[];
	let contexts: Context[];
	let release: PromiseWithResolvers<void>;
	let toolStarted: PromiseWithResolvers<void>;
	let stalled: boolean;
	let stallStarted: PromiseWithResolvers<void>;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-session-mailbox-");
		previousRoot = Bun.env[MAILBOX_DIR_ENV];
		previousSwitch = Bun.env[MAILBOX_ENV];
		Bun.env[MAILBOX_DIR_ENV] = path.join(tempDir.path(), "mailbox");
		delete Bun.env[MAILBOX_ENV];
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
		sessions = [];
		contexts = [];
		release = Promise.withResolvers<void>();
		toolStarted = Promise.withResolvers<void>();
		stalled = false;
		stallStarted = Promise.withResolvers<void>();
	});

	afterEach(async () => {
		release.resolve();
		for (const opened of sessions) await opened.dispose().catch(() => {});
		authStorage.close();
		if (previousRoot === undefined) delete Bun.env[MAILBOX_DIR_ENV];
		else Bun.env[MAILBOX_DIR_ENV] = previousRoot;
		if (previousSwitch === undefined) delete Bun.env[MAILBOX_ENV];
		else Bun.env[MAILBOX_ENV] = previousSwitch;
		tempDir.removeSync();
	});

	/**
	 * Poll `mailbox` until `condition` holds. Between polls the turns a poll
	 * started finish and their entries reach the session file.
	 */
	async function pollUntil(mailbox: SessionMailbox, condition: () => boolean): Promise<void> {
		while (!condition()) {
			await mailbox.poll();
			for (const opened of sessions) {
				if (opened.isDisposed) continue;
				await opened.waitForIdle();
				// One test keeps the file unwritable while it polls.
				await opened.sessionManager.flush().catch(() => {});
			}
			// A poll with nothing to read settles in microtasks; let I/O run before the next.
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
		}
	}

	/** A session file written by an earlier process, closed again. */
	async function savedSessionFile(): Promise<string> {
		const { session: first } = openSession();
		await first.prompt("seed");
		const file = first.sessionManager.getSessionFile()!;
		await first.dispose();
		contexts.length = 0;
		return file;
	}

	/** A session whose model calls `slow` when the prompt is "go", and answers text otherwise. */
	function openSession(
		sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions")),
		clientBridge?: ClientBridge,
	): { session: AgentSession; mailbox: SessionMailbox } {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const slowTool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Blocks until released",
			parameters: type({}),
			execute: async () => {
				toolStarted.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "SLOW_DONE" }] };
			},
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [slowTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context, options) => {
				contexts.push(context);
				const last = requestTexts(context).at(-1);
				if (last === "stall" && !stalled) {
					// Hold the first such request until Esc aborts it, before any output.
					stalled = true;
					stallStarted.resolve();
					const stream = new AssistantMessageEventStream();
					options?.signal?.addEventListener(
						"abort",
						() => {
							const aborted: AssistantMessage = {
								role: "assistant",
								content: [],
								api: model.api,
								provider: model.provider,
								model: model.id,
								usage: zeroUsage,
								stopReason: "aborted",
								timestamp: Date.now(),
							};
							stream.push({ type: "start", partial: aborted });
							stream.push({ type: "error", reason: "aborted", error: aborted });
						},
						{ once: true },
					);
					return stream;
				}
				const message: AssistantMessage = {
					role: "assistant",
					content:
						last === "go"
							? [{ type: "toolCall", id: `tc-${contexts.length}`, name: "slow", arguments: {} }]
							: [{ type: "text", text: "ok" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: last === "go" ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const mailbox = new SessionMailbox(sessionManager, { deliver: true, host: "test" });
		const opened = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([[slowTool.name, slowTool]]),
		});
		opened.setClientBridge(clientBridge);
		mailbox.bind(opened);
		sessions.push(opened);
		return { session: opened, mailbox };
	}

	async function poke(sessionId: string, text: string, force?: boolean, id = newMailId("poke")): Promise<string> {
		await postMail({
			v: 1,
			id,
			kind: "poke",
			sessionId,
			createdAt: new Date().toISOString(),
			poke: { text, from: "test", force },
		});
		return id;
	}

	/** Whether another process could take the session's write lease now (the lease is shared within a process). */
	async function leaseFromAnotherProcess(sessionId: string): Promise<string> {
		const probe = path.join(tempDir.path(), "lease-probe.ts");
		await Bun.write(
			probe,
			`import { tryAcquireSessionLease } from ${JSON.stringify(SESSION_STORAGE_MODULE)};
			const lease = tryAcquireSessionLease(${JSON.stringify(sessionId)});
			console.log(lease ? "free" : "taken");
			lease?.release();`,
		);
		const child = Bun.spawn(["bun", probe], { env: { ...process.env }, stdout: "pipe" });
		return (await new Response(child.stdout).text()).trim();
	}

	/** Run a turn into the slow tool, then interrupt it the way Esc does. */
	async function interrupt(opened: AgentSession): Promise<void> {
		const run = opened.prompt("go");
		await toolStarted.promise;
		release.resolve();
		await opened.abort({ reason: USER_INTERRUPT_LABEL });
		await run.catch(() => {});
		await opened.waitForIdle();
		contexts.length = 0;
	}

	it("starts a turn in an idle session and records the mail as delivered", async () => {
		const { session: opened, mailbox } = openSession();
		const sessionId = opened.sessionManager.getSessionId();
		expect(deliveryTarget(sessionId)).toMatchObject({ kind: "live", host: "test" });

		const mailId = await poke(sessionId, "BUILD_FINISHED");
		await pollUntil(mailbox, () => isMailDone(sessionId, mailId));

		expect(contexts).toHaveLength(1);
		expect(requestTexts(contexts[0]!).at(-1)).toContain("BUILD_FINISHED");
	});

	it("after Esc, delivers a --force poke at once and holds a plain one for the user's next message, ahead of it in the same request", async () => {
		const { session: opened, mailbox } = openSession();
		const sessionId = opened.sessionManager.getSessionId();
		await interrupt(opened);

		const heldId = await poke(sessionId, "HELD_POKE");
		const forcedId = await poke(sessionId, "FORCED_POKE", true);
		// Every poll that sees the forced poke also lists the held one, posted first.
		await pollUntil(mailbox, () => isMailDone(sessionId, forcedId));
		expect(contexts).toHaveLength(1);
		expect(requestTexts(contexts[0]!).at(-1)).toContain("FORCED_POKE");
		expect(listNewMail(sessionId)).toEqual([`${heldId}.json`]);

		await opened.prompt("NEXT_USER_MESSAGE");
		expect(contexts).toHaveLength(2);
		const texts = requestTexts(contexts[1]!);
		const pokeAt = texts.findIndex(text => text.includes("HELD_POKE"));
		expect(pokeAt).toBeGreaterThan(-1);
		expect(texts.indexOf("NEXT_USER_MESSAGE")).toBeGreaterThan(pokeAt);
		await pollUntil(mailbox, () => isMailDone(sessionId, heldId));
	});

	it("carries mail an Esc held into the turn the continue shortcut resumes, not a turn after it", async () => {
		const { session: opened, mailbox } = openSession();
		const sessionId = opened.sessionManager.getSessionId();
		// Esc before any output: the continue shortcut re-runs the prompt as is.
		const run = opened.prompt("stall");
		await stallStarted.promise;
		await opened.abort({ reason: USER_INTERRUPT_LABEL });
		await run.catch(() => {});
		await opened.waitForIdle();
		contexts.length = 0;
		expect(opened.interruptLatched).toBe(true);

		const heldId = await poke(sessionId, "HELD_POKE");
		await mailbox.poll();
		expect(listNewMail(sessionId)).toEqual([`${heldId}.json`]);

		await opened.resume();
		await opened.waitForIdle();
		expect(contexts).toHaveLength(1);
		const texts = requestTexts(contexts[0]!);
		expect(texts.indexOf("stall")).toBeGreaterThan(-1);
		expect(texts.findIndex(text => text.includes("HELD_POKE"))).toBeGreaterThan(texts.indexOf("stall"));
		await pollUntil(mailbox, () => isMailDone(sessionId, heldId));
		expect(contexts).toHaveLength(1);
	});

	it("takes no waiting mail for a prompt that fails because a turn is running", async () => {
		const { session: opened } = openSession();
		const run = opened.prompt("go");
		await toolStarted.promise;
		let taken = 0;
		opened.setHeldMailProvider(() => {
			taken++;
			return [];
		});

		expect(
			await opened.prompt("busy").then(
				() => undefined,
				(error: Error) => error.name,
			),
		).toBe("AgentBusyError");
		expect(taken).toBe(0);
		release.resolve();
		await run;
	});

	it("withdraws presence when the session closes, so later mail for it is held for the next opener", async () => {
		const { session: opened } = openSession();
		const sessionId = opened.sessionManager.getSessionId();
		expect(listSessionPresence(sessionId)).toHaveLength(1);

		await opened.dispose();
		expect(listSessionPresence(sessionId)).toEqual([]);
		expect(deliveryTarget(sessionId)).toEqual({ kind: "free" });
	});

	it("withdraws presence even when closing the session file fails", async () => {
		const { session: opened } = openSession();
		const sessionId = opened.sessionManager.getSessionId();
		spyOn(opened.sessionManager, "close").mockRejectedValue(new Error("disk gone"));

		expect(
			await opened.dispose().then(
				() => undefined,
				(error: Error) => error.message,
			),
		).toBe("disk gone");
		expect(listSessionPresence(sessionId)).toEqual([]);
	});

	it("opening a saved session leaves its write lease to the first writer while no mail waits", async () => {
		const file = await savedSessionFile();
		const { session: opened } = openSession(await SessionManager.open(file));
		const sessionId = opened.sessionManager.getSessionId();
		expect(deliveryTarget(sessionId)).toMatchObject({ kind: "live" });

		expect(await leaseFromAnotherProcess(sessionId)).toBe("free");
	});

	it("moves a malformed message to failed/, leaves one only a newer omp reads, and delivers the mail behind both", async () => {
		const { session: opened, mailbox } = openSession();
		const sessionId = opened.sessionManager.getSessionId();
		const newDir = path.join(mailDir(sessionId), "new");
		fs.mkdirSync(newDir, { recursive: true });
		// Both sort ahead of every `poke-…` message.
		fs.writeFileSync(path.join(newDir, "a-truncated.json"), '{"v":1,"id":"a-trunc');
		fs.writeFileSync(
			path.join(newDir, "a-future.json"),
			JSON.stringify({ v: 1, id: "a-future", kind: "timer-fire", sessionId, createdAt: new Date().toISOString() }),
		);

		const mailId = await poke(sessionId, "BEHIND_BAD_MAIL");
		await pollUntil(mailbox, () => isMailDone(sessionId, mailId));
		expect(requestTexts(contexts[0]!).at(-1)).toContain("BEHIND_BAD_MAIL");
		expect(fs.readdirSync(path.join(mailDir(sessionId), "failed"))).toEqual(["a-truncated.json"]);
		expect(listNewMail(sessionId)).toEqual(["a-future.json"]);
	});

	it("moves a message out of attempts to failed/ and leaves the write lease to the first writer", async () => {
		const file = await savedSessionFile();
		const sessionId = (await SessionManager.open(file)).getSessionId();
		const name = `${await poke(sessionId, "NEVER_LANDS")}.json`;
		// Consumers that each claimed it and died before it reached the session file.
		claimMail(sessionId, name);
		for (let attempt = 0; attempt < MAX_MAIL_ATTEMPTS; attempt++) recordMailAttempt(sessionId, name);

		const { mailbox } = openSession(await SessionManager.open(file));
		await pollUntil(mailbox, () => listClaimedMail(sessionId).length === 0);
		expect(await leaseFromAnotherProcess(sessionId)).toBe("free");
		expect(fs.readdirSync(path.join(mailDir(sessionId), "failed"))).toEqual([name]);
		expect(listNewMail(sessionId)).toEqual([]);
		expect(contexts).toHaveLength(0);
	});

	it("lets one of two session managers in a process consume the session's mail, so a poke is delivered once", async () => {
		const file = await savedSessionFile();
		const { session: first, mailbox } = openSession(await SessionManager.open(file));
		const { session: second } = openSession(await SessionManager.open(file));
		const sessionId = first.sessionManager.getSessionId();
		expect(second.sessionManager.getSessionId()).toBe(sessionId);
		expect(
			listSessionPresence(sessionId)
				.map(record => record.delivers)
				.sort(),
		).toEqual([false, true]);

		const mailId = await poke(sessionId, "ONE_CONSUMER");
		await pollUntil(mailbox, () => isMailDone(sessionId, mailId));
		expect(
			contexts.filter(context => requestTexts(context).some(text => text.includes("ONE_CONSUMER"))),
		).toHaveLength(1);
	});

	it("does not claim mail while extensions load, so a session switched to meanwhile never receives it", async () => {
		const { session: opened, mailbox } = openSession();
		await opened.prompt("seed");
		const oldId = opened.sessionManager.getSessionId();
		const loaded = Promise.withResolvers<void>();
		opened.setDeferredExtensionLoader(() => loaded.promise);
		contexts.length = 0;

		const mailId = await poke(oldId, "OLD_SESSION_POKE");
		// A poll that claimed the poke would hand it to the session that is current once extensions load.
		await mailbox.poll();
		await opened.newSession();
		loaded.resolve();
		await opened.prompt("in the new session");
		expect(contexts.some(context => requestTexts(context).some(text => text.includes("OLD_SESSION_POKE")))).toBe(
			false,
		);
		expect(listNewMail(oldId)).toEqual([`${mailId}.json`]);
	});

	it("returns a claim its consumer left behind to the mailbox and delivers it once", async () => {
		const file = await savedSessionFile();
		const sessionId = (await SessionManager.open(file)).getSessionId();
		const mailId = await poke(sessionId, "LEFT_BEHIND");
		// A consumer that died after claiming, before the message reached the file.
		claimMail(sessionId, `${mailId}.json`);

		const { mailbox } = openSession(await SessionManager.open(file));
		await pollUntil(mailbox, () => isMailDone(sessionId, mailId));
		expect(contexts).toHaveLength(1);
		expect(requestTexts(contexts[0]!).at(-1)).toContain("LEFT_BEHIND");
		expect(listClaimedMail(sessionId)).toEqual([]);
	});

	it("does not count a left-behind claim as delivered when only other text in the session file names its id", async () => {
		const mailId = newMailId("poke");
		const { session: first } = openSession();
		await first.prompt(`ls ~/.omp/agent/mailbox/mail/*/cur/${mailId}.json`);
		const file = first.sessionManager.getSessionFile()!;
		const sessionId = first.sessionManager.getSessionId();
		await first.dispose();
		contexts.length = 0;
		await poke(sessionId, "ECHOED_POKE", false, mailId);
		claimMail(sessionId, `${mailId}.json`);

		const { mailbox } = openSession(await SessionManager.open(file));
		await pollUntil(mailbox, () => isMailDone(sessionId, mailId));
		expect(contexts).toHaveLength(1);
		expect(requestTexts(contexts[0]!).at(-1)).toContain("ECHOED_POKE");
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"counts a poke as delivered only once its entry is in the session file",
		async () => {
			const { session: opened, mailbox } = openSession();
			await opened.prompt("seed");
			const sessionId = opened.sessionManager.getSessionId();
			const file = opened.sessionManager.getSessionFile()!;
			// Neither appends nor the manager's repair rewrite can reach the session file.
			fs.chmodSync(file, 0o444);
			fs.chmodSync(path.dirname(file), 0o555);
			let mailId: string;
			try {
				mailId = await poke(sessionId, "DISK_FULL_POKE");
				await pollUntil(mailbox, () =>
					contexts.some(context => requestTexts(context).at(-1)?.includes("DISK_FULL_POKE")),
				);
				await opened.waitForIdle();
				await mailbox.poll();
				expect(isMailDone(sessionId, mailId)).toBe(false);
			} finally {
				fs.chmodSync(path.dirname(file), 0o755);
				fs.chmodSync(file, 0o644);
			}
			await opened.prompt("disk is back").catch(() => {});
			await opened.sessionManager.flush().catch(() => {});
			await pollUntil(mailbox, () => isMailDone(sessionId, mailId));
			expect(await Bun.file(file).text()).toContain(mailId);
		},
	);

	it("reports an ACP client that keeps agent turns off as taking the poke with its next prompt, and starts no turn", async () => {
		const { session: opened, mailbox } = openSession(undefined, { capabilities: {}, deferAgentInitiatedTurns: true });
		await opened.prompt("seed");
		const sessionId = opened.sessionManager.getSessionId();
		contexts.length = 0;
		await pollUntil(mailbox, () => {
			const target = deliveryTarget(sessionId);
			return target.kind === "live" && target.deferred;
		});

		const mailId = await poke(sessionId, "ACP_POKE");
		await pollUntil(mailbox, () => listNewMail(sessionId).length === 0);
		expect(contexts).toHaveLength(0);

		await opened.prompt("client prompt");
		expect(requestTexts(contexts[0]!).some(text => text.includes("ACP_POKE"))).toBe(true);
		await pollUntil(mailbox, () => isMailDone(sessionId, mailId));
	});
});
