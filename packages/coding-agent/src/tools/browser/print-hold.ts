import type { Protocol } from "devtools-protocol";
import type { CDPSession, Page } from "puppeteer-core";

/** CDP binding a held `print()` reports through; Chrome adds it to every document the tab's own renderer loads. */
const PRINT_BINDING = "__ompPrintRequested";
/** `Symbol.for` key of the page value the wrapper reads: hold `print()` until that time (epoch ms). */
const HOLD_KEY = "omp.holdPrintUntil";
/**
 * In a browser the user drives, `print()` stays held this long after a call ends, for a page that prints a moment
 * after the click; after that the page's own Print buttons open Chrome's preview for the user again.
 */
const USER_DRIVEN_RELEASE_MS = 1_500;

/** How long `print()` is held: the tab's whole life (nobody else uses the browser) or only around omp's calls. */
export type PrintHoldScope = "tab" | "calls";

/**
 * Wraps `window.print` once per document and sets until when it is held (`null`: for the document's life). A held
 * call reports itself, fires `beforeprint` and `afterprint` as a finished print does, and returns at once;
 * otherwise it is the page's own `print()`. Runs in the page, so it stays self-contained.
 */
function holdPrintInPage(binding: string, holdKey: string, until: number | null): void {
	const deadline = Symbol.for(holdKey);
	const wrapped = Symbol.for(`${holdKey}.wrapped`);
	Reflect.set(globalThis, deadline, until ?? Number.POSITIVE_INFINITY);
	if (Reflect.get(globalThis, wrapped)) return;
	const print: unknown = Reflect.get(globalThis, "print");
	if (typeof print !== "function") return;
	Reflect.set(globalThis, wrapped, true);
	// A proxy keeps the native function's name and length, and its source still reads `[native code]`.
	const heldPrint = new Proxy(print, {
		apply(target, thisArg, args) {
			const heldUntil: unknown = Reflect.get(globalThis, deadline);
			if (typeof heldUntil !== "number" || Date.now() >= heldUntil) return Reflect.apply(target, thisArg, args);
			const report: unknown = Reflect.get(globalThis, binding);
			if (typeof report === "function") report("");
			Reflect.apply(EventTarget.prototype.dispatchEvent, globalThis, [new Event("beforeprint")]);
			Reflect.apply(EventTarget.prototype.dispatchEvent, globalThis, [new Event("afterprint")]);
		},
	});
	Reflect.set(globalThis, "print", heldPrint);
}

/**
 * Holds the page's `window.print()`. Chrome's print preview blocks the page's script until someone closes it, so a
 * click on a Print button timed out the call, wedged the calls after it, and raised the preview window over the
 * user's screen; held, the page goes on as after a finished print and the call's output says what happened.
 * Only the tab's own renderer is touched: cross-site iframes run in other processes and print as before, so a stuck
 * one never holds up a call. The page itself keeps the deadline, so a hold ends on time even if omp goes away.
 */
export class PrintHold {
	readonly #page: Page;
	readonly #session: CDPSession;
	readonly #scope: PrintHoldScope;
	#scriptId: string | undefined;
	/** The deadline documents in the tab hold `print()` until; `null` holds for their life. */
	#until: number | null = 0;
	#requests = 0;
	/** Hold changes apply in order, so a call's end never lands before its start. */
	#applying: Promise<void> = Promise.resolve();

	private constructor(page: Page, session: CDPSession, scope: PrintHoldScope) {
		this.#page = page;
		this.#session = session;
		this.#scope = scope;
		session.on("Runtime.bindingCalled", this.#onBindingCalled);
		session.on("Page.frameNavigated", this.#onFrameNavigated);
	}

	static async install(page: Page, scope: PrintHoldScope): Promise<PrintHold> {
		const session = await page.createCDPSession();
		const printHold = new PrintHold(page, session, scope);
		await session.send("Page.enable");
		await session.send("Runtime.enable");
		await session.send("Runtime.addBinding", { name: PRINT_BINDING });
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

	async dispose(): Promise<void> {
		await this.#applying;
		this.#session.off("Page.frameNavigated", this.#onFrameNavigated);
		if (this.#scriptId) {
			await this.#session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: this.#scriptId });
		}
		this.#scriptId = undefined;
		// The wrapper stays in loaded documents; released, it is the page's own print() again.
		this.#until = 0;
		await this.#setInFrames(0);
		await this.#session.send("Runtime.removeBinding", { name: PRINT_BINDING });
		this.#session.off("Runtime.bindingCalled", this.#onBindingCalled);
		await this.#session.detach();
	}

	readonly #onBindingCalled = (event: Protocol.Runtime.BindingCalledEvent): void => {
		if (event.name === PRINT_BINDING) this.#requests++;
	};

	/** A document back from the back/forward cache kept the deadline it left with, or predates the hold. */
	readonly #onFrameNavigated = (event: Protocol.Page.FrameNavigatedEvent): void => {
		if (event.type === "BackForwardCacheRestore") void this.#setInFrames(this.#until);
	};

	#apply(until: number | null): Promise<void> {
		this.#until = until;
		const applied = this.#applying.then(async () => {
			const previous = this.#scriptId;
			const { identifier } = await this.#session.send("Page.addScriptToEvaluateOnNewDocument", {
				source: `(${holdPrintInPage})(${JSON.stringify(PRINT_BINDING)}, ${JSON.stringify(HOLD_KEY)}, ${until});`,
			});
			this.#scriptId = identifier;
			if (previous) await this.#session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: previous });
			await this.#setInFrames(until);
		});
		this.#applying = applied.catch(() => undefined);
		return applied;
	}

	/** Updates the documents already loaded in the tab's own renderer: the main frame and its same-site iframes. */
	async #setInFrames(until: number | null): Promise<void> {
		const client = this.#page.mainFrame().client;
		await Promise.all(
			this.#page
				.frames()
				.filter(frame => frame.client === client)
				.map(frame =>
					frame
						.mainRealm()
						.evaluate(holdPrintInPage, PRINT_BINDING, HOLD_KEY, until)
						.catch(() => undefined),
				),
		);
	}
}
