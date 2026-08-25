import { ChevronDown, ChevronUp, GripVertical, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WidgetSize } from "../data/dashboard-prefs";
import {
	type DashboardPreset,
	dashboardPrefsStore,
	type OverviewWidgetId,
	useDashboardPrefs,
	WIDGET_META,
} from "../data/dashboard-prefs";

const PRESETS: { value: Exclude<DashboardPreset, "custom">; label: string }[] = [
	{ value: "default", label: "Default" },
	{ value: "cost", label: "Cost" },
	{ value: "tokens", label: "Tokens" },
	{ value: "developer", label: "Developer" },
];

const SIZE_OPTIONS: { value: WidgetSize; label: string }[] = [
	{ value: "small", label: "S" },
	{ value: "medium", label: "M" },
	{ value: "wide", label: "W" },
];

interface CustomizeDrawerProps {
	open: boolean;
	onClose: () => void;
}

/**
 * Customization drawer for the Overview dashboard (spec §10): preset pills,
 * per-widget visibility/size/reorder rows (keyboard-accessible up/down +
 * native drag enhancement), and a confirmed Reset.
 * Right drawer ≥768px, bottom sheet below.
 */
export function CustomizeDrawer({ open, onClose }: CustomizeDrawerProps) {
	const prefs = useDashboardPrefs();
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const restoreFocusRef = useRef<HTMLElement | null>(null);
	const [confirmingReset, setConfirmingReset] = useState(false);

	// Focus management: move focus into the drawer on open, restore on close.
	useEffect(() => {
		if (!open) return;
		restoreFocusRef.current = document.activeElement as HTMLElement | null;
		closeButtonRef.current?.focus();
		return () => {
			restoreFocusRef.current?.focus();
			restoreFocusRef.current = null;
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [open, onClose]);

	const handleDragStart = useCallback((e: React.DragEvent, id: OverviewWidgetId) => {
		e.dataTransfer.setData("text/omp-widget-id", id);
		e.dataTransfer.effectAllowed = "move";
	}, []);

	const handleDrop = useCallback(
		(e: React.DragEvent, targetId: OverviewWidgetId) => {
			e.preventDefault();
			const sourceId = e.dataTransfer.getData("text/omp-widget-id");
			if (!sourceId || sourceId === targetId) return;
			const ids = prefs.widgets.map(w => w.id);
			const fromIndex = ids.indexOf(sourceId as OverviewWidgetId);
			let toIndex = ids.indexOf(targetId);
			if (fromIndex === -1 || toIndex === -1) return;
			ids.splice(fromIndex, 1);
			// Dropping onto the lower half of a row targets the slot after it.
			toIndex = ids.indexOf(targetId) + 1;
			ids.splice(toIndex, 0, sourceId as OverviewWidgetId);
			dashboardPrefsStore.reorderByIds(ids.filter(id => prefs.widgets.some(w => w.id === id)));
		},
		[prefs.widgets],
	);

	if (!open) return null;

	return (
		<>
			<div className="stats-customize-overlay" onClick={onClose} role="presentation" />
			<aside className="stats-customize-drawer" role="dialog" aria-modal="true" aria-label="Customize overview">
				<header className="stats-customize-header">
					<div>
						<h2 className="stats-customize-title">Customize overview</h2>
						<p className="stats-customize-subtitle">Choose which sections you see and how they're arranged.</p>
					</div>
					<button
						ref={closeButtonRef}
						type="button"
						onClick={() => {
							setConfirmingReset(false);
							onClose();
						}}
						className="stats-customize-close-btn"
						aria-label="Close customization"
					>
						<X size={16} />
					</button>
				</header>

				<div className="stats-customize-body">
					<section aria-label="Preset">
						<div className="stats-customize-label" id="customize-preset-label">
							Preset
						</div>
						<div className="stats-preset-row" role="group" aria-labelledby="customize-preset-label">
							{PRESETS.map(preset => (
								<button
									key={preset.value}
									type="button"
									className="stats-preset-pill"
									data-active={prefs.preset === preset.value ? "true" : "false"}
									aria-pressed={prefs.preset === preset.value}
									onClick={() => {
										setConfirmingReset(false);
										dashboardPrefsStore.setPreset(preset.value);
									}}
								>
									{preset.label}
								</button>
							))}
						</div>
						{prefs.preset === "custom" && (
							<p className="stats-customize-hint">Custom arrangement — edit freely or pick a preset.</p>
						)}
					</section>

					<section aria-label="Sections">
						<div className="stats-customize-label">Sections</div>
						<ul className="stats-widget-list">
							{prefs.widgets.map((entry, index) => {
								const meta = WIDGET_META[entry.id];
								return (
									<li
										key={entry.id}
										className="stats-widget-row"
										data-disabled={!entry.visible}
										draggable
										onDragStart={e => handleDragStart(e, entry.id)}
										onDragOver={e => {
											if (e.dataTransfer.types.includes("text/omp-widget-id")) e.preventDefault();
										}}
										onDrop={e => handleDrop(e, entry.id)}
									>
										<span className="stats-widget-drag-handle" title="Drag to reorder">
											<GripVertical size={14} />
										</span>
										<input
											type="checkbox"
											className="stats-widget-checkbox"
											checked={entry.visible}
											onChange={e => {
												setConfirmingReset(false);
												dashboardPrefsStore.setWidgetVisible(entry.id, e.target.checked);
											}}
											aria-label={`Show ${meta.title}`}
										/>
										<div className="stats-widget-row-text">
											<span className="stats-widget-row-title">{meta.title}</span>
											<span className="stats-widget-row-desc">{meta.description}</span>
										</div>
										<div
											className="stats-widget-size-control"
											role="radiogroup"
											aria-label={`Size for ${meta.title}`}
										>
											{SIZE_OPTIONS.map(size => (
												<button
													key={size.value}
													type="button"
													disabled={!entry.visible}
													aria-checked={entry.size === size.value}
													data-active={entry.size === size.value ? "true" : "false"}
													className="stats-size-btn"
													onClick={() => dashboardPrefsStore.setWidgetSize(entry.id, size.value)}
												>
													{size.label}
												</button>
											))}
										</div>
										<div className="stats-reorder-btns">
											<button
												type="button"
												className="stats-reorder-btn"
												disabled={index === 0}
												aria-label={`Move ${meta.title} up`}
												onClick={() => dashboardPrefsStore.moveWidget(entry.id, "up")}
											>
												<ChevronUp size={14} />
											</button>
											<button
												type="button"
												className="stats-reorder-btn"
												disabled={index === prefs.widgets.length - 1}
												aria-label={`Move ${meta.title} down`}
												onClick={() => dashboardPrefsStore.moveWidget(entry.id, "down")}
											>
												<ChevronDown size={14} />
											</button>
										</div>
									</li>
								);
							})}
						</ul>
					</section>
				</div>

				<footer className="stats-customize-footer">
					{confirmingReset ? (
						<div className="stats-reset-confirm">
							<span className="stats-customize-hint">Restore the default layout? This cannot be undone.</span>
							<div className="stats-reset-confirm-actions">
								<button
									type="button"
									className="stats-button stats-button-secondary stats-reset-cancel"
									onClick={() => setConfirmingReset(false)}
								>
									Cancel
								</button>
								<button
									type="button"
									className="stats-button stats-button-primary stats-reset-apply"
									onClick={() => {
										dashboardPrefsStore.reset();
										setConfirmingReset(false);
									}}
								>
									Confirm reset
								</button>
							</div>
						</div>
					) : (
						<button
							type="button"
							className="stats-button stats-button-secondary stats-reset-btn"
							onClick={() => setConfirmingReset(true)}
						>
							Reset to default
						</button>
					)}
				</footer>
			</aside>
		</>
	);
}

/** TopBar customize button (rendered only on the Overview route). */
export function CustomizeButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	return (
		<button
			type="button"
			className="stats-customize-btn"
			data-active={open ? "true" : "false"}
			aria-expanded={open}
			aria-haspopup="dialog"
			onClick={onToggle}
		>
			Customize
		</button>
	);
}
