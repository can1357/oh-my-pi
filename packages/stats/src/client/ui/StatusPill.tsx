import type React from "react";

export interface StatusPillProps {
	variant: "success" | "danger" | "warning" | "info" | "default";
	children: React.ReactNode;
	className?: string;
}

export function StatusPill({ variant, children, className = "" }: StatusPillProps) {
	return (
		<span className={`stats-status-pill ${className}`} data-variant={variant}>
			{children}
		</span>
	);
}
