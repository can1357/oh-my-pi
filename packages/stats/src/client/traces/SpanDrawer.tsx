/**
 * Detail drawer for a selected trace span. Fetches the full journal entry on
 * demand (`/api/session/entry`) and renders per-kind detail: model usage grid
 * + text blocks, tool args/result, user text, subagent task text.
 */

import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getSessionEntryDetail } from "../api";
import { formatDurationMs, formatInteger } from "../data/formatters";
import type { TraceSpan, TraceTrack } from "../types";
import { JsonBlock } from "../ui/JsonBlock";
import { Skeleton } from "../ui/Skeleton";
import { StatusPill } from "../ui/StatusPill";

export interface SpanDrawerProps {
	span: TraceSpan | null;
	track: TraceTrack | null;
	onClose: () => void;
	/** Selects the first span of the given child track ("open child track"). */
	onOpenChildTrack?: (childTrackId: string) => void;
}

/** Loose structural view of a fetched journal entry (validated field-by-field). */
interface EntryDetailView {
	message?: {
		role?: string;
		content?: unknown;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			totalTokens?: number;
			cost?: { total?: number };
		};
		model?: string;
		provider?: string;
		stopReason?: string;
		errorMessage?: string;
		duration?: number;
		ttft?: number;
		toolName?: string;
		isError?: boolean;
		details?: unknown;
	};
}

function textBlocks(content: unknown): Array<{ kind: string; text: string }> {
	const blocks: Array<{ kind: string; text: string }> = [];
	if (typeof content === "string") {
		if (content.trim()) blocks.push({ kind: "text", text: content });
		return blocks;
	}
	if (!Array.isArray(content)) return blocks;
	for (const block of content) {
		if (!block || typeof block !== "object" || !("type" in block)) continue;
		if ((block.type === "text" || block.type === "thinking") && "text" in block && typeof block.text === "string") {
			blocks.push({ kind: String(block.type), text: block.text });
		}
	}
	return blocks;
}

