export interface StorageBudget {
	tempBytes: number;
	rawBytes: number;
	processedBytes: number;
	databaseBytes: number;
	totalBytes: number;
	minimumFreeDiskBytes: number;
	minimumFreeDiskPercent: number;
}

export type PressureState = "normal" | "pressure" | "critical" | "emergency";
export type StorageWriteCategory = "temp" | "raw" | "processed" | "database" | "audit";

export interface WriteRequest {
	category: StorageWriteCategory;
	estimatedBytes: number;
	userId: string;
	projectId?: string;
	sessionId: string;
}

export interface WriteDecision {
	allowed: boolean;
	state: PressureState;
	reason?: string;
	recommendedAction?: "write" | "degrade" | "processed_only" | "reject_and_cleanup";
}

export interface QuotaSnapshot {
	tempBytes: number;
	rawBytes: number;
	processedBytes: number;
	databaseBytes: number;
	totalBytes: number;
	freeDiskBytes: number;
	freeDiskPercent: number;
	diskCapacityBytes?: number;
}

export function pressureState(used: number, max: number): PressureState {
	const ratio = max <= 0 ? 1 : used / max;
	if (ratio >= 0.95) return "emergency";
	if (ratio >= 0.85) return "critical";
	if (ratio >= 0.7) return "pressure";
	return "normal";
}

export function authorizeWrite(request: WriteRequest, budget: StorageBudget, snapshot: QuotaSnapshot): WriteDecision {
	if (!Number.isSafeInteger(request.estimatedBytes) || request.estimatedBytes <= 0) {
		return { allowed: false, state: "normal", reason: "invalid estimated write size" };
	}

	const projectedFreeBytes = snapshot.freeDiskBytes - request.estimatedBytes;
	const projectedFreePercent =
		snapshot.diskCapacityBytes === undefined || snapshot.diskCapacityBytes <= 0
			? snapshot.freeDiskPercent
			: (projectedFreeBytes / snapshot.diskCapacityBytes) * 100;
	if (
		(projectedFreeBytes < budget.minimumFreeDiskBytes || projectedFreePercent < budget.minimumFreeDiskPercent) &&
		request.category !== "audit"
	) {
		return reject("emergency", "minimum free-disk reserve would be violated");
	}

	const categoryLimit = {
		temp: budget.tempBytes,
		raw: budget.rawBytes,
		processed: budget.processedBytes,
		database: budget.databaseBytes,
		audit: undefined,
	}[request.category];
	const categoryBytes = {
		temp: snapshot.tempBytes,
		raw: snapshot.rawBytes,
		processed: snapshot.processedBytes,
		database: snapshot.databaseBytes,
		audit: 0,
	}[request.category];
	if (categoryLimit !== undefined && categoryBytes + request.estimatedBytes > categoryLimit) {
		return reject(
			pressureState(snapshot.totalBytes + request.estimatedBytes, budget.totalBytes),
			`${request.category} storage budget would be exceeded`,
			request.category === "raw" ? "processed_only" : "reject_and_cleanup",
		);
	}

	const state = pressureState(snapshot.totalBytes + request.estimatedBytes, budget.totalBytes);
	if (state === "emergency" && request.category !== "audit") {
		return reject(state, "persistent-context storage budget exhausted");
	}
	if (state === "critical" && request.category === "raw") {
		return reject(state, "raw persistence disabled under critical pressure", "processed_only");
	}
	return { allowed: true, state, recommendedAction: state === "pressure" ? "degrade" : "write" };
}

function reject(
	state: PressureState,
	reason: string,
	recommendedAction: WriteDecision["recommendedAction"] = "reject_and_cleanup",
): WriteDecision {
	return { allowed: false, state, reason, recommendedAction };
}
