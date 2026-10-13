import type { Protocol } from "devtools-protocol";
import type { CDPSession, Page } from "puppeteer-core";

/**
 * In a browser the user drives, `print()` stays held this long after a call ends, for a page that prints a moment
 * after the click; after that the page's own Print buttons open Chrome's preview for the user again.
 */
const USER_DRIVEN_RELEASE_MS = 1_500;

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
	// or omp may have gone: it holds `resyncMs` from the restore, until omp sets the current deadline.
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

/**
 * Holds the page's `window.print()`. Chrome's print preview blocks the page's script until someone closes it, so a
 * click on a Print button timed out the call, wedged the calls after it, and raised the preview window over the
 * user's screen; held, the page goes on as after a finished print and the call's output says what happened.
 * Only the tab's own renderer is touched: cross-site iframes run in other processes and print as before, so a stuck
 * one never holds up a call. The page itself keeps the deadline on its own clock, so a hold ends on time even if
 * omp goes away. Each attachment keeps its own wrapper and deadline, so `print()` is held while any of them holds it.
 */
export class PrintHold {
	readonly #page: Page;
	readonly #session: CDPSession;
	readonly #scope: PrintHoldScope;
	readonly #binding: string;
	readonly #holdKey: string;
	#scriptId: string | undefined;
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

	static async install(page: Page, scope: PrintHoldScope): Promise<PrintHold> {
		const session = await page.createCDPSession();
		const printHold = new PrintHold(page, session, scope);
		await session.send("Page.enable");
		await session.send("Runtime.enable");
		await session.send("Runtime.addBinding", { name: printHold.#binding });
		await printHold.#apply(scope === "tab" ? null : 0);
		return printHold;
	}

	/** Holds `print()` for a call that may run `timeoutMs`, plus the release tail. */
	async beginCall(timeoutMs: number): Promise<void> {
		if (this.#scope === "tab") return;
		await this.#apply(Date.now() + timeoutMs + USER_DRIVEN_RELEASE_MS);
	}

	/** A browser the user drives gets its page's `print()` back shortly after the call. */
	endCall(): void {
		if (this.#scope === "tab") return;
		void this.#apply(Date.now() + USER_DRIVEN_RELEASE_MS).catch(() => undefined);
	}

	/** The line for the call's output when the page called `print()` since the last notice. */
	takeNotice(): string | undefined {
		if (this.#requests === 0) return undefined;
		this.#requests = 0;
		return "The page called window.print(). omp held it, so no print dialog opened and the page went on as after a finished print. Use tab.pdf() for what it would print.";
	}

	/** Takes the hold off the page and detaches. A page stopped in a dialog is left with the deadline it has. */
	async dispose(): Promise<void> {
		this.#session.off("Page.frameNavigated", this.#onFrameNavigated);
		this.#session.off("Page.javascriptDialogClosed", this.#onDialogClosed);
		// Detaching works on a stopped page and drops the session's script and binding with it. The deadline left in
		// loaded documents runs out on its own after a call; omp's own browser holds `print()` for good anyway.
		await this.#unlessStopped(this.#release().catch(() => undefined));
		this.#session.off("Runtime.bindingCalled", this.#onBindingCalled);
		this.#session.off("Page.javascriptDialogOpening", this.#onDialogOpening);
		await this.#session.detach();
	}

	async #release(): Promise<void> {
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
		if (this.#dialogOpen) {
			this.#stale = true;
			return Promise.resolve();
		}
		this.#stale = false;
		const applied = this.#applying.then(async () => {
			const previous = this.#scriptId;
			const args = [this.#binding, this.#holdKey, this.#remaining(), Date.now() + this.#clockOffset];
			const { identifier } = await this.#session.send("Page.addScriptToEvaluateOnNewDocument", {
				source: `(${holdPrintInPage})(${args.map(arg => JSON.stringify(arg)).join(", ")}, ${USER_DRIVEN_RELEASE_MS});`,
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
