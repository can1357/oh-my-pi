import { useEffect } from "react";

/**
 * Claim Escape for an overlay, on the target that actually works.
 *
 * `document`, not `window`, and that is the whole rule. `preventDefault` only
 * suppresses listeners that run *after* it, and listeners on one target fire in
 * registration order. The turn's abort handler binds on `window` the moment
 * streaming starts — necessarily before any overlay exists — so an overlay that
 * also binds on `window` runs second, and by then the turn is already dead.
 * `document` is strictly earlier than `window` in the bubble path.
 *
 * This has bitten three separate overlays. It used to be guarded by a test that
 * scanned the source for the wrong spelling, which is banned and deserved to be:
 * it broke on refactors and would have passed on a rename. One hook holds the
 * same guarantee by construction — there is a single place that decides, and no
 * overlay can get it wrong on its own.
 *
 * The handler keeps its own policy. Whether to honour `defaultPrevented`, and
 * what to do about the press, differ between a menu, a modal and a picker; only
 * the target and the key filter are shared.
 */
export function useEscape(onEscape: (event: KeyboardEvent) => void): void {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			onEscape(event);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onEscape]);
}
