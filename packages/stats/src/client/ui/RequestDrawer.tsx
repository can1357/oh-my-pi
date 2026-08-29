import { Clock, Coins, Gauge, Hash, Star, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getRequestDetails } from "../api";
import { formatDurationMs, formatInteger, formatMessageCost } from "../data/formatters";
import type { RequestDetails } from "../types";
import { JsonBlock } from "./JsonBlock";
import { Skeleton } from "./Skeleton";
import { StatusPill } from "./StatusPill";

export interface RequestDrawerProps {
	id: number | null;
	onClose: () => void;
}

export function RequestDrawer({ id, onClose }: RequestDrawerProps) {
	const [details, setDetails] = useState<RequestDetails | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const previousActiveElement = useRef<HTMLElement | null>(null);
	const closeButtonRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (id === null) {
			setDetails(null);
			return;
		}

		previousActiveElement.current = document.activeElement as HTMLElement | null;
		setLoading(true);
		setError(null);
		setDetails(null);

		const controller = new AbortController();
		getRequestDetails(id, controller.signal)
			.then(data => {
				if (controller.signal.aborted) return;
				setDetails(data);
				// Focus the close button for accessibility
				setTimeout(() => closeButtonRef.current?.focus(), 50);
			})
			.catch(err => {
				if (controller.signal.aborted) return;
				setError(err instanceof Error ? err : new Error(String(err)));
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});

		return () => controller.abort();
	}, [id]);

	useEffect(() => {
		if (id === null) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			if (previousActiveElement.current) {
				previousActiveElement.current.focus();
			}
		};
	}, [id, onClose]);

	if (id === null) return null;

	const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
		if (e.target === e.currentTarget) {
			onClose();
		}
	};

	return (
		<div className="stats-drawer-overlay" onClick={handleOverlayClick} role="presentation">
			<div className="stats-drawer" role="dialog" aria-modal="true" aria-label="Request details">
				{/* Drawer Header */}
				<div className="stats-drawer-header">
					<div className="stats-drawer-header-left">
						<h2 className="stats-drawer-title">Request Details</h2>
						{details && <span className="stats-drawer-id">ID: {id}</span>}
					</div>
					<button
						ref={closeButtonRef}
						type="button"
						onClick={onClose}
						className="stats-drawer-close-btn"
						aria-label="Close request details"
					>
						<X size={18} />
					</button>
				</div>

				<div className="stats-drawer-body">
					{loading && (
						<div className="stats-drawer-loading">
							<Skeleton variant="text" width="60%" height={24} className="mb-4" />
							<Skeleton variant="rect" width="100%" height={80} className="mb-4" />
							<Skeleton variant="rect" width="100%" height={120} className="mb-4" />
							<Skeleton variant="rect" width="100%" height={200} />
						</div>
					)}

					{error && (
						<div className="stats-drawer-error">
							<p className="stats-drawer-error-title">Failed to load request details</p>
							<p className="stats-drawer-error-message">{error.message}</p>
						</div>
					)}

					{details && (
						<div className="stats-drawer-content">
							{/* Status Card */}
							<div className="stats-drawer-status-card">
								<div className="stats-drawer-status-row">
									<div>
										<div className="stats-drawer-model">{details.model}</div>
										<div className="stats-drawer-provider">{details.provider}</div>
									</div>
									<StatusPill variant={details.errorMessage ? "danger" : "success"}>
										{details.errorMessage ? "Error" : "Success"}
									</StatusPill>
								</div>
								{details.errorMessage && (
									<div className="stats-drawer-error-block">
										<div className="stats-drawer-error-label">Error Message</div>
										<div className="stats-drawer-error-text">{details.errorMessage}</div>
									</div>
								)}
							</div>

							{/* Metrics Grid */}
							<div className="stats-drawer-metrics-grid">
								<div className="stats-drawer-metric-card">
									<div className="stats-drawer-metric-label">
										<Coins size={14} className="stats-drawer-metric-icon" />
										API-equivalent estimate
									</div>
									<div className="stats-drawer-metric-value">{formatMessageCost(details, 4)}</div>
								</div>

								<div className="stats-drawer-metric-card">
									<div className="stats-drawer-metric-label">
										<Star size={14} className="stats-drawer-metric-icon" />
										Premium
									</div>
									<div className="stats-drawer-metric-value">
										{formatInteger(details.usage.premiumRequests ?? 0)}
									</div>
								</div>

								<div className="stats-drawer-metric-card">
									<div className="stats-drawer-metric-label">
										<Hash size={14} className="stats-drawer-metric-icon" />
										Total Tokens
									</div>
									<div className="stats-drawer-metric-value">{formatInteger(details.usage.totalTokens)}</div>
									<div className="stats-drawer-metric-sub">
										{formatInteger(details.usage.input)} in · {formatInteger(details.usage.output)} out
									</div>
								</div>

								<div className="stats-drawer-metric-card">
									<div className="stats-drawer-metric-label">
										<Clock size={14} className="stats-drawer-metric-icon" />
										Duration
									</div>
									<div className="stats-drawer-metric-value">{formatDurationMs(details.duration)}</div>
								</div>

								<div className="stats-drawer-metric-card">
									<div className="stats-drawer-metric-label">
										<Zap size={14} className="stats-drawer-metric-icon" />
										TTFT
									</div>
									<div className="stats-drawer-metric-value">{formatDurationMs(details.ttft)}</div>
								</div>

								{details.duration && details.usage.output > 0 && (
									<div className="stats-drawer-metric-card">
										<div className="stats-drawer-metric-label">
											<Gauge size={14} className="stats-drawer-metric-icon" />
											Throughput
										</div>
										<div className="stats-drawer-metric-value">
											{((details.usage.output * 1000) / details.duration).toFixed(1)}
										</div>
										<div className="stats-drawer-metric-sub">tokens/second</div>
									</div>
								)}
							</div>

							{/* JSON blocks */}
							<div className="stats-drawer-json-blocks">
								<JsonBlock data={details.output} title="Output Payload" initialCollapsed={false} />
								<JsonBlock data={details} title="Raw Request Metadata" initialCollapsed={true} />
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
