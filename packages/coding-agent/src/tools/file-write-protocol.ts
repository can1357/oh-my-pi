export const enum FileWriteState {
	Queued,
	Started,
	Cancelled,
}

export interface FileWriteIoRequest {
	id: number;
	dst: string;
	/** Omit to check for a held file without writing (before routing an editor write). */
	content?: string;
	/** One shared atomic word so abort does not have to wait in the worker inbox. */
	state?: Int32Array;
}

export interface FileWriteIoResult {
	id: number;
	error?: NodeJS.ErrnoException;
}