export function SpanDrawer({ span, track, onClose, onOpenChildTrack }: SpanDrawerProps) {
	const [entry, setEntry] = useState<unknown>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const [copied, setCopied] = useState(false);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const previousActiveElement = useRef<HTMLElement | null>(null);

	useEffect(() => {
		setEntry(null);
		setError(null);
		setCopied(false);
		if (!span || !track || !span.entryId) return;
		previousActiveElement.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setLoading(true);
		const controller = new AbortController();
		getSessionEntryDetail(track.file, span.entryId, controller.signal)
			.then(data => {
				if (controller.signal.aborted) return;
				setEntry(data.entry);
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
	}, [span, track]);

	useEffect(() => {
		if (!span) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			previousActiveElement.current?.focus();
		};
	}, [span, onClose]);

	if (!span) return null;

	const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
		if (event.target === event.currentTarget) onClose();
	};

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(JSON.stringify(entry ?? span, null, 2));
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard unavailable (permissions); leave the button state as-is.
		}
	};

	// Boundary view: server returns opaque journal JSON, fields re-checked below.
	const view: EntryDetailView = entry && typeof entry === "object" ? (entry as EntryDetailView) : {};
	const msg = view.message;
	const usage = msg?.usage;

	return (
		<div className="stats-drawer-overlay" onClick={handleOverlayClick} role="presentation">
			<div className="stats-drawer" role="dialog" aria-modal="true" aria-label="Span details">
				<div className="stats-drawer-header">
					<div className="stats-drawer-header-left">
						<h2 className="stats-drawer-title truncate" style={{ maxWidth: 320 }}>
							{span.label}
						</h2>
						<StatusPill variant={span.isError ? "danger" : "success"}>{span.kind}</StatusPill>
					</div>
					<div style={{ display: "flex", gap: 8 }}>
						<button
							type="button"
							onClick={handleCopy}
							className="stats-drawer-close-btn"
							aria-label="Copy raw JSON"
							title="Copy raw JSON"
						>
							{copied ? <Check size={16} /> : <Copy size={16} />}
						</button>
						<button
							ref={closeButtonRef}
							type="button"
							onClick={onClose}
							className="stats-drawer-close-btn"
							aria-label="Close span details"
						>
							<X size={18} />
						</button>
					</div>
				</div>

				<div className="stats-drawer-body">
					<div className="stats-drawer-content">
						<div className="stats-drawer-metrics-grid">
							<div className="stats-drawer-metric-card">
								<div className="stats-drawer-metric-label">Duration</div>
								<div className="stats-drawer-metric-value">{formatDurationMs(span.end - span.start)}</div>
								{span.unterminated && <div className="stats-drawer-metric-sub">unterminated</div>}
							</div>
							<div className="stats-drawer-metric-card">
								<div className="stats-drawer-metric-label">Start</div>
								<div className="stats-drawer-metric-value" style={{ fontSize: 13 }}>
									{new Date(span.start).toLocaleTimeString()}
								</div>
							</div>
							{span.kind === "model" && (
								<>
									<div className="stats-drawer-metric-card">
										<div className="stats-drawer-metric-label">Tokens</div>
										<div className="stats-drawer-metric-value">{formatInteger(span.tokens ?? 0)}</div>
										{usage && (
											<div className="stats-drawer-metric-sub">
												{formatInteger(usage.input ?? 0)} in · {formatInteger(usage.output ?? 0)} out ·{" "}
												{formatInteger(usage.cacheRead ?? 0)} cached
											</div>
										)}
									</div>
									<div className="stats-drawer-metric-card">
										<div className="stats-drawer-metric-label">Cost</div>
										<div className="stats-drawer-metric-value">${(span.cost ?? 0).toFixed(4)}</div>
									</div>
									<div className="stats-drawer-metric-card">
										<div className="stats-drawer-metric-label">TTFT</div>
										<div className="stats-drawer-metric-value">{formatDurationMs(span.ttft ?? null)}</div>
									</div>
									<div className="stats-drawer-metric-card">
										<div className="stats-drawer-metric-label">Model</div>
										<div className="stats-drawer-metric-value" style={{ fontSize: 12 }}>
											{msg?.model ?? span.model ?? "-"}
										</div>
										{msg?.provider && <div className="stats-drawer-metric-sub">{msg.provider}</div>}
										{msg?.stopReason && <div className="stats-drawer-metric-sub">stop: {msg.stopReason}</div>}
									</div>
								</>
							)}
						</div>

						{msg?.errorMessage && (
							<div className="stats-drawer-error-block">
								<div className="stats-drawer-error-label">Error Message</div>
								<div className="stats-drawer-error-text">{msg.errorMessage}</div>
							</div>
						)}

						{span.kind === "subagent" && (
							<div>
								{span.detail && (
									<pre
										style={{
											whiteSpace: "pre-wrap",
											wordBreak: "break-word",
											fontSize: 12,
											background: "var(--surface-2)",
											borderRadius: 6,
											padding: 10,
										}}
									>
										{span.detail}
									</pre>
								)}
								{span.childTrackId && onOpenChildTrack && (
									<button
										type="button"
										className="stats-segmented-control-btn"
										style={{ marginTop: 8, border: "1px solid var(--border)", borderRadius: 6 }}
										onClick={() => onOpenChildTrack(span.childTrackId ?? "")}
									>
										Open child track {span.childTrackId}
									</button>
								)}
							</div>
						)}

						{span.kind === "tool" && span.detail && (
							<div>
								<div className="stats-drawer-metric-label">Args</div>
								<pre
									style={{
										whiteSpace: "pre-wrap",
										wordBreak: "break-word",
										fontSize: 12,
										background: "var(--surface-2)",
										borderRadius: 6,
										padding: 10,
									}}
								>
									{span.detail}
								</pre>
							</div>
						)}

						{loading && (
							<div>
								<Skeleton variant="rect" width="100%" height={80} className="mb-4" />
								<Skeleton variant="rect" width="100%" height={160} />
							</div>
						)}
						{error && (
							<div className="stats-drawer-error">
								<p className="stats-drawer-error-title">Failed to load entry</p>
								<p className="stats-drawer-error-message">{error.message}</p>
							</div>
						)}

						{!loading &&
							entry !== null &&
							textBlocks(msg?.content).map((block, index) => (
								<div key={`${block.kind}-${index}`}>
									<div className="stats-drawer-metric-label" style={{ textTransform: "capitalize" }}>
										{block.kind}
									</div>
									<pre
										style={{
											whiteSpace: "pre-wrap",
											wordBreak: "break-word",
											fontSize: 12,
											background: "var(--surface-2)",
											borderRadius: 6,
											padding: 10,
											maxHeight: 360,
											overflowY: "auto",
										}}
									>
										{block.text}
									</pre>
								</div>
							))}

						{!loading && entry !== null && (
							<div className="stats-drawer-json-blocks">
								<JsonBlock data={entry} title="Raw Entry" initialCollapsed={true} />
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
