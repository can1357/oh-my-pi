import type { RefObject } from "react";
import { useEffect } from "react";

const FOCUSABLE_SELECTOR = [
	"a[href]",
	"button:not([disabled])",
	"input:not([disabled])",
	"textarea:not([disabled])",
	"select:not([disabled])",
	'[tabindex]:not([tabindex="-1"])',
].join(", ");

function getFocusableElements(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		el => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true",
	);
}

export interface FocusTrapOptions {
	/** Whether the modal dialog is open (controls focus capture & restoration). */
	active: boolean;
	/** Temporarily suspend Tab trapping while a nested modal sits above this one. */
	paused?: boolean;
	/** Preferred element to focus when the dialog activates. */
	initialFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Traps Tab/Shift+Tab focus within `containerRef` while `active && !paused`,
 * and restores focus to the element that was active before the dialog opened.
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, options: FocusTrapOptions): void {
	const { active, paused = false, initialFocusRef } = options;

	useEffect(() => {
		if (!active) return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const container = containerRef.current;
		const target = initialFocusRef?.current ?? (container ? (getFocusableElements(container)[0] ?? container) : null);
		target?.focus();

		return () => {
			if (previous?.isConnected) {
				previous.focus();
			}
		};
	}, [active, containerRef, initialFocusRef]);

	useEffect(() => {
		if (!active || paused) return;

		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.key !== "Tab") return;
			const container = containerRef.current;
			if (!container) return;
			const focusables = getFocusableElements(container);
			if (focusables.length === 0) {
				e.preventDefault();
				container.focus();
				return;
			}
			const first = focusables[0];
			const last = focusables[focusables.length - 1];
			const current = document.activeElement;
			if (e.shiftKey) {
				if (current === first || !(current instanceof Node) || !container.contains(current)) {
					e.preventDefault();
					last.focus();
				}
			} else if (current === last || !(current instanceof Node) || !container.contains(current)) {
				e.preventDefault();
				first.focus();
			}
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [active, paused, containerRef]);
}
