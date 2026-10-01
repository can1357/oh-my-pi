let frozen: number | undefined;

// Current time in milliseconds. Tests call freeze() to pin it.
export function now(): number {
	if (frozen !== undefined) return frozen;
	return Date.now();
}

export function freeze(at: number | undefined): void {
	frozen = at;
}
