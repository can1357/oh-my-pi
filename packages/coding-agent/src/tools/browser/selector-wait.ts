import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { ElementHandle } from "puppeteer-core";
import { isNavigatedContextError } from "./navigation";
import { untilAbortedOrReleased } from "./op-timeouts";

export interface SelectorWaitOptions {
	timeout?: number;
	state?: "attached" | "detached" | "visible" | "hidden";
	visible?: boolean;
	hidden?: boolean;
}

const FORMS =
	'waitForSelector() accepts { timeout?: non-negative number (0/Infinity use the run budget), state?: "attached" | "detached" | "visible" | "hidden", visible?: boolean, hidden?: boolean }';

/** Validate before starting a wait; never silently discard a misspelled option. */
export function selectorWaitOptions(options: unknown): SelectorWaitOptions {
	if (options === undefined) return {};
	if (!options || typeof options !== "object" || Array.isArray(options)) throw new ToolError(FORMS);
	const unknown = Object.keys(options).filter(key => !["timeout", "state", "visible", "hidden"].includes(key));
	if (unknown.length) throw new ToolError(`waitForSelector(): unknown option(s): ${unknown.join(", ")}. ${FORMS}`);
	const opts = options as SelectorWaitOptions;
	if (
		(opts.timeout !== undefined &&
			(typeof opts.timeout !== "number" || Number.isNaN(opts.timeout) || opts.timeout < 0)) ||
		(opts.state !== undefined && !["attached", "detached", "visible", "hidden"].includes(opts.state)) ||
		(opts.visible !== undefined && typeof opts.visible !== "boolean") ||
		(opts.hidden !== undefined && typeof opts.hidden !== "boolean")
	)
		throw new ToolError(FORMS);
	if (opts.visible && opts.hidden) {
		throw new ToolError(`waitForSelector(): visible and hidden cannot both be true. ${FORMS}`);
	}
	if (opts.state !== undefined) {
		const visible = opts.state === "visible";
		const hidden = opts.state === "hidden";
		if (
			(opts.visible !== undefined && opts.visible !== visible) ||
			(opts.hidden !== undefined && opts.hidden !== hidden)
		) {
			throw new ToolError(`waitForSelector(): state conflicts with visible/hidden. ${FORMS}`);
		}
		return { timeout: opts.timeout, state: opts.state, visible, hidden };
	}
	return opts;
}

/** Puppeteer's hidden wait also accepts a present invisible node; detached must require absence. */
export async function waitForDetached(query: () => Promise<ElementHandle | null>, signal: AbortSignal): Promise<null> {
	await waitForSelectorHandle(query, { state: "detached" }, signal);
	return null;
}

/** Poll a live ref with Puppeteer's own visibility checks, in its owning tab or frame realm. */
export async function waitForSelectorHandle(
	query: () => Promise<ElementHandle | null>,
	options: SelectorWaitOptions,
	signal: AbortSignal,
): Promise<ElementHandle | null> {
	while (true) {
		try {
			const handle = await untilAbortedOrReleased(signal, query(), async late => late?.dispose());
			if (!handle && (options.hidden || options.state === "detached")) return null;
			if (handle) {
				let keep = false;
				try {
					keep =
						options.state !== "detached" &&
						((!options.visible && !options.hidden) ||
							(await untilAborted(signal, () => (options.hidden ? handle.isHidden() : handle.isVisible()))));
					if (keep) return handle;
				} finally {
					if (!keep) await handle.dispose();
				}
			}
		} catch (error) {
			if (signal.aborted || !isNavigatedContextError(error)) throw error;
		}
		await untilAborted(signal, () => Bun.sleep(100));
	}
}
