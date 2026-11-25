/**
 * The piped child a protocol client drives: Bun's piped `Subprocess`, or a sandboxed child
 * (`SandboxChild`) satisfying it structurally. Kept apart from the sandbox runtime so consumers
 * of a child process need not import it.
 */
export interface PipedChild {
	readonly pid: number;
	readonly stdin: { write(data: string | Uint8Array): void; flush(): void; end(): void };
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	kill(signal?: NodeJS.Signals): void;
}
