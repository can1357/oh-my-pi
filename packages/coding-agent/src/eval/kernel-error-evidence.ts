/** Structured fields accepted from a language runner error frame. */
export interface KernelErrorFrame {
	ename?: unknown;
	evalue?: unknown;
	traceback?: unknown;
	command?: unknown;
	returncode?: unknown;
	stdout?: unknown;
	stderr?: unknown;
}

/** Error evidence returned by a kernel execution without traceback parsing. */
export interface KernelExecutionError {
	name: string;
	value: string;
	traceback: string[];
	command?: string | readonly string[];
	returncode?: number;
	stdout?: string;
	stderr?: string;
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asOptionalCommand(value: unknown): string | readonly string[] | undefined {
	if (typeof value === "string") return value;
	if (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(item => typeof item === "string" || typeof item === "number")
	) {
		return Object.freeze(value.map(String));
	}
	return undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatCommandEvidence(command: string | readonly string[]): string {
	if (typeof command === "string") return command;
	return command.join(" ");
}

/**
 * Copy explicit process-failure fields from a runner error frame.
 * Never invents command/returncode/stdout/stderr by parsing traceback text.
 */
export function mapKernelErrorFrame(frame: KernelErrorFrame): KernelExecutionError {
	const traceback = Array.isArray(frame.traceback) ? frame.traceback.map(String) : [];
	const error: KernelExecutionError = {
		name: String(frame.ename ?? "Error"),
		value: String(frame.evalue ?? ""),
		traceback,
	};
	const command = asOptionalCommand(frame.command);
	const returncode = asOptionalNumber(frame.returncode);
	const stdout = asOptionalString(frame.stdout);
	const stderr = asOptionalString(frame.stderr);
	if (command !== undefined) error.command = command;
	if (returncode !== undefined) error.returncode = returncode;
	if (stdout !== undefined) error.stdout = stdout;
	if (stderr !== undefined) error.stderr = stderr;
	return error;
}

/** Model-visible evidence block for CalledProcessError / TimeoutExpired fields. */
export function formatKernelProcessErrorEvidence(error: KernelExecutionError): string {
	const lines: string[] = [];
	if (error.command !== undefined) lines.push(`command: ${formatCommandEvidence(error.command)}`);
	if (error.returncode !== undefined) lines.push(`return code: ${error.returncode}`);
	if (error.stdout !== undefined) lines.push(`stdout:\n${error.stdout}`);
	if (error.stderr !== undefined) lines.push(`stderr:\n${error.stderr}`);
	return lines.join("\n");
}
