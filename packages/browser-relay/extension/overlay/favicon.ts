/**
 * Swaps the tab's icon for the omp mark while a conversation works in it, by rewriting the page's own icon links
 * and putting every one back afterwards. It only touches `<head>` when the working state changes or the page
 * navigates in place, never in response to input.
 */
import { OMP_MARK_PATH } from "./dom";

/** The mark as a data-SVG; hex stops because a favicon renderer may predate `oklch()`. */
const MARK_HREF = `data:image/svg+xml,${encodeURIComponent(
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 9 52 52"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f84fcc"/><stop offset=".5" stop-color="#9362f4"/><stop offset="1" stop-color="#00dbe4"/></linearGradient></defs><path fill="url(#g)" d="${OMP_MARK_PATH}"/></svg>`,
)}`;

/** Single-page apps rewrite their icon links as they navigate; the mark goes back on this long after. */
const REAPPLY_AFTER_MS = 50;

/** The tab icon swap for one document. */
export class Favicon {
	#wanted = false;
	/** The page's CSP refused the data-URL icon; stop trying. */
	#blocked = false;
	/** The page's icon links this swap rewrote, with the `href` each had. */
	#rewritten: [link: HTMLLinkElement, href: string][] = [];
	/** The link this swap added because the page declared no icon. */
	#added: HTMLLinkElement | null = null;
	#reapply: number | undefined;
	readonly #listeners = new AbortController();

	constructor() {
		const { signal } = this.#listeners;
		window.navigation?.addEventListener(
			"navigate",
			() => {
				if (!this.#wanted) return;
				// Hand the page its own links back for the navigation, then take over whatever it leaves.
				this.#restore();
				clearTimeout(this.#reapply);
				this.#reapply = window.setTimeout(() => this.#sync(), REAPPLY_AFTER_MS);
			},
			{ signal },
		);
		document.addEventListener(
			"securitypolicyviolation",
			event => {
				if (!this.#wanted || event.effectiveDirective !== "img-src" || event.blockedURI !== "data") return;
				this.#blocked = true;
				this.#sync();
			},
			{ signal },
		);
	}

	/** Show the omp mark (`true`) or the page's own icon. */
	set(working: boolean): void {
		if (working === this.#wanted) return;
		this.#wanted = working;
		clearTimeout(this.#reapply);
		this.#sync();
	}

	/** Restore the page's icon and stop listening. */
	dispose(): void {
		this.#listeners.abort();
		this.set(false);
	}

	#sync(): void {
		if (this.#wanted && !this.#blocked) this.#apply();
		else this.#restore();
	}

	#apply(): void {
		if (this.#added?.isConnected) return;
		const links = document.querySelectorAll<HTMLLinkElement>('link[rel~="icon" i]');
		for (const link of links) {
			const href = link.getAttribute("href");
			if (href === null || href === MARK_HREF) continue;
			this.#rewritten.push([link, href]);
			link.setAttribute("href", MARK_HREF);
		}
		if (links.length > 0 || !document.head) return;
		// No declared icon: Chrome is showing /favicon.ico (or nothing), which returns when this link is removed.
		this.#added = document.createElement("link");
		this.#added.rel = "icon";
		this.#added.setAttribute("href", MARK_HREF);
		document.head.append(this.#added);
	}

	#restore(): void {
		// A link the page has since pointed elsewhere is the page's again; leave it alone.
		for (const [link, href] of this.#rewritten) {
			if (link.getAttribute("href") === MARK_HREF) link.setAttribute("href", href);
		}
		this.#rewritten = [];
		if (!this.#added) return;
		// Point Chrome back at the default icon before the link goes, so the mark can't linger as the last one seen.
		this.#added.setAttribute("href", new URL("/favicon.ico", location.href).href);
		this.#added.remove();
		this.#added = null;
	}
}
