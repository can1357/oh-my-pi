/**
 * The TUI dialog race over every registered `RemoteDialogHost`: a local dialog
 * races all hosts, the first *answer* wins and aborts the rest, `unavailable`
 * is not an answer, and a host that declines (`null`) is skipped.
 */
import { describe, expect, it } from "bun:test";
import type { CollabUiRequestDraft } from "@oh-my-pi/pi-wire";
import type {
	ExtensionAskDialogQuestion,
	ExtensionUISelectItem,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import {
	type RemoteDialogHost,
	type RemoteDialogResult,
	RemoteDialogHosts,
} from "@oh-my-pi/pi-coding-agent/modes/remote-dialogs";
import type { InteractiveModeContext, InteractiveSelectorDialogOptions } from "@oh-my-pi/pi-coding-agent/modes/types";

/**
 * Scriptable remote surface: `accepts` false models a host with nothing to ask
 * (returns `null`), `answer` set answers every request immediately, and
 * otherwise the request stays pending until `settleAnswer`/`settleUnavailable`
 * (an abort also settles it unavailable, like a real channel teardown).
 */
class FakeDialogHost implements RemoteDialogHost {
	readonly requests: CollabUiRequestDraft[] = [];
	readonly signals: (AbortSignal | undefined)[] = [];
	answer: string | undefined;
	accepts = true;
	readonly #waiters: Array<(result: RemoteDialogResult) => void> = [];

	requestGuestUi(request: CollabUiRequestDraft, signal?: AbortSignal): Promise<RemoteDialogResult> | null {
		if (!this.accepts) return null;
		this.requests.push(request);
		this.signals.push(signal);
		if (this.answer !== undefined) return Promise.resolve({ kind: "answered", value: this.answer });
		const { promise, resolve } = Promise.withResolvers<RemoteDialogResult>();
		this.#waiters.push(resolve);
		signal?.addEventListener("abort", () => resolve({ kind: "unavailable" }), { once: true });
		return promise;
	}

	settleAnswer(value: string | undefined): void {
		this.#waiters.shift()?.({ kind: "answered", value });
	}

	settleUnavailable(): void {
		this.#waiters.shift()?.({ kind: "unavailable" });
	}
}

interface LocalDialogStub {
	signal: AbortSignal | undefined;
	settle(value: string | undefined): void;
}

/** `ExtensionUiController` with the local presentation seam recorded, not mounted. */
class StubDialogController extends ExtensionUiController {
	readonly dialogs: LocalDialogStub[] = [];

	override showHookSelector(
		_title: string,
		_options: ExtensionUISelectItem[],
		dialogOptions?: InteractiveSelectorDialogOptions,
	): Promise<string | undefined> {
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		let settled = false;
		const settle = (value: string | undefined): void => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		// Mirror `#presentDialog`: an abort hides the local dialog as a cancel.
		dialogOptions?.signal?.addEventListener("abort", () => settle(undefined), { once: true });
		this.dialogs.push({ signal: dialogOptions?.signal, settle });
		return promise;
	}
}

function makeHarness(hosts: readonly RemoteDialogHost[] = []): {
	controller: StubDialogController;
	remoteDialogHosts: RemoteDialogHosts;
	/** Children mounted into the local editor slot (the presented local dialog). */
	mounted: unknown[];
} {
	const remoteDialogHosts = new RemoteDialogHosts();
	for (const host of hosts) remoteDialogHosts.add(host);
	const mounted: unknown[] = [];
	const ctx = {
		editor: { getText: () => "", setText: () => {} },
		editorContainer: {
			clear: () => {
				mounted.length = 0;
			},
			addChild: (child: unknown) => {
				mounted.push(child);
			},
		},
		ui: {
			requestRender: () => {},
			setFocus: () => {},
			terminal: { rows: 40, columns: 100 },
			addInputListener: () => () => {},
		},
		remoteDialogHosts,
	} as unknown as InteractiveModeContext;
	return { controller: new StubDialogController(ctx), remoteDialogHosts, mounted };
}

/**
 * Whether a race the test deliberately leaves pending has settled. The ask path
 * (and the selector path) hops through several awaits before an `unavailable`
 * settlement can be observed, so one microtask is not enough to tell "still
 * running" from "already settled" — a regression that treated `unavailable` as
 * a cancel would look pending under `Promise.race` alone.
 */
function settledFlag(promise: Promise<unknown>): () => boolean {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	return () => settled;
}

/**
 * Let every queued microtask and real event-loop turn run, the way the TUI's
 * own loop would (`Bun.sleep(0)` schedules a turn, it does not wait out a
 * duration). Deliberately real: the race's settlement is spread over several
 * `await`s with no promise the test can await instead.
 */
async function drainTurns(): Promise<void> {
	for (let turn = 0; turn < 4; turn += 1) await Bun.sleep(0);
}

describe("remote dialog race", () => {
	it("lets the first remote answer win and aborts the local dialog and the other hosts", async () => {
		const first = new FakeDialogHost();
		const second = new FakeDialogHost();
		const { controller } = makeHarness([first, second]);

		const winner = controller.showRemoteAwareSelector("Deploy?", ["Yes", "No"]);
		const local = controller.dialogs[0];
		if (!local) throw new Error("expected the local dialog to be presented alongside the hosts");
		expect(first.requests[0]?.title).toBe("Deploy?");
		expect(second.requests).toHaveLength(1);

		second.settleAnswer("No");

		expect(await winner).toBe("No");
		expect(local.signal?.aborted).toBe(true);
		expect(first.signals[0]?.aborted).toBe(true);
	});

	it("keeps the race running when one host settles unavailable", async () => {
		const gone = new FakeDialogHost();
		const alive = new FakeDialogHost();
		const { controller } = makeHarness([gone, alive]);

		const winner = controller.showRemoteAwareSelector("Deploy?", ["Yes", "No"]);
		const local = controller.dialogs[0];
		if (!local) throw new Error("expected the local dialog");
		const settled = settledFlag(winner);

		gone.settleUnavailable();
		await drainTurns();
		expect(settled()).toBe(false);
		expect(local.signal?.aborted).toBe(false);

		alive.settleAnswer("Yes");

		expect(await winner).toBe("Yes");
		expect(local.signal?.aborted).toBe(true);
	});

	it("aborts every host when the local dialog answers first", async () => {
		const first = new FakeDialogHost();
		const second = new FakeDialogHost();
		const { controller } = makeHarness([first, second]);

		const winner = controller.showRemoteAwareSelector("Deploy?", ["Yes", "No"]);
		const local = controller.dialogs[0];
		if (!local) throw new Error("expected the local dialog");
		local.settle("Yes");

		expect(await winner).toBe("Yes");
		expect(first.signals[0]?.aborted).toBe(true);
		expect(second.signals[0]?.aborted).toBe(true);
	});

	it("skips a host that cannot take the request and uses the one that can", async () => {
		const busy = new FakeDialogHost();
		busy.accepts = false;
		const available = new FakeDialogHost();
		const { controller } = makeHarness([busy, available]);

		const winner = controller.showRemoteAwareSelector("Deploy?", ["Yes", "No"]);
		const local = controller.dialogs[0];
		if (!local) throw new Error("expected the local dialog");
		expect(busy.requests).toHaveLength(0);

		available.settleAnswer("Yes");

		expect(await winner).toBe("Yes");
		expect(local.signal?.aborted).toBe(true);
	});

	it("returns the local answer when no host is registered", async () => {
		const { controller, remoteDialogHosts } = makeHarness();
		expect(remoteDialogHosts.list()).toHaveLength(0);

		const winner = controller.showRemoteAwareSelector("Deploy?", ["Yes", "No"]);
		const local = controller.dialogs[0];
		if (!local) throw new Error("expected the local dialog");
		local.settle("No");

		expect(await winner).toBe("No");
	});
});

describe("remote dialog race — ask dialogs", () => {
	const questions: ExtensionAskDialogQuestion[] = [
		{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
	];

	it("returns a remote host's answer to an ask dialog", async () => {
		const host = new FakeDialogHost();
		host.answer = "Yes";
		const { controller } = makeHarness([host]);

		const result = await controller.showAskDialog(questions);

		expect(host.requests[0]?.kind).toBe("select");
		expect(result).toMatchObject({
			kind: "submit",
			results: [{ id: "confirm", selectedOptions: ["Yes"], customInput: undefined }],
		});
	});

	it("keeps the local ask running when a host settles unavailable", async () => {
		const gone = new FakeDialogHost();
		const alive = new FakeDialogHost();
		const { controller, mounted } = makeHarness([gone, alive]);

		const pending = controller.showAskDialog(questions);
		const settled = settledFlag(pending);

		gone.settleUnavailable();
		await drainTurns();
		// The settle needs several turns to travel through the guest ask path, so
		// this is where a race that read `unavailable` as a cancel would show up.
		expect(settled()).toBe(false);
		expect(mounted).toHaveLength(1);

		alive.settleAnswer("Yes");

		expect(await pending).toMatchObject({
			kind: "submit",
			results: [{ id: "confirm", selectedOptions: ["Yes"], customInput: undefined }],
		});
	});
});
