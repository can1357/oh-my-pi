export interface HelloRefreshTabChange {
	url?: string;
	groupId?: number;
}

/**
 * URL and group changes affect relay reconciliation, so an in-flight hello
 * carrying their previous values must be suppressed rather than merely
 * followed by a metadata refresh.
 */
export function invalidatesHelloStructurally(changeInfo: HelloRefreshTabChange): boolean {
	return changeInfo.groupId !== undefined || changeInfo.url !== undefined;
}
