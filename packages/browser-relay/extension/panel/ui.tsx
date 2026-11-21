/** Small building blocks every panel surface shares: Esc routing, menus with keyboard handling, sheets, toggles. */
import { Check, ChevronRight, Search } from "lucide-react";
import { createPortal } from "react-dom";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type Ref,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

// ---- Esc routing ----------------------------------------------------------------

/** Open layers, innermost last. Esc closes the top one; with none open it falls through to “stop the turn”. */
const escapeStack: (() => void)[] = [];
/** The app's current fallback; its `current` is null whenever Esc has nothing to stop. */
let escapeFallback: { current: (() => void) | null } | null = null;

function onGlobalKeyDown(event: KeyboardEvent): void {
	if (event.key !== "Escape" || event.isComposing) return;
	const top = escapeStack[escapeStack.length - 1] ?? escapeFallback?.current;
	if (top === null || top === undefined) return;
	event.preventDefault();
	event.stopPropagation();
	top();
}

/** Register `close` as the layer Esc dismisses while `active`. */
export function useEscape(active: boolean, close: () => void): void {
	const latest = useRef(close);
	latest.current = close;
	useEffect(() => {
		if (!active) return;
		const handler = (): void => latest.current();
		escapeStack.push(handler);
		return () => {
			const index = escapeStack.lastIndexOf(handler);
			if (index >= 0) escapeStack.splice(index, 1);
		};
	}, [active]);
}

/** What Esc does when no menu or sheet is open. */
export function useEscapeFallback(handler: (() => void) | null): void {
	const latest = useRef(handler);
	latest.current = handler;
	useEffect(() => {
		escapeFallback = latest;
		window.addEventListener("keydown", onGlobalKeyDown, true);
		return () => {
			escapeFallback = null;
			window.removeEventListener("keydown", onGlobalKeyDown, true);
		};
	}, []);
}

/** Close a popover on a pointer press outside `ref`; its portaled submenus (`.pn-submenu`) count as inside. */
export function useOutsidePress(ref: { current: HTMLElement | null }, active: boolean, close: () => void): void {
	const latest = useRef(close);
	latest.current = close;
	useEffect(() => {
		if (!active) return;
		const onDown = (event: PointerEvent): void => {
			const root = ref.current;
			if (root === null || !(event.target instanceof Element)) return;
			if (!root.contains(event.target) && event.target.closest(".pn-submenu") === null) latest.current();
		};
		document.addEventListener("pointerdown", onDown, true);
		return () => document.removeEventListener("pointerdown", onDown, true);
	}, [active, ref]);
}

// ---- buttons ---------------------------------------------------------------------

/** 28px ghost icon button with a delayed tooltip. */
export function IconButton(props: {
	label: string;
	onClick(): void;
	children: ReactNode;
	active?: boolean;
	disabled?: boolean;
	tip?: "above" | "below" | "none";
	className?: string;
}): ReactNode {
	const tip = props.tip ?? "below";
	return (
		<button
			type="button"
			className={`pn-icon-btn${props.active ? " pn-icon-btn--on" : ""}${props.className ? ` ${props.className}` : ""}`}
			aria-label={props.label}
			data-tip={tip === "none" ? undefined : props.label}
			data-tip-side={tip}
			disabled={props.disabled}
			onClick={props.onClick}
		>
			{props.children}
		</button>
	);
}

/** 36×20 switch with a 16px thumb. */
export function Toggle(props: { checked: boolean; onChange(next: boolean): void; label: string }): ReactNode {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={props.checked}
			aria-label={props.label}
			className={`pn-toggle${props.checked ? " pn-toggle--on" : ""}`}
			onClick={() => props.onChange(!props.checked)}
		>
			<span className="pn-toggle-thumb" />
		</button>
	);
}

// ---- menus -----------------------------------------------------------------------

/** One row, separator or group caption of a {@link Menu}. */
export type MenuEntry =
	| {
			kind: "item";
			id: string;
			label: string;
			icon?: ReactNode;
			/** Mono metadata at the right of the row. */
			meta?: string;
			/** Second line under the label. */
			description?: string;
			checked?: boolean;
			danger?: boolean;
			disabled?: boolean;
			/** Small control at the row's end, shown on hover (the slash menu's edit pencil). */
			trailing?: { label: string; icon: ReactNode; onClick(): void };
			submenu?: MenuEntry[];
			onSelect?(): void;
	  }
	| { kind: "separator"; id: string }
	| { kind: "caption"; id: string; label: string };

