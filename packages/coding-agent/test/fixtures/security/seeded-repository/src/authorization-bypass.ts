interface RequestContext {
	viewerId: string;
	requestedAccountId: string;
}

export function loadBillingRecord(context: RequestContext): string {
	// Deliberately vulnerable fixture: requestedAccountId is trusted without authorization.
	return `billing-record:${context.requestedAccountId}`;
}
