import type React from "react";

export interface SkeletonProps {
	variant?: "text" | "rect" | "circle";
	width?: string | number;
	height?: string | number;
	className?: string;
}

export function Skeleton({ variant = "text", width, height, className = "" }: SkeletonProps) {
	const style: React.CSSProperties = {
		width: width !== undefined ? (typeof width === "number" ? `${width}px` : width) : undefined,
		height: height !== undefined ? (typeof height === "number" ? `${height}px` : height) : undefined,
	};

	return <div className={`stats-skeleton ${className}`} data-variant={variant} style={style} />;
}