/** Lets a text field that keeps focus drive the menu (the slash menu). */
export interface MenuHandle {
	/** True when the key was consumed. */
	handleKey(event: ReactKeyboardEvent | KeyboardEvent): boolean;
}

type MenuItem = Extract<MenuEntry, { kind: "item" }>;

function selectable(entries: readonly MenuEntry[]): MenuItem[] {
	return entries.filter((entry): entry is MenuItem => entry.kind === "item" && entry.disabled !== true);
}

function MenuList(props: {
	entries: readonly MenuEntry[];
	activeId: string | null;
	openSubmenuId: string | null;
	submenuActiveId: string | null;
	dense: boolean;
	onHover(id: string): void;
	onPick(item: MenuItem): void;
	onSubHover(id: string): void;
}): ReactNode {
	// Row elements by entry id, kept from earlier commits: a submenu positions itself in a layout effect that runs
	// before this commit's refs attach, so it needs the element its row already had.
	const rowElements = useRef(new Map<string, HTMLDivElement>());
	return (
		<>
			{props.entries.map(entry => {
				if (entry.kind === "separator") return <div key={entry.id} className="pn-menu-sep" role="separator" />;
				if (entry.kind === "caption")
					return (
						<div key={entry.id} className="pn-menu-caption">
							{entry.label}
						</div>
					);
				const active = entry.id === props.activeId;
				return (
					<div
						key={entry.id}
						className="pn-menu-row-wrap"
						ref={node => {
							if (node !== null) rowElements.current.set(entry.id, node);
						}}
					>
						<div
							role="menuitem"
							tabIndex={-1}
							aria-disabled={entry.disabled}
							data-active={active || undefined}
							ref={node => {
								if (active && node !== null) node.scrollIntoView({ block: "nearest" });
							}}
							className={`pn-menu-row${props.dense ? " pn-menu-row--dense" : ""}${entry.danger ? " pn-menu-row--danger" : ""}`}
							onPointerMove={() => {
								if (!entry.disabled && !active) props.onHover(entry.id);
							}}
							onClick={() => {
								if (!entry.disabled) props.onPick(entry);
							}}
						>
							{entry.icon !== undefined && <span className="pn-menu-icon">{entry.icon}</span>}
							<span className="pn-menu-copy">
								<span className="pn-menu-label">{entry.label}</span>
								{entry.description !== undefined && <span className="pn-menu-desc">{entry.description}</span>}
							</span>
							{entry.meta !== undefined && <span className="pn-menu-meta">{entry.meta}</span>}
							{entry.trailing !== undefined && (
								<button
									type="button"
									className="pn-menu-trailing"
									aria-label={entry.trailing.label}
									onClick={event => {
										event.stopPropagation();
										entry.trailing?.onClick();
									}}
								>
									{entry.trailing.icon}
								</button>
							)}
							{entry.checked && <Check size={14} className="pn-menu-check" />}
							{entry.submenu !== undefined && <ChevronRight size={14} className="pn-menu-chev" />}
						</div>
						{entry.submenu !== undefined && props.openSubmenuId === entry.id && (
							<Submenu
								anchor={rowElements.current.get(entry.id) ?? null}
								entries={entry.submenu}
								activeId={props.submenuActiveId}
								onHover={props.onSubHover}
								onPick={props.onPick}
							/>
						)}
					</div>
				);
			})}
		</>
	);
}

/**
 * Opens 4px to the right of its row, flips left, and in a panel too narrow for either lies over the parent.
 * Portaled to the body: inside the menu, the menu's own enter transform would become the containing block of
 * this fixed-position box and throw its viewport coordinates off.
 */
function Submenu(props: {
	anchor: HTMLDivElement | null;
	entries: readonly MenuEntry[];
	activeId: string | null;
	onHover(id: string): void;
	onPick(item: MenuItem): void;
}): ReactNode {
	const ref = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const node = ref.current;
		const row = props.anchor;
		if (node === null || row === null) return;
		const rowRect = row.getBoundingClientRect();
		const width = node.offsetWidth;
		const height = node.offsetHeight;
		const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
		let left = rowRect.right + 4;
		if (left + width > viewport.width - 8) left = rowRect.left - 4 - width;
		if (left < 8) left = Math.max(8, viewport.width - 8 - width);
		const top = Math.max(8, Math.min(rowRect.top - 4, viewport.height - 8 - height));
		node.style.setProperty("left", `${left}px`);
		node.style.setProperty("top", `${top}px`);
		node.style.setProperty("visibility", "visible");
	}, [props.anchor]);
	return createPortal(
		<div ref={ref} className="pn-menu pn-submenu" role="menu">
			<MenuList
				entries={props.entries}
				activeId={props.activeId}
				openSubmenuId={null}
				submenuActiveId={null}
				dense
				onHover={props.onHover}
				onPick={props.onPick}
				onSubHover={props.onHover}
			/>
		</div>,
		document.body,
	);
}

