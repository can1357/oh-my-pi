import { stringifyDeepJson } from "@oh-my-pi/pi-utils/json";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export interface JsonBlockProps {
	data: unknown;
	title?: string;
	initialCollapsed?: boolean;
}

/**
 * Collapsible, copyable pretty-printed JSON. A value nested past `INDENTED_JSON_LEVELS` (1,000) levels, which a
 * transcript entry can be (a line nests up to millions), is shown on one line: indented text grows with the square of
 * the depth, and a browser's `JSON.stringify` runs out of stack long before that depth.
 */
export function JsonBlock({ data, title = "JSON", initialCollapsed = false }: JsonBlockProps) {
	const [collapsed, setCollapsed] = useState(initialCollapsed);
	const [copied, setCopied] = useState(false);
	const copyResetRef = useRef<number>(0);
	const json = useMemo(() => stringifyDeepJson(data, { space: 2 }) ?? "", [data]);

	// Clear the pending "Copied" reset if the block unmounts (e.g. drawer close).
	useEffect(() => () => window.clearTimeout(copyResetRef.current), []);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(json);
			setCopied(true);
			window.clearTimeout(copyResetRef.current);
			copyResetRef.current = window.setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard API unavailable (e.g. insecure context); silently no-op.
		}
	};

	return (
		<div className="stack" style={{ gap: 6 }}>
			<div className="row" style={{ justifyContent: "space-between" }}>
				<button
					type="button"
					className="btn"
					data-variant="ghost"
					data-size="sm"
					onClick={() => setCollapsed(c => !c)}
					aria-expanded={!collapsed}
				>
					{collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
					{title}
				</button>
				<button type="button" className="btn" data-variant="ghost" data-size="sm" onClick={copy}>
					{copied ? <Check size={13} /> : <Copy size={13} />}
					{copied ? "Copied" : "Copy"}
				</button>
			</div>
			{!collapsed && (
				<pre className="code-block">
					<code>{json}</code>
				</pre>
			)}
		</div>
	);
}
