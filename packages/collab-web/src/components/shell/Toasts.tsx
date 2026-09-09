import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { Notice } from "../../lib/client";

const INFO_TTL_MS = 4000;
const WARNING_TTL_MS = 8000;
const MAX_VISIBLE = 4;

export function Toasts({ notices }: { notices: readonly Notice[] }): ReactNode {
	// Dynamic membership keyed by notice id — runtime collection.
	const [dismissed, setDismissed] = useState<Set<number>>(() => new Set());

	useEffect(() => {
		const timers: number[] = [];
		for (const n of notices) {
			if (n.level === "error" || dismissed.has(n.id)) continue;
			const ttl = n.level === "info" ? INFO_TTL_MS : WARNING_TTL_MS;
			const remaining = n.at + ttl - Date.now();
			timers.push(
				window.setTimeout(
					() => {
						setDismissed(prev => {
							if (prev.has(n.id)) return prev;
							const next = new Set(prev);
							next.add(n.id);
							return next;
						});
					},
					Math.max(0, remaining),
				),
			);
		}
		return () => {
			for (const t of timers) window.clearTimeout(t);
		};
	}, [notices, dismissed]);

	const visible = notices.filter(n => !dismissed.has(n.id)).slice(-MAX_VISIBLE);
	if (visible.length === 0) return null;

	const close = (id: number): void => {
		setDismissed(prev => {
			const next = new Set(prev);
			next.add(id);
			return next;
		});
	};

	return (
		<div className="sh-toasts">
			{visible.map(n => (
				<div key={n.id} className={`sh-toast sh-toast-${n.level}`} role="status">
					<span className="sh-toast-msg">{n.message}</span>
					{n.level === "error" && (
						<button type="button" className="sh-toast-close" onClick={() => close(n.id)} title="dismiss">
							<X size={12} />
						</button>
					)}
				</div>
			))}
		</div>
	);
}
