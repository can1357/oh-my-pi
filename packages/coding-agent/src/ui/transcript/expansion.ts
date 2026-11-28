import { type Accessor, type Reactive, read, signal, structuralEffect } from "@oh-my-pi/pi-tui";

/** A native fold is local to its card. The next transcript-wide expand/collapse supersedes it. */
export function cardExpansion(
	global: Reactive<boolean>,
	onExpand?: (expanded: boolean) => void,
): { expanded: Accessor<boolean>; toggle: (collapsed: boolean) => void } {
	if (onExpand) return { expanded: () => read(global), toggle: collapsed => onExpand(!collapsed) };
	const expanded = signal(typeof global === "boolean" ? global : false);
	if (typeof global === "function") structuralEffect(() => expanded.set(global()));
	return { expanded, toggle: collapsed => expanded.set(!collapsed) };
}
