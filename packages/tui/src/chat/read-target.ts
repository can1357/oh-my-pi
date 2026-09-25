/** Host-owned internal protocol classifier used by compact read cards. */
export let internalReadTargetPredicate: ((target: string) => boolean) | undefined;

/** Supply protocol classification without loading the host router in a renderer. */
export function setInternalReadTargetPredicate(predicate: (target: string) => boolean): void {
	internalReadTargetPredicate = predicate;
}
