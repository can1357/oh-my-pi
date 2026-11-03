import type { Protocol } from "devtools-protocol";
import type { CDPSession, Page } from "puppeteer-core";

/**
 * In a browser the user drives, `print()` stays held this long after a call ends, for a page that prints a moment
 * after the click; after that the page's own Print buttons open Chrome's preview for the user again.
 */
const USER_DRIVEN_RELEASE_MS = 1_500;

/** The longest a tab's setup holds `print()` in a browser the user drives, should omp never finish it. */
const SETUP_HOLD_MS = 60_000;

/** How long `print()` is held: the tab's whole life (nobody else uses the browser) or only around omp's calls. */
export type PrintHoldScope = "tab" | "calls";

/**
 * Wraps `window.print` once per document for one attachment and holds it for `holdMs` from `from` (the page's own
 * epoch ms; default now), or for the document's life when `holdMs` is `null`. A held call reports through `binding`,
 * fires `beforeprint` and `afterprint` as a finished print does, and returns at once; otherwise it calls the `print`
 * it wrapped, which may be another attachment's wrapper. A dialog that opened while held keeps it held `resyncMs`
 * after it returns. Returns the page's time, for the worker to place deadlines in it. Runs in the page, so it stays
 * self-contained.
 */
function holdPrintInPage(
	binding: string,
	holdKey: string,
	holdMs: number | null,
	from: number | undefined,
	resyncMs: number,
): number {
	// The clock as the document started, so a page that fakes or replaces `Date.now` cannot move a hold.
	const clockKey = Symbol.for("omp.printHold.clock");
	if (typeof Reflect.get(globalThis, clockKey) !== "function") Reflect.set(globalThis, clockKey, Date.now);
	const now = (): number => {
		const clock: unknown = Reflect.get(globalThis, clockKey);
		return Number(typeof clock === "function" ? Reflect.apply(clock, Date, []) : Date.now());
	};
	const deadline = Symbol.for(`${holdKey}.until`);
	const wrapped = Symbol.for(`${holdKey}.wrapped`);
	Reflect.set(globalThis, deadline, holdMs === null ? Number.POSITIVE_INFINITY : (from ?? now()) + holdMs);
	if (Reflect.get(globalThis, wrapped)) return now();
	const print: unknown = Reflect.get(globalThis, "print");
	if (typeof print !== "function") return now();
	Reflect.set(globalThis, wrapped, true);
	// A document back from the back/forward cache kept the deadline it left with, though a call may be running now
	// or omp may have gone: it holds `resyncMs` from the restore, until omp sets the current deadline. One that went
	// into the cache before omp attached has no wrapper, and its own `pageshow` runs before omp's update reaches it.
	Reflect.apply(EventTarget.prototype.addEventListener, globalThis, [
		"pageshow",
		(event: Event) => {
			if (Reflect.get(event, "persisted") === true) Reflect.set(globalThis, deadline, now() + resyncMs);
		},
		true,
	]);
	// A proxy keeps the native function's name and length, and its source still reads `[native code]`.
	const heldPrint = new Proxy(print, {
		apply(target, thisArg, args) {
			const heldUntil: unknown = Reflect.get(globalThis, deadline);
			if (typeof heldUntil !== "number" || now() >= heldUntil) return Reflect.apply(target, thisArg, args);
			const report: unknown = Reflect.get(globalThis, binding);
			if (typeof report === "function") report("");
			Reflect.apply(EventTarget.prototype.dispatchEvent, globalThis, [new Event("beforeprint")]);
			Reflect.apply(EventTarget.prototype.dispatchEvent, globalThis, [new Event("afterprint")]);
		},
	});
	Reflect.set(globalThis, "print", heldPrint);
	// A dialog the page opens while `print()` is held returns into code that may print at once (`if (confirm(…))
	// print()`), before omp can set a deadline in a page the dialog stopped: that print is held for `resyncMs` too.
	// One that opened while released stays so: Chrome runs no command in a page a dialog stopped, and the page runs on
	// from the answer before any command queued behind it.
	for (const name of ["alert", "confirm", "prompt"]) {
		const dialog: unknown = Reflect.get(globalThis, name);
		if (typeof dialog !== "function") continue;
		const heldDialog = new Proxy(dialog, {
			apply(target, thisArg, args) {
				const heldUntil: unknown = Reflect.get(globalThis, deadline);
				const held = typeof heldUntil === "number" && now() < heldUntil;
				try {
					return Reflect.apply(target, thisArg, args);
				} finally {
					const until: unknown = Reflect.get(globalThis, deadline);
					if (held) Reflect.set(globalThis, deadline, Math.max(Number(until), now() + resyncMs));
				}
			},
		});
		Reflect.set(globalThis, name, heldDialog);
	}
	return now();
}

