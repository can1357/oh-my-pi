import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/** Track an element's content width (ResizeObserver). Returns 0 until measured. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
	const ref = useRef<T | null>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		setWidth(el.clientWidth);
		const observer = new ResizeObserver(entries => {
			const next = Math.round(entries[0]?.contentRect.width ?? 0);
			setWidth(prev => (prev === next ? prev : next));
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	return [ref, width];
}