/**
 * A popover menu. ↑/↓ move without wrapping and skip separators, → opens a submenu, ← closes it, Enter or Tab
 * picks, Esc closes. With `autoFocus` it takes focus and handles its own keys; without, the owner forwards keys
 * through {@link MenuHandle}. With `search` a filter field heads the rows and holds focus; editing it moves the
 * highlight to the first row.
 */
export function Menu(props: {
	entries: readonly MenuEntry[];
	onClose(): void;
	handle?: Ref<MenuHandle>;
	autoFocus?: boolean;
	/** 32px rows instead of 36px. */
	dense?: boolean;
	className?: string;
	width?: number | string;
	/** Shown instead of rows when there are none. */
	empty?: string;
	/** Filter field above the rows; the owner narrows `entries` as `value` changes. */
	search?: { value: string; placeholder: string; onChange(value: string): void };
	/** Below the rows, inside the popover (the model picker's thinking slider). */
	footer?: ReactNode;
	/** The highlighted row changed. */
	onActiveChange?(id: string | null): void;
	/** Owner keys, tried before the menu's own; true when consumed. */
	onKey?(event: ReactKeyboardEvent): boolean;
}): ReactNode {
	const { entries, onClose, search, onActiveChange } = props;
	const rootRef = useRef<HTMLDivElement | null>(null);
	const searchRef = useRef<HTMLInputElement | null>(null);
	const items = selectable(entries);
	const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null);
	const [submenu, setSubmenu] = useState<{ parent: string; activeId: string | null } | null>(null);
	const active = items.find(item => item.id === activeId) ?? items[0] ?? null;

	// The row set changes as the slash query narrows; keep the highlight on a row that still exists.
	useEffect(() => {
		if (active?.id !== activeId) setActiveId(active?.id ?? null);
		if (submenu !== null && !items.some(item => item.id === submenu.parent)) setSubmenu(null);
	}, [active, activeId, items, submenu]);

	const highlighted = active?.id ?? null;
	useEffect(() => {
		onActiveChange?.(highlighted);
	}, [highlighted, onActiveChange]);

	useEscape(true, () => {
		if (submenu !== null) setSubmenu(null);
		else onClose();
	});
	useOutsidePress(rootRef, true, onClose);
	useEffect(() => {
		if (props.autoFocus) (searchRef.current ?? rootRef.current)?.focus();
	}, [props.autoFocus]);

	const pick = (item: MenuItem): void => {
		if (item.submenu !== undefined) {
			setActiveId(item.id);
			setSubmenu({ parent: item.id, activeId: selectable(item.submenu)[0]?.id ?? null });
			return;
		}
		item.onSelect?.();
		onClose();
	};

	const handleKey = (event: ReactKeyboardEvent | KeyboardEvent): boolean => {
		if (event.metaKey || event.ctrlKey || event.altKey) return false;
		const parent = submenu === null ? null : (items.find(item => item.id === submenu.parent) ?? null);
		const list = parent?.submenu !== undefined ? selectable(parent.submenu) : items;
		const currentId = submenu !== null ? submenu.activeId : (active?.id ?? null);
		const index = list.findIndex(item => item.id === currentId);
		const move = (next: number): void => {
			const target = list[Math.max(0, Math.min(list.length - 1, next))];
			if (target === undefined) return;
			if (submenu !== null) setSubmenu({ parent: submenu.parent, activeId: target.id });
			else setActiveId(target.id);
		};
		switch (event.key) {
			case "ArrowDown":
				move(index + 1);
				return true;
			case "ArrowUp":
				move(index - 1);
				return true;
			case "ArrowRight":
				if (submenu === null && active?.submenu !== undefined) {
					pick(active);
					return true;
				}
				return false;
			case "ArrowLeft":
				if (submenu !== null) {
					setSubmenu(null);
					return true;
				}
				return false;
			case "Enter":
			case "Tab": {
				const target = list[index];
				if (target === undefined) return false;
				pick(target);
				return true;
			}
			default:
				return false;
		}
	};
	useImperativeHandle(props.handle, () => ({ handleKey }));

	const rows =
		items.length === 0 && props.empty !== undefined ? (
			<div className="pn-menu-empty">{props.empty}</div>
		) : (
			<MenuList
				entries={entries}
				activeId={submenu === null ? (active?.id ?? null) : submenu.parent}
				openSubmenuId={submenu?.parent ?? null}
				submenuActiveId={submenu?.activeId ?? null}
				dense={props.dense === true}
				onHover={id => {
					setActiveId(id);
					if (submenu !== null && submenu.parent !== id) setSubmenu(null);
				}}
				onPick={pick}
				onSubHover={id => setSubmenu(current => (current === null ? null : { ...current, activeId: id }))}
			/>
		);
	return (
		<div
			ref={rootRef}
			className={`pn-menu${search === undefined ? "" : " pn-menu--search"}${props.className ? ` ${props.className}` : ""}`}
			role="menu"
			tabIndex={-1}
			style={props.width === undefined ? undefined : { width: props.width }}
			onKeyDown={event => {
				if (!props.autoFocus || event.nativeEvent.isComposing) return;
				if (props.onKey?.(event) || handleKey(event)) event.preventDefault();
			}}
		>
			{search === undefined ? (
				rows
			) : (
				<>
					<label className="pn-menu-search">
						<Search size={14} />
						<input
							ref={searchRef}
							value={search.value}
							placeholder={search.placeholder}
							aria-label={search.placeholder}
							spellCheck={false}
							autoComplete="off"
							onChange={event => {
								setActiveId(null);
								search.onChange(event.target.value);
							}}
						/>
					</label>
					<div className="pn-menu-scroll">{rows}</div>
				</>
			)}
			{props.footer}
		</div>
	);
}