/** A window the tab opened, or one such a window opened, held on the tab's deadline through its own session. */
interface Popup {
	readonly session: CDPSession;
	readonly targetId: string;
	/** The script carrying the window's current deadline, once Chrome has it. */
	script: Promise<string | undefined>;
}

/**
 * Holds the page's `window.print()`. Chrome's print preview blocks the page's script until someone closes it, so a
 * click on a Print button timed out the call, wedged the calls after it, and raised the preview window over the
 * user's screen; held, the page goes on as after a finished print and the call's output says what happened.
 * Only the tab's own renderer is touched: cross-site iframes run in other processes and print as before, so a stuck
 * one never holds up a call. The page itself keeps the deadline on its own clock, so a hold ends on time even if
 * omp goes away. Each attachment keeps its own wrapper and deadline, so `print()` is held while any of them holds it.
 * A window the page opens is held on the same deadline: omp attaches it from the browser before its first document
 * runs, except in the relay, whose debugger reaches only the tab it was attached to.
 */
export class PrintHold {
	readonly #page: Page;
	readonly #session: CDPSession;
	readonly #scope: PrintHoldScope;
	readonly #binding: string;
	readonly #holdKey: string;
	#scriptId: string | undefined;
	/** The wrapper the page's own session puts into every new document ahead of the tab's other scripts. */
	#bootstrapId: string | undefined;
	/** When the hold ends on the worker's clock; `null` holds for the documents' life. */
	#until: number | null = 0;
	/** The page's clock minus the worker's, as last measured: places a new document's deadline in the page's time. */
	#clockOffset = 0;
	#requests = 0;
	/** Hold changes apply in order, so a call's end never lands before its start. */
	#applying: Promise<void> = Promise.resolve();
	/**
	 * Set while the page shows a JavaScript dialog. Its renderer then answers no command (scripts, bindings, evaluation)
	 * until someone answers the dialog, so no hold change waits on it.
	 */
	#dialogOpen = false;
	/** Stops the waits for hold changes in flight when a dialog opens. */
	readonly #onStop = new Set<() => void>();
	/** A hold change the page has not had yet; made once the dialog closes. */
	#stale = false;
	/** The browser session new windows attach to, paused until omp lets them run; unset where omp reaches only the tab. */
	#windows: CDPSession | undefined;
	/** The tab's target and the windows held with it: a window any of them opens is held too. */
	readonly #openers = new Set<string>();
	/** The windows held with the tab, by their session. */
	readonly #popups = new Map<string, Popup>();
	#disposed = false;

