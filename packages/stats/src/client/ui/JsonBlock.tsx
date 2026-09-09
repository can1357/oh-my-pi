import { Check, Copy } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";

export interface JsonBlockProps {
	data: unknown;
	title?: string;
	initialCollapsed?: boolean;
}

export function JsonBlock({ data, title, initialCollapsed = false }: JsonBlockProps) {
	const [collapsed, setCollapsed] = useState(initialCollapsed);
	const [copied, setCopied] = useState(false);
	const copyResetRef = useRef<number>(0);
	const jsonStr = JSON.stringify(data, null, 2);

	// Clear the pending "Copied" reset if the block unmounts (e.g. drawer close).
	useEffect(() => () => window.clearTimeout(copyResetRef.current), []);

	const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			setCollapsed(!collapsed);
		}
	};

	const handleCopy = async (e: React.MouseEvent) => {
		// Don't toggle the collapse state when copying.
		e.stopPropagation();
		try {
			await navigator.clipboard.writeText(jsonStr);
			setCopied(true);
			window.clearTimeout(copyResetRef.current);
			copyResetRef.current = window.setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard API unavailable (e.g. insecure context); silently no-op.
		}
	};

	return (
		<div className="stats-json-block">
			<div
				className="stats-json-block-header"
				onClick={() => setCollapsed(!collapsed)}
				onKeyDown={handleKeyDown}
				tabIndex={0}
				role="button"
				aria-expanded={!collapsed}
			>
				<span className="stats-json-block-title">{title || "JSON"}</span>
				<div className="stats-json-actions">
					<button
						type="button"
						className="stats-json-copy-btn"
						onClick={handleCopy}
						aria-label={copied ? "Copied to clipboard" : "Copy JSON to clipboard"}
					>
						{copied ? <Check size={13} /> : <Copy size={13} />}
						{copied ? "Copied" : "Copy"}
					</button>
					<span className="stats-json-block-toggle-indicator" data-collapsed={collapsed}>
						{collapsed ? "▶ Show" : "▼ Hide"}
					</span>
				</div>
			</div>
			{!collapsed && (
				<div className="stats-json-block-content-wrapper">
					<pre className="stats-json-block-content">
						<code>{jsonStr}</code>
					</pre>
				</div>
			)}
		</div>
	);
}
