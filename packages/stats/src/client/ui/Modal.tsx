import { X } from "lucide-react";
import type React from "react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import "./modal.css";

export interface ModalAction {
	label: string;
	onClick: () => void;
	disabled?: boolean;
}

export interface ModalProps {
	open: boolean;
	title: React.ReactNode;
	/** Called on Esc, overlay click, the close icon, and the cancel button. */
	onClose: () => void;
	/** Confirming action; receives focus whenever it is present and enabled. */
	primaryAction?: ModalAction;
	cancelLabel?: string;
	children: React.ReactNode;
}

/**
 * Centered dialog over a dimmed overlay, portalled to `document.body` so route
 * containers cannot clip it. Focus lands on the primary action (or the cancel
 * button when there is none) and returns to the opener on close.
 */
export function Modal({ open, title, onClose, primaryAction, cancelLabel = "Cancel", children }: ModalProps) {
	const primaryRef = useRef<HTMLButtonElement>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		if (!open) return;
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onCloseRef.current();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			opener?.focus();
		};
	}, [open]);

	const hasPrimary = primaryAction !== undefined;
	const primaryDisabled = primaryAction?.disabled ?? false;
	useEffect(() => {
		if (!open) return;
		const target = hasPrimary && !primaryDisabled ? primaryRef.current : cancelRef.current;
		target?.focus();
	}, [open, hasPrimary, primaryDisabled]);

	if (!open) return null;

	const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
		if (e.target === e.currentTarget) onClose();
	};

	return createPortal(
		<div className="modal-overlay" onClick={handleOverlayClick} role="presentation">
			<div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
				<div className="modal-header">
					<h2 id="modal-title" className="modal-title">
						{title}
					</h2>
					<button
						type="button"
						className="btn"
						data-variant="ghost"
						data-icon="true"
						data-size="sm"
						onClick={onClose}
						aria-label="Close"
					>
						<X size={15} />
					</button>
				</div>
				<div className="modal-body">{children}</div>
				<div className="modal-footer">
					<button ref={cancelRef} type="button" className="btn" onClick={onClose}>
						{cancelLabel}
					</button>
					{primaryAction && (
						<button
							ref={primaryRef}
							type="button"
							className="btn"
							data-variant="primary"
							onClick={primaryAction.onClick}
							disabled={primaryAction.disabled}
						>
							{primaryAction.label}
						</button>
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
}
