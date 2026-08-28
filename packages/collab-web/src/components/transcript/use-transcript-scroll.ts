import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

export const FOLLOW_LOCK_PX = 40;

/** True when the transcript tail is more than one viewport below the current view. */
export function jumpVisible(gap: number, view: number): boolean {
	return gap > view;
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

	const syncGap = useCallback((): void => {
		const el = rootRef.current;
		if (el === null) return;
		const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
		lockRef.current = gap <= FOLLOW_LOCK_PX;
		const next = jumpEnabled && jumpVisible(gap, el.clientHeight);
		setShowJump(prev => (prev === next ? prev : next));
	}, [jumpEnabled]);

	useEffect(() => {
		const el = rootRef.current;
		if (el !== null && lockRef.current) el.scrollTop = el.scrollHeight;
		syncGap();
	}, [entries, stream, activeTools, working, syncGap]);

	useEffect(() => {
		if (!jumpEnabled) return;
		const el = rootRef.current;
		if (el === null) return;
		const ro = new ResizeObserver(syncGap);
		ro.observe(el);
		return () => {
			ro.disconnect();
		};
	}, [jumpEnabled, syncGap]);

	const jumpToBottom = useCallback((): void => {
		const el = rootRef.current;
		if (el === null) return;
		el.scrollTop = el.scrollHeight;
		lockRef.current = true;
		setShowJump(false);
		el.focus();
	}, []);

	return { rootRef, showJump, onScroll: syncGap, jumpToBottom };
}