// ---- sheets ----------------------------------------------------------------------

/**
 * Bottom sheet over the panel: 20% backdrop, slides up, Esc closes, Enter saves when focus is outside a text
 * field. `full` makes it full-height (Settings).
 */
export function Sheet(props: {
	title: ReactNode;
	onClose(): void;
	/** Enter outside a text field. */
	onSubmit?(): void;
	footer?: ReactNode;
	full?: boolean;
	/** Extra controls at the header's right, before the close button. */
	headerExtra?: ReactNode;
	closeLabel?: string;
	children: ReactNode;
}): ReactNode {
	const { onClose, onSubmit } = props;
	useEscape(true, onClose);
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		// Focus the first field so the sheet is usable from the keyboard right away.
		const first = ref.current?.querySelector<HTMLElement>("[data-autofocus]");
		(first ?? ref.current)?.focus();
	}, []);
	return (
		<div className="pn-sheet-layer">
			<div className="pn-sheet-backdrop" onClick={onClose} />
			<div
				ref={ref}
				className={`pn-sheet${props.full ? " pn-sheet--full" : ""}`}
				role="dialog"
				aria-modal="true"
				tabIndex={-1}
				onKeyDown={event => {
					if (event.key !== "Enter" || onSubmit === undefined || event.nativeEvent.isComposing) return;
					const target = event.target;
					if (
						target instanceof HTMLTextAreaElement ||
						target instanceof HTMLInputElement ||
						target instanceof HTMLSelectElement ||
						target instanceof HTMLButtonElement ||
						(target instanceof HTMLElement && target.isContentEditable)
					)
						return;
					event.preventDefault();
					onSubmit();
				}}
			>
				<div className="pn-sheet-head">
					<div className="pn-sheet-title">{props.title}</div>
					{props.headerExtra}
					<button type="button" className="pn-icon-btn" aria-label={props.closeLabel ?? "Close"} onClick={onClose}>
						<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
							<path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
						</svg>
					</button>
				</div>
				<div className="pn-sheet-body">{props.children}</div>
				{props.footer !== undefined && <div className="pn-sheet-foot">{props.footer}</div>}
			</div>
		</div>
	);
}

/** Favicon with a neutral globe-ish fallback tile when the page has none or it fails to load. */
export function Favicon(props: { src: string | undefined; size: number }): ReactNode {
	const [failed, setFailed] = useState(false);
	useEffect(() => setFailed(false), [props.src]);
	if (props.src === undefined || props.src === "" || failed)
		return <span className="pn-favicon pn-favicon--blank" style={{ width: props.size, height: props.size }} />;
	return (
		<img
			className="pn-favicon"
			src={props.src}
			width={props.size}
			height={props.size}
			alt=""
			onError={() => setFailed(true)}
		/>
	);
}
