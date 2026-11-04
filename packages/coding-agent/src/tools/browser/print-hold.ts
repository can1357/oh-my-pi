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
 * epoch ms; default now), or for the document's life when `holdMs` is `null`; with `afterTask`, the `holdMs` start
 * only once the task running now ends. A held call reports through `binding` (the opener's, in a window omp added no
 * binding to), fires `beforeprint` and `afterprint` as a finished print does, and returns at once; otherwise it calls
 * the `print` it wrapped, which may be another attachment's wrapper. A dialog that opened while held keeps it held
 * `resyncMs` after it returns. Returns the page's time, for the worker to place deadlines in it. Runs in the page, so
 * it stays self-contained.
 */
function holdPrintInPage(
	binding: string,
	holdKey: string,
	holdMs: number | null,
	from: number | undefined,
	resyncMs: number,
	afterTask: boolean,
): number {
	// The clock as the document started, so a page that fakes or replaces `Date.now` cannot move a hold. In a document
	// whose own code replaced `Date.now` before omp arrived (fake timers that may never advance), a clock the browser
	// still keeps native stands in: the performance timeline's, or else the time an event is stamped with. Only if the
	// page replaced all of them does the hold go by its clock.
	const isNative = (fn: unknown): boolean => {
		try {
			return /\{\s*\[native code\]\s*\}\s*$/.test(String(Reflect.apply(Function.prototype.toString, fn, [])));
		} catch {
			return false;
		}
	};
	const clockKey = Symbol.for("omp.printHold.clock");
	if (typeof Reflect.get(globalThis, clockKey) !== "function") {
		const getter = (of: unknown, name: string): Function | undefined => {
			const get = Reflect.getOwnPropertyDescriptor(Object(Reflect.get(Object(of), "prototype")), name)?.get;
			return isNative(get) ? get : undefined;
		};
		let clock: Function = Date.now;
		if (!isNative(clock)) {
			const timeline: unknown = Reflect.get(globalThis, "performance");
			const Timeline: unknown = Reflect.get(globalThis, "Performance");
			const onTimeline = typeof Timeline === "function" && timeline instanceof Timeline;
			const origin = onTimeline ? getter(Timeline, "timeOrigin") : undefined;
			const start = origin ? Number(Reflect.apply(origin, timeline, [])) : 0;
			const perfNow: unknown = onTimeline
				? Reflect.get(Object(Reflect.get(Timeline, "prototype")), "now")
				: undefined;
			const stamp = getter(Event, "timeStamp");
			const StampEvent = Event;
			if (typeof perfNow === "function" && isNative(perfNow)) {
				clock = () => start + Number(Reflect.apply(perfNow, timeline, []));
			} else if (stamp && isNative(StampEvent)) {
				clock = () => start + Number(Reflect.apply(stamp, new StampEvent("omp-clock"), []));
			}
		}
		Reflect.set(globalThis, clockKey, clock);
	}
	const now = (): number => {
		const clock: unknown = Reflect.get(globalThis, clockKey);
		return Number(typeof clock === "function" ? Reflect.apply(clock, Date, []) : Date.now());
	};
	const deadline = Symbol.for(`${holdKey}.until`);
	const wrapped = Symbol.for(`${holdKey}.wrapped`);
	const settling = Symbol.for(`${holdKey}.settling`);
	// A timer the page replaced (paused fake timers) may never fire: a message posted to itself runs after the task as
	// well, and only without either does the tail start at once.
	const pageTimer: unknown = Reflect.get(globalThis, "setTimeout");
	const Channel: unknown = Reflect.get(globalThis, "MessageChannel");
	const afterThisTask = (run: () => void): boolean => {
		if (isNative(pageTimer) && typeof pageTimer === "function") {
			Reflect.apply(pageTimer, globalThis, [run, 0]);
			return true;
		}
		if (!isNative(Channel) || typeof Channel !== "function") return false;
		const channel: unknown = Reflect.construct(Channel, []);
		const inbox: unknown = Reflect.get(Object(channel), "port1");
		Reflect.set(Object(inbox), "onmessage", () => {
			Reflect.apply(Reflect.get(Object(inbox), "close"), inbox, []);
			run();
		});
		const outbox: unknown = Reflect.get(Object(channel), "port2");
		Reflect.apply(Reflect.get(Object(outbox), "postMessage"), outbox, [0]);
		return true;
	};
	// Script that runs in one task (the tab's document-start scripts, a restored page's `pageshow` handlers) can outlast
	// any fixed tail, and nothing omp sends reaches the page before it ends: hold until then, and `ms` after, unless omp
	// sets a deadline first.
	const holdPastTask = (ms: number): void => {
		const token = {};
		Reflect.set(globalThis, settling, token);
		Reflect.set(globalThis, deadline, Number.POSITIVE_INFINITY);
		const settle = (): void => {
			if (Reflect.get(globalThis, settling) === token) Reflect.set(globalThis, deadline, now() + ms);
		};
		if (!afterThisTask(settle)) settle();
	};
	if (afterTask && holdMs !== null) {
		holdPastTask(holdMs);
	} else {
		Reflect.deleteProperty(globalThis, settling);
		Reflect.set(globalThis, deadline, holdMs === null ? Number.POSITIVE_INFINITY : (from ?? now()) + holdMs);
	}
	if (Reflect.get(globalThis, wrapped)) return now();
	const print: unknown = Reflect.get(globalThis, "print");
	if (typeof print !== "function") return now();
	Reflect.set(globalThis, wrapped, true);
	// A document back from the back/forward cache kept the deadline it left with, though a call may be running now
	// or omp may have gone: it holds through the restore's own handlers and `resyncMs` after, until omp sets the
	// current deadline. One that went into the cache before omp attached has no wrapper, and its own `pageshow` runs
	// before omp's update reaches it.
	Reflect.apply(EventTarget.prototype.addEventListener, globalThis, [
		"pageshow",
		(event: Event) => {
			if (Reflect.get(event, "persisted") === true) holdPastTask(resyncMs);
		},
		true,
	]);
	// A proxy keeps the native function's name and length, and its source still reads `[native code]`. A held call
	// fires the print events on the window it printed. Once this document is gone to another origin its deadline is
	// out of reach, and a window it opened prints on.
	const holdPrintOf = (view: object, print: Function): Function =>
		new Proxy(print, {
			apply(target, thisArg, args) {
				let held = false;
				try {
					const heldUntil: unknown = Reflect.get(globalThis, deadline);
					held = typeof heldUntil === "number" && now() < heldUntil;
				} catch {}
				if (!held) return Reflect.apply(target, thisArg, args);
				// The report says where the print came from: the tab's top document, a frame in it, or a window the tab
				// opened; `tab.pdf()` prints only the first.
				try {
					const local: unknown = Reflect.get(globalThis, binding);
					// A window omp added no binding to reports through the nearest opener it can reach that has one.
					let report: unknown = local;
					let opener: unknown = globalThis;
					for (let hop = 0; typeof report !== "function" && hop < 8; hop++) {
						opener = Reflect.get(Object(opener), "opener");
						if (!opener) break;
						report = Reflect.get(Object(opener), binding);
					}
					const inTab = view === globalThis && typeof local === "function";
					const where = !inTab ? "window" : Reflect.get(globalThis, "top") === globalThis ? "tab" : "frame";
					if (typeof report === "function") Reflect.apply(report, undefined, [where]);
				} catch {}
				Reflect.apply(EventTarget.prototype.dispatchEvent, view, [new Event("beforeprint")]);
				Reflect.apply(EventTarget.prototype.dispatchEvent, view, [new Event("afterprint")]);
			},
		});
	Reflect.set(globalThis, "print", holdPrintOf(globalThis, print));
	// A page that prints through a window it opens (`open("")`, write, `print()`) calls that window's `print()` as soon
	// as `open()` returns. omp's own hold may not be in the window yet: one sharing this renderer runs on once any
	// debugger client lets it go, and the relay never reaches it. Until then it holds on this document's deadline; the
	// window's own hold, once in, wraps this one.
	const open: unknown = Reflect.get(globalThis, "open");
	if (typeof open === "function") {
		const heldOpen = new Proxy(open, {
			apply(target, thisArg, args) {
				const opened: unknown = Reflect.apply(target, thisArg, args);
				try {
					const openedPrint: unknown = opened === null ? undefined : Reflect.get(Object(opened), "print");
					if (typeof openedPrint === "function") {
						Reflect.set(Object(opened), "print", holdPrintOf(Object(opened), openedPrint));
					}
				} catch {}
				return opened;
			},
		});
		Reflect.set(globalThis, "open", heldOpen);
	}
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
 * In the tab, only its own renderer is touched: cross-site iframes run in other processes and print as before, so a
 * stuck one never holds up a call. The page itself keeps the deadline on its own clock, so a hold ends on time even if
 * omp goes away. Each attachment keeps its own wrapper and deadline, so `print()` is held while any of them holds it.
 * A window the page opens is held on the same deadline through a session omp attaches from the browser before the
 * window runs; the relay's debugger reaches only the tab, so there only a window `open()` hands back is held, on the
 * deadline of the document that opened it.
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
	/** Prints held in frames of the page and in windows the tab opened, which `tab.pdf()` does not reach. */
	#frameRequests = 0;
	#windowRequests = 0;
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
			// The loaded document is armed with the first command, ahead of the setup round trips below, during which
			// its own timers keep running; its frames and the current deadline follow once the setup is in.
			void session
				.send("Runtime.evaluate", {
					expression: printHold.#source(scope === "tab" ? null : SETUP_HOLD_MS, null),
				})
				.catch(() => undefined);
			await session.send("Page.enable");
			await session.send("Runtime.enable");
			await session.send("Runtime.addBinding", { name: printHold.#binding });
			// Chrome runs the scripts of the page's own session before any other session's, each session's in the order
			// they were added: one added there first wraps `print()` before the tab's init scripts can keep the native
			// one. It never changes, so it stays first; it holds a new document until the task running the start scripts
			// ends, then briefly, unless this session's script, which carries the current deadline and runs before the
			// page's own scripts, sets it first.
			const bootstrapHoldMs = scope === "tab" ? null : USER_DRIVEN_RELEASE_MS;
			const { identifier } = await page.mainFrame().client.send("Page.addScriptToEvaluateOnNewDocument", {
				source: printHold.#source(bootstrapHoldMs, null, true),
			});
			printHold.#bootstrapId = identifier;
			// The loaded document is armed at once; attaching windows takes round trips it must not wait on.
			await Promise.all([
				printHold.#apply(scope === "tab" ? null : Date.now() + SETUP_HOLD_MS),
				printHold.#attachWindows(),
			]);
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

	/** The lines for the call's output when the page, a frame in it or a window it opened called `print()` since the last notice. */
	takeNotice(): string | undefined {
		const lines: string[] = [];
		if (this.#requests > 0) {
			lines.push(
				"The page called window.print(). omp held it, so no print dialog opened and the page went on as after a finished print. Use tab.pdf() for what it would print.",
			);
		}
		if (this.#frameRequests > 0) {
			lines.push(
				"A frame in the page called window.print(). omp held it, so no print dialog opened and the frame went on as after a finished print. tab.pdf() prints the page, not the frame.",
			);
		}
		if (this.#windowRequests > 0) {
			lines.push(
				"A window the page opened called window.print(). omp held it, so no print dialog opened and the window went on as after a finished print.",
			);
		}
		this.#requests = 0;
		this.#frameRequests = 0;
		this.#windowRequests = 0;
		return lines.length > 0 ? lines.join("\n") : undefined;
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
	 * target, with or without an opener. A window in a renderer of its own waits until omp lets it go, so the hold is
	 * in its first document; one sharing the tab's renderer runs on once any debugger client lets it go, which the
	 * page-side `open()` wrapper covers. Where omp reaches no browser target (the relay's debugger reaches only the tab
	 * it was attached to), only that wrapper holds a window.
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
			return;
		}
		// A hold disposed while this was in flight, as when arming the page failed, lets go of the windows it attached.
		if (this.#disposed) this.#releaseWindows();
	}

	/**
	 * Releases the windows the tab opened, then lets go of them. A window stopped in a dialog takes the release once the
	 * dialog closes, and omp detaches only after that, since detaching drops the commands a window has not run yet;
	 * should omp's connection close first, the window keeps its last deadline, as the tab's own documents do.
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
		if (event.name !== this.#binding) return;
		if (event.payload === "window") this.#windowRequests++;
		else if (event.payload === "frame") this.#frameRequests++;
		else this.#requests++;
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
			// Letting go here frees only this session's wait: Chrome starts a window in a renderer of its own once every
			// session waiting on it has let it go, so another tab's hold still gets its script in first. A window sharing
			// its opener's renderer runs on at the first resume, which the page-side `open()` wrapper covers.
			void session.send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
			void windows.send("Target.detachFromTarget", { sessionId: event.sessionId }).catch(() => undefined);
			return;
		}
		const popup: Popup = { session, targetId, script: Promise.resolve(undefined) };
		this.#popups.set(event.sessionId, popup);
		this.#openers.add(targetId);
		session.on("Page.frameNavigated", (navigated: Protocol.Page.FrameNavigatedEvent) => {
			if (navigated.type === "BackForwardCacheRestore") this.#updatePopup(popup, this.#remaining());
		});
		// Sent in this order before the window runs, these reach its first document. Without `Page.enable` first, a
		// window that starts in a renderer of its own loads that document without the script. No `Runtime.enable`, the
		// automation tell omp's puppeteer patch keeps off: a held print reports through the opener's binding, when the
		// window can reach its opener.
		void session.send("Page.enable").catch(() => undefined);
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

	/**
	 * The page-side hold, `remaining` ms from `from` on the page's clock (default: as it runs), or for good on `null`;
	 * with `afterTask`, from the end of the task that runs it.
	 */
	#source(remaining: number | null, from: number | null, afterTask = false): string {
		const args = [this.#binding, this.#holdKey, remaining, from, USER_DRIVEN_RELEASE_MS, afterTask];
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
			// Chrome may no longer have the previous script (a relay tab answered `Script not found` between two calls).
			// It numbers a new script one past the highest it holds, so the new one can then carry the previous one's
			// identifier, which must stay; a previous one that is gone needs no removal.
			if (previous && previous !== identifier) {
				await this.#session
					.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: previous })
					.catch(() => undefined);
			}
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
								false,
							);
						if (frame === mainFrame) this.#clockOffset = pageNow - Date.now();
					} catch {}
				}),
		);
	}
}
