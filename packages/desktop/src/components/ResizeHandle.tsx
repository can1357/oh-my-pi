import { useCallback, useRef, useState } from "react";

/**
 * The grab strip between two columns.
 *
 * Pointer events rather than mouse events, and `setPointerCapture` rather than
 * window listeners: capture keeps the drag alive when the cursor outruns the
 * strip — which it always does — and releases it automatically if the pointer
 * is lost, so there is no stuck-dragging state to clean up.
 *
 * It is a `separator` with a value, not a bare div, so the columns can also be
 * sized from the keyboard. Double-click restores the default.
 */
export function ResizeHandle({
	side,
	width,
	label,
	onResize,
	onReset,
}: {
	/** Which column the strip belongs to, which decides the sign of the drag. */
	side: "left" | "right";
	width: number;
	label: string;
	onResize(width: number): void;
	onReset(): void;
}) {
	const origin = useRef({ x: 0, width: 0 });
	const [dragging, setDragging] = useState(false);

	const move = useCallback(
		(clientX: number) => {
			const delta = clientX - origin.current.x;
			// Dragging right widens a left column and narrows a right one.
			onResize(origin.current.width + (side === "left" ? delta : -delta));
		},
		[onResize, side],
	);

	return (
		<div
			className="omp-resize"
			data-side={side}
			data-dragging={dragging || undefined}
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={Math.round(width)}
			tabIndex={0}
			onPointerDown={event => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				origin.current = { x: event.clientX, width };
				setDragging(true);
			}}
			onPointerMove={event => {
				if (dragging) move(event.clientX);
			}}
			onPointerUp={event => {
				event.currentTarget.releasePointerCapture(event.pointerId);
				setDragging(false);
			}}
			onPointerCancel={() => setDragging(false)}
			onDoubleClick={onReset}
			onKeyDown={event => {
				// Shift for a fine adjustment, matching how nudging works elsewhere.
				const step = event.shiftKey ? 1 : 16;
				const towards = side === "left" ? 1 : -1;
				if (event.key === "ArrowRight") {
					event.preventDefault();
					onResize(width + step * towards);
				} else if (event.key === "ArrowLeft") {
					event.preventDefault();
					onResize(width - step * towards);
				} else if (event.key === "Home") {
					event.preventDefault();
					onReset();
				}
			}}
		/>
	);
}
