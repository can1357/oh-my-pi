/**
 * Session switches can be requested while an earlier one is still pending (for example while its
 * owner is asked whether to change directory). A switch that is refused restores the session it
 * started from. Overlapping switches must still leave the session in a state one of them chose,
 * and a message sent to a session must reach that session's transcript only, once, if it is the
 * session left live, and must never hang the process.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { TempDir } from "@oh-my-pi/pi-utils";

const BODY = "which files do you own?";
/** A 1x1 PNG, so a message carries an image whose normalization a test can hold. */
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** The text the model is sent for `message`. */
function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

describe("overlapping session switches", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-overlapping-switches-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		for (const created of sessions.splice(0)) await created.dispose();
		authStorage.close();
		tempDir.removeSync();
		AsyncJobManager.resetForTests();
	});

	function createSession(): AgentSession {
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			handler: () => ({ content: ["noted"] }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.create(
				tempDir.path(),
				path.join(tempDir.path(), `sessions-${sessions.length}`),
			),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map(),
		});
		sessions.push(created);
		return created;
	}

	interface RefusedSwitch {
		/** Lets the owner refuse the switch, now or as soon as the switch asks. */
		refuse(): void;
		/** The switch's outcome. */
		done: Promise<boolean>;
	}

	/** Starts a switch to a session in another directory and holds it until its owner refuses the move. */
	async function startRefusedSwitch(target: AgentSession, name: string): Promise<RefusedSwitch> {
		const targetCwd = path.join(tempDir.path(), `${name}-cwd`);
		await fs.mkdir(targetCwd, { recursive: true });
		const manager = SessionManager.create(targetCwd, path.join(tempDir.path(), `${name}-sessions`));
		manager.appendMessage({ role: "user", content: `${name} session`, timestamp: Date.now() });
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		await manager.close();
		if (!file) throw new Error("Expected target session file");
		const asked = Promise.withResolvers<void>();
		const refused = Promise.withResolvers<void>();
		const switching = target.switchSession(file, {
			onCwdChange: async () => {
				asked.resolve();
				await refused.promise;
				return false;
			},
		});
		// A switch queued behind another one has not asked yet; it asks once it runs.
		await Promise.race([asked.promise, Bun.sleep(200)]);
		return { refuse: () => refused.resolve(), done: switching };
	}

	/** Sends an aside whose image normalization is held, so it is still being admitted while switches start. */
	function sendHeldAside(target: AgentSession) {
		const normalizing = Promise.withResolvers<void>();
		const normalized = Promise.withResolvers<void>();
		spyOn(imageLoading, "normalizeModelContextImages").mockImplementationOnce(async images => {
			normalizing.resolve();
			await normalized.promise;
			return images;
		});
		let settled = false;
		const delivery = target
			.sendCustomMessage(
				{
					customType: "test-plugin",
					content: [
						{ type: "text", text: BODY },
						{ type: "image", data: PIXEL_PNG, mimeType: "image/png" },
					],
					display: false,
				},
				{ deliverAs: "aside" },
			)
			.finally(() => {
				settled = true;
			});
		return {
			delivery,
			normalizing: normalizing.promise,
			release: () => normalized.resolve(),
			settled: () => settled,
		};
	}

	it.each([
		{ order: [0, 1], label: "01" },
		{ order: [1, 0], label: "10" },
	])(
		"delivers an aside sent before two overlapping refused switches into its own session, once (refusals $label)",
		async ({ order }) => {
			const target = createSession();
			const originalSessionId = target.sessionManager.getSessionId();
			const aside = sendHeldAside(target);
			const switches: RefusedSwitch[] = [];
			try {
				await aside.normalizing;
				switches.push(await startRefusedSwitch(target, "first"));
				switches.push(await startRefusedSwitch(target, "second"));
				// The owner refuses in this order; a switch queued behind another asks only once that one ends.
				for (const index of order) switches[index]!.refuse();
				expect(await Promise.all(switches.map(pending => pending.done))).toEqual([false, false]);
				aside.release();
				// The aside's admission must finish; it ran into a spin on the session generation instead.
				await Promise.race([aside.delivery, Bun.sleep(5_000)]);
				expect(aside.settled()).toBe(true);
				await target.waitForIdle();
				// An idle aside joins the next turn: run one so the transcript shows where it went.
				await target.prompt("go on");
				await target.waitForIdle();

				// Both switches were refused: the original session is the live one, and it holds the aside once.
				expect(target.sessionManager.getSessionId()).toBe(originalSessionId);
				expect(target.messages.filter(message => messageText(message).includes(BODY))).toHaveLength(1);
			} finally {
				aside.release();
				for (const pending of switches) pending.refuse();
				await Promise.allSettled(switches.map(pending => pending.done));
			}
		},
		30_000,
	);

	it.each([
		{ order: [0, 1, 2], label: "012" },
		{ order: [0, 2, 1], label: "021" },
		{ order: [1, 0, 2], label: "102" },
		{ order: [1, 2, 0], label: "120" },
		{ order: [2, 0, 1], label: "201" },
		{ order: [2, 1, 0], label: "210" },
	])(
		"leaves the original session live with the aside once after three refused switches (refusals $label)",
		async ({ order }) => {
			const target = createSession();
			const originalSessionId = target.sessionManager.getSessionId();
			const aside = sendHeldAside(target);
			const switches: RefusedSwitch[] = [];
			try {
				await aside.normalizing;
				for (const name of ["outer", "middle", "inner"]) switches.push(await startRefusedSwitch(target, name));
				for (const index of order) switches[index]!.refuse();
				expect(await Promise.all(switches.map(pending => pending.done))).toEqual([false, false, false]);
				aside.release();
				await Promise.race([aside.delivery, Bun.sleep(5_000)]);
				expect(aside.settled()).toBe(true);
				await target.waitForIdle();

				await target.prompt("go on");
				await target.waitForIdle();
				expect(target.sessionManager.getSessionId()).toBe(originalSessionId);
				expect(target.messages.filter(message => messageText(message).includes(BODY))).toHaveLength(1);
			} finally {
				aside.release();
				for (const pending of switches) pending.refuse();
				await Promise.allSettled(switches.map(pending => pending.done));
			}
		},
		30_000,
	);

	it("keeps a new session started while a switch is pending when that switch is refused", async () => {
		const target = createSession();
		const originalSessionId = target.sessionManager.getSessionId();
		let pending: RefusedSwitch | undefined;
		let starting: Promise<boolean> | undefined;
		try {
			pending = await startRefusedSwitch(target, "other");
			starting = target.newSession();
			await Bun.sleep(200);
			pending.refuse();
			expect(await pending.done).toBe(false);
			expect(await starting).toBe(true);
			await target.waitForSessionTransition();

			// The new session was asked for after the switch: the switch's refusal must not undo it.
			expect(target.sessionManager.getSessionId()).not.toBe(originalSessionId);
			await target.prompt("hello");
			await target.waitForIdle();
			expect(target.messages.some(message => messageText(message).includes("hello"))).toBe(true);
		} finally {
			pending?.refuse();
			await Promise.allSettled([pending?.done, starting]);
		}
	}, 30_000);

	it("reports a transition as in progress from the moment it is requested until it and the ones queued after it settle", async () => {
		const target = createSession();
		const first = await startRefusedSwitch(target, "first");
		let second: RefusedSwitch | undefined;
		try {
			// A new session requested now is in progress at once, though it waits for the switch.
			second = await startRefusedSwitch(target, "second");
			expect(target.isSessionTransitioning).toBe(true);
			let waitFinished = false;
			const waiting = target.waitForSessionTransition().then(() => {
				waitFinished = true;
			});
			first.refuse();
			expect(await first.done).toBe(false);
			// The second switch now runs and waits for its owner: the wait must still be pending.
			await Bun.sleep(300);
			expect(waitFinished).toBe(false);
			expect(target.isSessionTransitioning).toBe(true);
			second.refuse();
			expect(await second.done).toBe(false);
			await waiting;
			expect(target.isSessionTransitioning).toBe(false);
		} finally {
			first.refuse();
			second?.refuse();
			await Promise.allSettled([first.done, second?.done]);
		}
	}, 30_000);

	it("runs a transition that calls back into its session through another session's transition", async () => {
		const outer = createSession();
		const other = createSession();
		const breakCycle = Promise.withResolvers<void>();
		let resetFinished = false;
		outer.setSessionSwitchReconciler(async () => {
			await other.newSession();
		});
		other.setSessionSwitchReconciler(async () => {
			// The other session's transition resets the outer session's context, from inside both transitions.
			await Promise.race([
				outer.resetSessionContext().then(() => {
					resetFinished = true;
				}),
				breakCycle.promise,
			]);
		});
		const targetCwd = path.join(tempDir.path(), "ancestor-cwd");
		await fs.mkdir(targetCwd, { recursive: true });
		const manager = SessionManager.create(targetCwd, path.join(tempDir.path(), "ancestor-sessions"));
		manager.appendMessage({ role: "user", content: "ancestor session", timestamp: Date.now() });
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		await manager.close();
		if (!file) throw new Error("Expected target session file");
		const switching = outer.switchSession(file, { onCwdChange: async () => true });
		try {
			const finished = await Promise.race([switching.then(() => true), Bun.sleep(10_000).then(() => false)]);
			expect(finished).toBe(true);
			expect(resetFinished).toBe(true);
		} finally {
			breakCycle.resolve();
			await Promise.allSettled([switching]);
		}
	}, 30_000);

	it("keeps a new session requested after a transition whose unawaited nested switch is refused later", async () => {
		const target = createSession();
		let nested: RefusedSwitch | undefined;
		const nestedStarted = Promise.withResolvers<void>();
		let started = false;
		target.setSessionSwitchReconciler(async () => {
			if (started) return;
			started = true;
			// Started from the outer switch and not awaited: it outlives the outer switch's own work.
			nested = await startRefusedSwitch(target, "nested");
			nestedStarted.resolve();
		});
		const outerCwd = target.sessionManager.getCwd();
		const manager = SessionManager.create(outerCwd, path.join(tempDir.path(), "outer-sessions"));
		manager.appendMessage({ role: "user", content: "outer session", timestamp: Date.now() });
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		await manager.close();
		if (!file) throw new Error("Expected target session file");
		let starting: Promise<boolean> | undefined;
		try {
			const outer = target.switchSession(file);
			await nestedStarted.promise;
			expect(await outer).toBe(true);
			// A new session requested now must wait for the nested switch, not run while it is pending.
			let startFinished = false;
			starting = target.newSession().then(value => {
				startFinished = true;
				return value;
			});
			await Bun.sleep(500);
			expect(startFinished).toBe(false);
			nested!.refuse();
			expect(await nested!.done).toBe(false);
			expect(await starting).toBe(true);
			const newSessionId = target.sessionManager.getSessionId();
			await target.waitForSessionTransition();
			expect(target.sessionManager.getSessionId()).toBe(newSessionId);
			expect(target.sessionManager.getSessionFile()).not.toBe(file);
		} finally {
			nested?.refuse();
			await Promise.allSettled([nested?.done, starting]);
		}
	}, 30_000);

	it("leaves the accepted switch's session live when two nested switches it started are refused in turn", async () => {
		const target = createSession();
		const nested: RefusedSwitch[] = [];
		const nestedStarted = Promise.withResolvers<void>();
		let started = false;
		target.setSessionSwitchReconciler(async () => {
			if (started) return;
			started = true;
			// Started from the outer switch and not awaited: two siblings, both pending at once.
			nested.push(await startRefusedSwitch(target, "sibling-b"));
			nested.push(await startRefusedSwitch(target, "sibling-c"));
			nestedStarted.resolve();
		});
		const manager = SessionManager.create(
			target.sessionManager.getCwd(),
			path.join(tempDir.path(), "accepted-sessions"),
		);
		manager.appendMessage({ role: "user", content: "accepted session", timestamp: Date.now() });
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		await manager.close();
		if (!file) throw new Error("Expected target session file");
		try {
			const outer = target.switchSession(file);
			await nestedStarted.promise;
			nested[0]!.refuse();
			expect(await nested[0]!.done).toBe(false);
			nested[1]!.refuse();
			expect(await nested[1]!.done).toBe(false);
			expect(await outer).toBe(true);
			await target.waitForSessionTransition();

			// Both nested switches were refused: the accepted switch's session is live and gets the next message.
			expect(target.sessionManager.getSessionFile()).toBe(file);
			await target.prompt("after the refusals");
			await target.waitForIdle();
			expect(target.messages.some(message => messageText(message).includes("after the refusals"))).toBe(true);
			expect(target.sessionManager.getSessionFile()).toBe(file);
		} finally {
			for (const pending of nested) pending.refuse();
			await Promise.allSettled(nested.map(pending => pending.done));
		}
	}, 30_000);

	it("keeps a later new session waiting for a grandchild switch a nested transition left pending", async () => {
		const target = createSession();
		const cwd = target.sessionManager.getCwd();
		async function sessionFileIn(name: string): Promise<string> {
			const manager = SessionManager.create(cwd, path.join(tempDir.path(), `${name}-sessions`));
			manager.appendMessage({ role: "user", content: `${name} session`, timestamp: Date.now() });
			await manager.ensureOnDisk();
			const file = manager.getSessionFile();
			await manager.close();
			if (!file) throw new Error("Expected target session file");
			return file;
		}
		const outerFile = await sessionFileIn("outer");
		const middleFile = await sessionFileIn("middle");
		let grandchild: RefusedSwitch | undefined;
		let reconciled = 0;
		target.setSessionSwitchReconciler(async () => {
			reconciled++;
			// The outer switch awaits a nested middle switch; the middle one starts a grandchild and does not await it.
			if (reconciled === 1) await target.switchSession(middleFile);
			else if (reconciled === 2) grandchild = await startRefusedSwitch(target, "grandchild");
		});
		let starting: Promise<boolean> | undefined;
		try {
			expect(await target.switchSession(outerFile)).toBe(true);
			if (!grandchild) throw new Error("Expected the grandchild switch to be pending");
			// A new session requested now must wait for the grandchild, not run while it is pending.
			let startFinished = false;
			starting = target.newSession().then(value => {
				startFinished = true;
				return value;
			});
			await Bun.sleep(500);
			expect(startFinished).toBe(false);
			grandchild.refuse();
			expect(await grandchild.done).toBe(false);
			expect(await starting).toBe(true);
			const newSessionFile = target.sessionManager.getSessionFile();
			await target.waitForSessionTransition();

			// The new session stays live and gets the next message.
			expect(target.sessionManager.getSessionFile()).toBe(newSessionFile);
			expect(newSessionFile).not.toBe(middleFile);
			await target.prompt("after the grandchild");
			await target.waitForIdle();
			expect(target.sessionManager.getSessionFile()).toBe(newSessionFile);
			expect(target.messages.some(message => messageText(message).includes("after the grandchild"))).toBe(true);
		} finally {
			grandchild?.refuse();
			await Promise.allSettled([grandchild?.done, starting]);
		}
	}, 30_000);

	it("never runs a transition still queued when its session is disposed", async () => {
		const target = createSession();
		const sessionFile = target.sessionManager.getSessionFile();
		const pending = await startRefusedSwitch(target, "held");
		const starting = target.newSession();
		const disposing = target.dispose();
		pending.refuse();
		await Promise.allSettled([pending.done, disposing]);
		await expect(starting).rejects.toThrow("disposed before this session transition could run");
		expect(target.sessionManager.getSessionFile()).toBe(sessionFile);
	}, 30_000);
});
