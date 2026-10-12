import type { Protocol } from "devtools-protocol";
import type { CDPSession, Page } from "puppeteer-core";

/** CDP binding a held `print()` reports through; Chrome adds it to every document the tab's own renderer loads. */
const PRINT_BINDING = "__ompPrintRequested";
/** `Symbol.for` key of the page flag the wrapper reads: hold `print()` while it is true. */
const HOLD_KEY = "omp.holdPrint";
/**
 * In a browser the user drives, `print()` stays held this long after a call ends, for a page that prints a moment
 * after the click; after that the page's own Print buttons open Chrome's preview for the user again.
 */
const USER_DRIVEN_RELEASE_MS = 1_500;

/** How long `print()` is held: the tab's whole life (nobody else uses the browser) or only around omp's calls. */
export type PrintHoldScope = "tab" | "calls";

/**
 * Wraps `window.print` once per document and sets whether it is held. A held call reports itself, fires
 * `beforeprint` and `afterprint` as a finished print does, and returns at once; otherwise it is the page's own
 * `print()`. Runs in the page, so it stays self-contained.
 */
function holdPrintInPage(binding: string, holdKey: string, held: boolean): void {
	const realm = globalThis as unknown as Record<symbol | string, unknown> & {
		print: () => void;
		Event: new (type: string) => object;
		dispatchEvent(event: object): boolean;
	};
	const hold = Symbol.for(holdKey);
	const wrapped = Symbol.for(`${holdKey}.wrapped`);
	realm[hold] = held;
	if (realm[wrapped]) return;
	realm[wrapped] = true;
	// A proxy keeps the native function's name and length, and its source still reads `[native code]`.
	realm.print = new Proxy(realm.print, {
		apply(print, thisArg, args) {
			if (realm[hold] !== true) return Reflect.apply(print, thisArg, args);
			const report = realm[binding];
			if (typeof report === "function") report("");
			realm.dispatchEvent(new realm.Event("beforeprint"));
			realm.dispatchEvent(new realm.Event("afterprint"));
		},
	});
}

/**
 * Holds the page's `window.print()`. Chrome's print preview blocks the page's script until someone closes it, so a
 * click on a Print button timed out the call, wedged the calls after it, and raised the preview window over the
 * user's screen; held, the page goes on as after a finished print and the call's output says what happened.
 * Only the tab's own renderer is touched: cross-site iframes run in other processes and print as before, so a stuck
 * one never holds up a call.
 */
export class PrintHold {
	readonly #page: Page;
	readonly #session: CDPSession;
	readonly #scope: PrintHoldScope;
	#scriptId: string | undefined;
	#held = false;
	#requests = 0;
	#releaseTimer: NodeJS.Timeout | undefined;
	/** Hold changes apply in order, so a release racing the next call never lands after it. */
	#applying: Promise<void> = Promise.resolve();

	private constructor(page: Page, session: CDPSession, scope: PrintHoldScope) {
		this.#page = page;
		this.#session = session;
		this.#scope = scope;
		session.on("Runtime.bindingCalled", this.#onBindingCalled);
	}

	static async install(page: Page, scope: PrintHoldScope): Promise<PrintHold> {
		const session = await page.createCDPSession();
		const printHold = new PrintHold(page, session, scope);
		await session.send("Page.enable");
		await session.send("Runtime.enable");
		await session.send("Runtime.addBinding", { name: PRINT_BINDING });
		await printHold.#apply(scope === "tab");
		return printHold;
	}

	/** Holds `print()` for the call about to run. */
	async beginCall(): Promise<void> {
		clearTimeout(this.#releaseTimer);
		this.#releaseTimer = undefined;
		if (!this.#held) await this.#apply(true);
	}

	/** A browser the user drives gets its page's `print()` back shortly after the call. */
	endCall(): void {
		if (this.#scope === "tab") return;
		clearTimeout(this.#releaseTimer);
		this.#releaseTimer = setTimeout(() => {
			this.#releaseTimer = undefined;
			void this.#apply(false).catch(() => undefined);
		}, USER_DRIVEN_RELEASE_MS);
	}

	/** The line for the call's output when the page called `print()` since the last notice. */
	takeNotice(): string | undefined {
		if (this.#requests === 0) return undefined;
		this.#requests = 0;
		return "The page called window.print(). omp held it, so no print dialog opened and the page went on as after a finished print. Use tab.pdf() for what it would print.";
	}

	async dispose(): Promise<void> {
		clearTimeout(this.#releaseTimer);
		this.#releaseTimer = undefined;
		await this.#applying;
		if (this.#scriptId) {
			await this.#session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: this.#scriptId });
		}
		this.#scriptId = undefined;
		// The wrapper stays in loaded documents; released, it is the page's own print() again.
		await this.#setInFrames(false);
		await this.#session.send("Runtime.removeBinding", { name: PRINT_BINDING });
		this.#session.off("Runtime.bindingCalled", this.#onBindingCalled);
		await this.#session.detach();
	}

	readonly #onBindingCalled = (event: Protocol.Runtime.BindingCalledEvent): void => {
		if (event.name === PRINT_BINDING) this.#requests++;
	};

	#apply(held: boolean): Promise<void> {
		this.#held = held;
		const applied = this.#applying.then(async () => {
			const previous = this.#scriptId;
			const { identifier } = await this.#session.send("Page.addScriptToEvaluateOnNewDocument", {
				source: `(${holdPrintInPage})(${JSON.stringify(PRINT_BINDING)}, ${JSON.stringify(HOLD_KEY)}, ${held});`,
			});
			this.#scriptId = identifier;
			if (previous) await this.#session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: previous });
			await this.#setInFrames(held);
		});
		this.#applying = applied.catch(() => undefined);
		return applied;
	}

	/** Updates the documents already loaded in the tab's own renderer: the main frame and its same-site iframes. */
	async #setInFrames(held: boolean): Promise<void> {
		const client = this.#page.mainFrame().client;
		await Promise.all(
			this.#page
				.frames()
				.filter(frame => frame.client === client)
				.map(frame =>
					frame
						.mainRealm()
						.evaluate(holdPrintInPage, PRINT_BINDING, HOLD_KEY, held)
						.catch(() => undefined),
				),
		);
	}
}