	private constructor(page: Page, session: CDPSession, scope: PrintHoldScope) {
		this.#page = page;
		this.#session = session;
		this.#scope = scope;
		const id = crypto.randomUUID().replaceAll("-", "");
		// The binding Chrome adds to every document the tab's own renderer loads; a held `print()` reports through it.
		this.#binding = `__ompPrintRequested_${id}`;
		this.#holdKey = `omp.printHold.${id}`;
		session.on("Runtime.bindingCalled", this.#onBindingCalled);
		session.on("Page.frameNavigated", this.#onFrameNavigated);
		session.on("Page.javascriptDialogOpening", this.#onDialogOpening);
		session.on("Page.javascriptDialogClosed", this.#onDialogClosed);
	}

	/**
	 * Installs the hold. In a browser the user drives it holds through the tab's setup, since a page can print before
	 * omp's first call, until `endCall()`; install it before any other script the tab adds to new documents.
	 */
	static async install(page: Page, scope: PrintHoldScope): Promise<PrintHold> {
		const session = await page.createCDPSession();
		const printHold = new PrintHold(page, session, scope);
		try {
			await session.send("Page.enable");
			await session.send("Runtime.enable");
			await session.send("Runtime.addBinding", { name: printHold.#binding });
			// Chrome runs the scripts of the page's own session before any other session's, each session's in the order
			// they were added: one added there first wraps `print()` before the tab's init scripts can keep the native
			// one. It never changes, so it stays first; it holds a new document briefly until this session's script,
			// which carries the current deadline and runs before the page's own scripts, sets it.
			const bootstrapHoldMs = scope === "tab" ? null : USER_DRIVEN_RELEASE_MS;
			const { identifier } = await page.mainFrame().client.send("Page.addScriptToEvaluateOnNewDocument", {
				source: printHold.#source(bootstrapHoldMs, null),
			});
			printHold.#bootstrapId = identifier;
			await printHold.#attachWindows();
			await printHold.#apply(scope === "tab" ? null : Date.now() + SETUP_HOLD_MS);
		} catch (error) {
			await printHold.dispose().catch(() => undefined);
			throw error;
		}
		return printHold;
	}

	/** Holds `print()` for a call that may run `timeoutMs`, plus the release tail. */
	async beginCall(timeoutMs: number): Promise<void> {
		if (this.#scope === "tab") return;
		await this.#apply(Date.now() + timeoutMs + USER_DRIVEN_RELEASE_MS);
	}

	/**
	 * A browser the user drives gets its page's `print()` back shortly after the call, or after the tab's setup.
	 * Resolves once the page has the release, or once a dialog stops the page.
	 */
	endCall(): Promise<void> {
		if (this.#scope === "tab") return Promise.resolve();
		return this.#apply(Date.now() + USER_DRIVEN_RELEASE_MS).catch(() => undefined);
	}

	/** The line for the call's output when the page called `print()` since the last notice. */
	takeNotice(): string | undefined {
		if (this.#requests === 0) return undefined;
		this.#requests = 0;
		return "The page called window.print(). omp held it, so no print dialog opened and the page went on as after a finished print. Use tab.pdf() for what it would print.";
	}

	/** Takes the hold off the page and detaches. A page stopped in a dialog is left with the deadline it has. */
	async dispose(): Promise<void> {
		this.#disposed = true;
		this.#session.off("Page.frameNavigated", this.#onFrameNavigated);
		this.#session.off("Page.javascriptDialogClosed", this.#onDialogClosed);
		this.#releaseWindows();
		// Detaching works on a stopped page and drops the session's script and binding with it. The deadline left in
		// loaded documents runs out on its own after a call; omp's own browser holds `print()` for good anyway.
		await this.#unlessStopped(this.#release().catch(() => undefined));
		this.#session.off("Runtime.bindingCalled", this.#onBindingCalled);
		this.#session.off("Page.javascriptDialogOpening", this.#onDialogOpening);
		await this.#session.detach();
	}

	/**
	 * Attaches, from the browser, every window the tab opens before it runs: by `open()` or by a link or form with a
	 * target, with or without an opener. Chrome keeps a new window paused until omp lets it go, and the tab with it when
	 * they share a renderer, so the hold is in the window before its first document runs. Where omp reaches no browser
	 * target (the relay's debugger reaches only the tab it was attached to), a window the tab opens prints as before.
	 */
	async #attachWindows(): Promise<void> {
		let windows: CDPSession;
		try {
			windows = await this.#page.browser().target().createCDPSession();
		} catch {
			return;
		}
		this.#windows = windows;
		try {
			const { targetInfo } = await this.#session.send("Target.getTargetInfo");
			this.#openers.add(targetInfo.targetId);
			windows.on("Target.attachedToTarget", this.#onAttached);
			windows.on("Target.detachedFromTarget", this.#onDetached);
			await windows.send("Target.setAutoAttach", {
				autoAttach: true,
				waitForDebuggerOnStart: true,
				flatten: true,
				filter: [{ type: "page", exclude: false }],
			});
		} catch {
			this.#windows = undefined;
			await windows.detach().catch(() => undefined);
		}
	}

	/**
	 * Releases the windows the tab opened, then lets go of them. A window stopped in a dialog takes the release once the
	 * dialog closes; omp detaches only after that, since detaching drops the commands the window has not run yet.
	 */
	#releaseWindows(): void {
		const windows = this.#windows;
		if (!windows) return;
		const popups = [...this.#popups.values()];
		this.#popups.clear();
		for (const popup of popups) this.#updatePopup(popup, 0);
		void Promise.allSettled(popups.map(popup => popup.script))
			.then(() => windows.detach())
			.catch(() => undefined);
	}

	async #release(): Promise<void> {
		// The page's own session stays, so its script goes first; a stopped page gets the removal once it runs again.
		const bootstrapId = this.#bootstrapId;
		this.#bootstrapId = undefined;
		if (bootstrapId) {
			await this.#page
				.mainFrame()
				.client.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: bootstrapId });
		}
		await this.#applying;
		if (this.#scriptId) {
			await this.#session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: this.#scriptId });
		}
		this.#scriptId = undefined;
		// The wrapper stays in loaded documents; released, it passes `print()` on as before.
		this.#until = 0;
		await this.#setInFrames();
		await this.#session.send("Runtime.removeBinding", { name: this.#binding });
	}

	readonly #onBindingCalled = (event: Protocol.Runtime.BindingCalledEvent): void => {
		if (event.name === this.#binding) this.#requests++;
	};

	/** Sets the current deadline in a document back from the back/forward cache, or one that predates the hold. */
	readonly #onFrameNavigated = (event: Protocol.Page.FrameNavigatedEvent): void => {
		if (event.type === "BackForwardCacheRestore") void this.#setInFrames();
	};

	/** A target the browser attached, paused before it runs: held if the tab or a window held with it opened it. */
	readonly #onAttached = (event: Protocol.Target.AttachedToTargetEvent): void => {
		const windows = this.#windows;
		const session = windows?.connection()?.session(event.sessionId);
		if (!windows || !session) return;
		const { openerId, targetId } = event.targetInfo;
		if (this.#disposed || openerId === undefined || !this.#openers.has(openerId)) {
			void session.send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
			void windows.send("Target.detachFromTarget", { sessionId: event.sessionId }).catch(() => undefined);
			return;
		}
		const popup: Popup = { session, targetId, script: Promise.resolve(undefined) };
		this.#popups.set(event.sessionId, popup);
		this.#openers.add(targetId);
		session.on("Runtime.bindingCalled", this.#onBindingCalled);
		session.on("Page.frameNavigated", (navigated: Protocol.Page.FrameNavigatedEvent) => {
			if (navigated.type === "BackForwardCacheRestore") this.#updatePopup(popup, this.#remaining());
		});
		// Sent in this order before the window runs, these reach its first document. Without `Page.enable` first, a
		// window that starts in a renderer of its own loads that document without the script; without
		// `Runtime.enable`, a held print's report never arrives.
		void session.send("Page.enable").catch(() => undefined);
		void session.send("Runtime.enable").catch(() => undefined);
		void session.send("Runtime.addBinding", { name: this.#binding }).catch(() => undefined);
		this.#updatePopup(popup, this.#remaining());
		void session.send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
	};

	readonly #onDetached = (event: Protocol.Target.DetachedFromTargetEvent): void => {
		const popup = this.#popups.get(event.sessionId);
		if (!popup) return;
		this.#popups.delete(event.sessionId);
		this.#openers.delete(popup.targetId);
	};

	/**
	 * Puts a deadline `remaining` ms from now in a window held with the tab, for its loaded documents and new ones.
	 * Nothing waits on it: a window stopped in a dialog runs the commands once the dialog closes, in the order sent.
	 */
	#updatePopup(popup: Popup, remaining: number | null): void {
		const previous = popup.script;
		popup.script = popup.session
			.send("Page.addScriptToEvaluateOnNewDocument", {
				source: this.#source(remaining, Date.now() + this.#clockOffset),
				runImmediately: true,
			})
			.then(
				result => result.identifier,
				() => undefined,
			);
		void previous.then(identifier => {
			if (!identifier) return;
			return popup.session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => undefined);
		});
	}

	/** The page-side hold, `remaining` ms from `from` on the page's clock (default: as it runs), or for good on `null`. */
	#source(remaining: number | null, from: number | null): string {
		const args = [this.#binding, this.#holdKey, remaining, from, USER_DRIVEN_RELEASE_MS];
		return `(${holdPrintInPage})(${args.map(arg => JSON.stringify(arg)).join(", ")});`;
	}

	readonly #onDialogOpening = (): void => {
		this.#dialogOpen = true;
		for (const stop of this.#onStop) stop();
	};

	readonly #onDialogClosed = (): void => {
		this.#dialogOpen = false;
		if (this.#stale) void this.#apply(this.#until).catch(() => undefined);
	};

	/** Waits for a change to reach the page, unless a dialog stops it first; the page then gets it once that closes. */
	async #unlessStopped(change: Promise<void>): Promise<void> {
		if (this.#dialogOpen) {
			this.#stale = true;
			return;
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		const stop = (): void => {
			this.#stale = true;
			resolve();
		};
		this.#onStop.add(stop);
		try {
			await Promise.race([change, promise]);
		} finally {
			this.#onStop.delete(stop);
		}
	}

	/** What is left of the hold, a duration that means the same on the worker's and the page's clocks. */
	#remaining(): number | null {
		return this.#until === null ? null : Math.max(0, this.#until - Date.now());
	}

	/**
	 * Sets the hold's deadline for new documents and loaded ones. Resolves once the page has it, or once a dialog stops
	 * the page; the page then gets the latest deadline when the dialog closes.
	 */
	#apply(until: number | null): Promise<void> {
		this.#until = until;
		// A window the tab opened takes the deadline whatever the tab is doing.
		const remaining = this.#remaining();
		for (const popup of this.#popups.values()) this.#updatePopup(popup, remaining);
		if (this.#dialogOpen) {
			this.#stale = true;
			return Promise.resolve();
		}
		this.#stale = false;
		const applied = this.#applying.then(async () => {
			const previous = this.#scriptId;
			const { identifier } = await this.#session.send("Page.addScriptToEvaluateOnNewDocument", {
				source: this.#source(this.#remaining(), Date.now() + this.#clockOffset),
			});
			this.#scriptId = identifier;
			if (previous) await this.#session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: previous });
			await this.#setInFrames();
		});
		this.#applying = applied.catch(() => undefined);
		return this.#unlessStopped(applied);
	}

	/** Updates the documents already loaded in the tab's own renderer: the main frame and its same-site iframes. */
	async #setInFrames(): Promise<void> {
		const mainFrame = this.#page.mainFrame();
		const remaining = this.#remaining();
		await Promise.all(
			this.#page
				.frames()
				.filter(frame => frame.client === mainFrame.client)
				.map(async frame => {
					try {
						const pageNow = await frame
							.mainRealm()
							.evaluate(
								holdPrintInPage,
								this.#binding,
								this.#holdKey,
								remaining,
								undefined,
								USER_DRIVEN_RELEASE_MS,
							);
						if (frame === mainFrame) this.#clockOffset = pageNow - Date.now();
					} catch {}
				}),
		);
	}
}
