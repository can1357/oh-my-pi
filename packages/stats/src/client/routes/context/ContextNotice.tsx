import type { ReactNode } from "react";

export function ContextNotice({ tone = "muted", children }: { tone?: "muted" | "info" | "warn"; children: ReactNode }) {
	return (
		<p className="context-notice-line" data-tone={tone}>
			{children}
		</p>
	);
}
