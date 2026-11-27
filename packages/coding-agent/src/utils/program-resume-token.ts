/** Environment variable carrying the per-terminal OSC 7577 token. */
export const OSC_7577_TOKEN_ENV = "OSC7577_TOKEN";

/** Token grammar: 22 to 64 characters of `[A-Za-z0-9_-]`. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

let token: string | undefined;

/**
 * Capture `OSC7577_TOKEN` from `process.env` into memory and immediately delete
 * it from `process.env` so no child process inherits it. Safe to call multiple
 * times; a newly set env value replaces any previously captured token.
 */
export function captureProgramResumeToken(): string | undefined {
	const raw = process.env[OSC_7577_TOKEN_ENV];
	if (raw !== undefined) {
		try {
			delete process.env[OSC_7577_TOKEN_ENV];
		} catch {}
		token = TOKEN_PATTERN.test(raw) ? raw : undefined;
	}
	return token;
}

/**
 * Returns the captured OSC 7577 token solely so an in-place `/restart` can
 * pass it to the replacement omp process sharing the same PTY.
 */
export function getProgramResumeToken(): string | undefined {
	return token;
}

/** Reset bootstrap state between isolated CLI sessions in tests. */
export function resetProgramResumeTokenForTests(): void {
	token = undefined;
}
