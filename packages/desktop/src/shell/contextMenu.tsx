import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

export type MenuItem =
	| {
			kind: "action";
			id: string;
			label: string;
			/** Right-aligned, for a shortcut or a hint. Never for the label's meaning. */
			hint?: string;
			/** Sets it apart and moves it below a separator. Deleting, mostly. */
			danger?: boolean;
			/**
			 * The *reason* it cannot be used, not a boolean.
			 *
			 * A greyed row with no explanation is worse than no row: it says "not
			 * now" and refuses to say why. Every disabled entry here has an answer
			 * — "this session is not open" — so the type demands it.
			 */
			disabled?: string;
			run(): void | Promise<void>;
	  }
	| { kind: "separator"; id: string };

export interface MenuRequest {
	x: number;
	y: number;
	items: MenuItem[];
}

interface ContextMenuApi {
	/** Open at the event's cursor. Claims the event, so nothing else acts on it. */
	open(event: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]): void;
	close(): void;
	request: MenuRequest | null;
}

const Ctx = createContext<ContextMenuApi | null>(null);

export function ContextMenuProvider({ children }: { children: ReactNode }) {
	const [request, setRequest] = useState<MenuRequest | null>(null);

	const open = useCallback<ContextMenuApi["open"]>((event, items) => {
		// Nothing to show is not a menu — let the caller fall through to whatever
		// handles the surface underneath rather than flashing an empty box.
		if (items.length === 0) return;
		event.preventDefault();
		setRequest({ x: event.clientX, y: event.clientY, items });
	}, []);

	const close = useCallback(() => setRequest(null), []);

	const api = useMemo(() => ({ open, close, request }), [open, close, request]);

	return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useContextMenu(): ContextMenuApi {
	const api = useContext(Ctx);
	if (!api) throw new Error("useContextMenu used outside ContextMenuProvider");
	return api;
}

/** Drop separators that ended up leading, trailing or doubled. */
export function tidy(items: readonly MenuItem[]): MenuItem[] {
	const out: MenuItem[] = [];
	for (const item of items) {
		if (item.kind === "separator" && (out.length === 0 || out.at(-1)?.kind === "separator")) continue;
		out.push(item);
	}
	while (out.at(-1)?.kind === "separator") out.pop();
	return out;
}
