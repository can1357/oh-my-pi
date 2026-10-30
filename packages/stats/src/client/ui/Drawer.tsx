import { X } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface DrawerProps {
	open: boolean;
	onClose: () => void;
	title: ReactNode;
	subtitle?: ReactNode;
	/** Header controls left of the close button. */
	actions?: ReactNode;
	/** Sheet width in px. Default 560. */
	width?: number;
	children: ReactNode;
}

/**
 * Right-side glass sheet over a scrim, portalled to `document.body`. Esc and
 * scrim clicks close it; focus returns to the opener.
 */
export function Drawer({ open, onClose, title, subtitle, actions, width, children }: DrawerProps) {
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const panelRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		panelRef.current?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onCloseRef.current();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			opener?.focus();
		};
	}, [open]);

	if (!open) return null;
	return createPortal(
		<>
			<div className="drawer-scrim" onClick={onClose} role="presentation" />
			<div
				ref={panelRef}
				className="drawer"
				role="dialog"
				aria-modal="true"
				tabIndex={-1}
				style={width !== undefined ? ({ "--drawer-w": `${width}px` } as CSSProperties) : undefined}
			>
				<header className="drawer-header">
					<div className="drawer-titles">
						<h2 className="drawer-title">{title}</h2>
						{subtitle !== undefined && <div className="drawer-subtitle">{subtitle}</div>}
					</div>
					{actions}
					<button
						type="button"
						className="btn"
						data-variant="ghost"
						data-icon="true"
						onClick={onClose}
						aria-label="Close"
					>
						<X size={16} />
					</button>
				</header>
				<div className="drawer-body">{children}</div>
			</div>
		</>,
		document.body,
	);
}

/** Label/value grid for detail panels. */
export function KeyValues({ items }: { items: readonly { key: string; label: ReactNode; value: ReactNode }[] }) {
	return (
		<dl className="kv" style={{ margin: 0 }}>
			{items.map(item => (
				<div key={item.key} className="kv-item">
					<dt className="kv-key">{item.label}</dt>
					<dd className="kv-value" style={{ margin: 0 }}>
						{item.value}
					</dd>
				</div>
			))}
		</dl>
	);
}
