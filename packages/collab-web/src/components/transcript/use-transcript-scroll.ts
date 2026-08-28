import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

export const FOLLOW_LOCK_PX = 40;

/** Scroller metrics the follow-lock decisions are computed from. */
export interface ScrollView {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}

export interface ScrollDecision {
	locked: boolean;
	jump: boolean;
	/** Next scrollTop; differs from the input only when the caller must pin. */
	scrollTop: number;
}

/** True when the transcript tail is more than one viewport below the current view. */
export function jumpVisible(gap: number, view: number): boolean {
	return gap > view;
}

/** Follow-lock + pill decision after a user scroll: lock re-arms within FOLLOW_LOCK_PX of the tail. */
export function reconcileUserScroll(view: ScrollView): ScrollDecision {
	const gap = view.scrollHeight - view.scrollTop - view.clientHeight;
	return { locked: gap <= FOLLOW_LOCK_PX, jump: jumpVisible(gap, view.clientHeight), scrollTop: view.scrollTop };
}

/**
 * Follow-lock + pill decision after the scroller itself resized (mobile keyboard,
 * split view): a locked scroller stays pinned to the tail so the height change is
 * not misread as a user scroll-up. An unlocked scroller keeps its position; only
 * the pill re-derives from the new clientHeight (plus lock re-arm if the browser
 * clamped the scroller to the tail).
 */
export function reconcileResize(view: ScrollView, locked: boolean): ScrollDecision {
	if (locked) return { locked: true, jump: false, scrollTop: view.scrollHeight };
	return reconcileUserScroll(view);
}

export function useTranscriptScroll(
	jumpEnabled: boolean,
	entries: unknown,
	stream: unknown,
	activeTools: unknown,
	working: unknown,
): {
	rootRef: RefObject<HTMLDivElement | null>;
	showJump: boolean;
	onScroll: () => void;
	jumpToBottom: () => void;
} {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(true);
	const [showJump, setShowJump] = useState(false);

	const applyDecision = useCallback(
		(decision: ScrollDecision): void => {
			const el = rootRef.current;
			if (el !== null && decision.scrollTop !== el.scrollTop) el.scrollTop = decision.scrollTop;
			lockRef.current = decision.locked;
			const next = jumpEnabled && decision.jump;
			setShowJump(prev => (prev === next ? prev : next));
		},
		[jumpEnabled],
	);

	const onScroll = useCallback((): void => {
		const el = rootRef.current;
		if (el === null) return;
		applyDecision(reconcileUserScroll(el));
	}, [applyDecision]);

	// Resize (mobile keyboard) is not a user scroll: keep a locked scroller pinned.
	const onResize = useCallback((): void => {
		const el = rootRef.current;
		if (el === null) return;
		applyDecision(reconcileResize(el, lockRef.current));
	}, [applyDecision]);

	useEffect(() => {
		const el = rootRef.current;
		if (el !== null && lockRef.current) el.scrollTop = el.scrollHeight;
		onScroll();
	}, [entries, stream, activeTools, working, onScroll]);

	useEffect(() => {
		if (!jumpEnabled) return;
		const el = rootRef.current;
		if (el === null) return;
		const ro = new ResizeObserver(onResize);
		ro.observe(el);
		return () => {
			ro.disconnect();
		};
	}, [jumpEnabled, onResize]);

	const jumpToBottom = useCallback((): void => {
		const el = rootRef.current;
		if (el === null) return;
		applyDecision({ locked: true, jump: false, scrollTop: el.scrollHeight });
		el.focus();
	}, [applyDecision]);

	return { rootRef, showJump, onScroll, jumpToBottom };
}
