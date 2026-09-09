import type React from "react";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { Skeleton } from "./Skeleton";

export interface AsyncBoundaryProps {
	loading: boolean;
	error: Error | null;
	data: unknown | null;
	empty?: boolean;
	emptyText?: string;
	fallback?: React.ReactNode;
	onRetry?: () => void;
	children: React.ReactNode;
}

export function AsyncBoundary({
	loading,
	error,
	data,
	empty = false,
	emptyText = "No data available",
	fallback,
	onRetry,
	children,
}: AsyncBoundaryProps) {
	// If there's an error and no stale data, render ErrorState
	if (error && data === null) {
		return <ErrorState error={error} onRetry={onRetry} />;
	}

	// If it's loading and there is no stale data, render Loading state / Skeleton
	if (loading && data === null) {
		if (fallback) {
			return <>{fallback}</>;
		}
		return (
			<div className="stats-boundary-skeleton">
				<Skeleton variant="text" width="60%" height={24} className="mb-4" />
				<Skeleton variant="rect" width="100%" height={160} className="mb-4" />
				<Skeleton variant="text" width="80%" height={20} className="mb-2" />
				<Skeleton variant="text" width="40%" height={20} />
			</div>
		);
	}

	// If there is data but it's empty, render EmptyState
	if (!loading && (empty || data === null)) {
		return <EmptyState message={emptyText} />;
	}

	// Render children (stale data is kept visible even if loading is true in background)
	return <>{children}</>;
}
