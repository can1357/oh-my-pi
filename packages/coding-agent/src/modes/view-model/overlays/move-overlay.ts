export interface MoveOverlayResult {
	directory: string;
}

/** Directory suggestion displayed by the move dialog. */
export interface MoveDirectoryEntry {
	/** Full absolute path. */
	value: string;
	/** Display label (basename + trailing slash). */
	label: string;
}

/** Directory autocomplete supplied by the host. */
export interface MoveDirectorySource {
	search(prefix: string, cwd: string, max: number): MoveDirectoryEntry[];
}
