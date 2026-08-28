import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type MenuItem, tidy, useContextMenu } from "../shell/contextMenu";
import { useEscape } from "../shell/useEscape";

/** Kept off the window edge by this much when the menu has to be nudged. */
const MARGIN = 8;

/**
 * The one menu. Every surface hands it a list; none of them draw their own.
 *
 * Measured against opencode's `dropdown-menu.css`, which is vendored and not
 * imported: rows carry no frame, the panel carries one, and the ground is the
 * raised surface a dialog sits on. Flattened like everything else — the radius
 * and shadow it declares are exactly what this app removes.
 */
export function ContextMenu() {
	const { request, close } = useContextMenu();
	const ref = useRef<HTMLDivElement | null>(null);
	const [at, setAt] = useState<{ x: number; y: number } | null>(null);
	const [active, setActive] = useState(0);

	// Memoised because both the keyboard effect and the focus effect depend on
	// it: a fresh array per render would re-bind the key listener on every one.
	const items = useMemo(() => (request ? tidy(request.items) : []), [request]);
	const usable = useMemo(
		() =>
			items
				.map((item, index) => ({ item, index }))
				.filter(entry => entry.item.kind === "action" && !entry.item.disabled),
		[items],
	);

	// Open focused on the first thing you could actually pick, so Enter always
	// means something.
	useEffect(() => {
		if (!request) return;
		const first = items.findIndex(item => item.kind === "action" && !item.disabled);
		setActive(first === -1 ? 0 : first);
	}, [request, items]);

	/*
	 * Placed after measuring, not before: a menu opened near the bottom right of
	 * the window would otherwise hang off it, and the height is not knowable
	 * until the rows exist.
	 */
	useLayoutEffect(() => {
		if (!request) return setAt(null);
		const box = ref.current?.getBoundingClientRect();
		if (!box) return;
		const x = Math.max(MARGIN, Math.min(request.x, window.innerWidth - box.width - MARGIN));
		const y = Math.max(MARGIN, Math.min(request.y, window.innerHeight - box.height - MARGIN));
		setAt({ x, y });
	}, [request]);

	const pick = useCallback(
		(item: MenuItem) => {
			if (item.kind !== "action" || item.disabled) return;
			close();
			// After closing: an action that opens a dialog must not race the menu's
			// own teardown for the focus.
			void Promise.resolve().then(item.run);
		},
		[close],
	);

	// Anything that moves the ground under a menu dismisses it: a menu pinned to
	// coordinates is wrong the moment those coordinates mean something else.
	useEffect(() => {
		if (!request) return;
		const dismiss = () => close();
		window.addEventListener("resize", dismiss);
		window.addEventListener("blur", dismiss);
		window.addEventListener("scroll", dismiss, true);
		return () => {
			window.removeEventListener("resize", dismiss);
			window.removeEventListener("blur", dismiss);
			window.removeEventListener("scroll", dismiss, true);
		};
	}, [request, close]);

	useEffect(() => {
		if (!request) return;
		const onKey = (event: KeyboardEvent) => {
			// Escape is not here: it goes through `useEscape` below, with every
			// other overlay's, so the target is decided in one place.
			if (usable.length === 0) return;
			const here = usable.findIndex(entry => entry.index === active);
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				const next = (here + step + usable.length) % usable.length;
				setActive(usable[next].index);
			} else if (event.key === "Home") {
				event.preventDefault();
				setActive(usable[0].index);
			} else if (event.key === "End") {
				event.preventDefault();
				setActive(usable[usable.length - 1].index);
			} else if (event.key === "Enter") {
				event.preventDefault();
				const item = items[active];
				if (item) pick(item);
			}
		};
		// The same target as the Escape hook, for the same reason it gives.
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [request, active, items, usable, pick]);

	useEscape(
		useCallback(
			(event: KeyboardEvent) => {
				if (!request) return;
				// Claim it, or the same press aborts the running turn.
				event.preventDefault();
				close();
			},
			[request, close],
		),
	);

	if (!request) return null;

	return (
		<>
			{/*
			 * A transparent sheet rather than a document listener: it catches the
			 * click that dismisses, and stops that same click reaching whatever was
			 * underneath. Right-clicking through a menu should re-target it, so that
			 * one re-opens instead of closing.
			 */}
			<div
				className="omp-menu__sheet"
				onClick={close}
				onContextMenu={event => {
					/*
					 * Re-target rather than merely dismiss. The sheet covers the window,
					 * so the row you actually right-clicked never sees the event and
					 * `preventDefault` stops the window fallback too — the menu just
					 * closed and you had to click again. Close, then replay the click
					 * at whatever was underneath once the sheet is gone.
					 */
					event.preventDefault();
					const { clientX, clientY } = event;
					close();
					requestAnimationFrame(() => {
						document
							.elementFromPoint(clientX, clientY)
							?.dispatchEvent(
								new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX, clientY }),
							);
					});
				}}
			/>
			<div
				className="omp-menu"
				ref={ref}
				role="menu"
				aria-label="Context menu"
				// The menu is a sibling of the sheet, not a child, so a right-click on
				// one of its own rows reaches the window fallback and swapped this
				// menu for the shell one. Claim it and do nothing.
				onContextMenu={event => event.preventDefault()}
				style={{ left: at?.x ?? request.x, top: at?.y ?? request.y, visibility: at ? "visible" : "hidden" }}
			>
				{items.map((item, index) =>
					item.kind === "separator" ? (
						<div className="omp-menu__separator" key={item.id} role="separator" />
					) : (
						<button
							className="omp-menu__item"
							key={item.id}
							type="button"
							role="menuitem"
							data-active={index === active || undefined}
							data-danger={item.danger || undefined}
							aria-disabled={Boolean(item.disabled)}
							title={item.disabled}
							onMouseEnter={() => !item.disabled && setActive(index)}
							onClick={() => pick(item)}
						>
							<span className="omp-menu__label">{item.label}</span>
							{item.hint ? <span className="omp-menu__hint">{item.hint}</span> : null}
						</button>
					),
				)}
			</div>
		</>
	);
}
