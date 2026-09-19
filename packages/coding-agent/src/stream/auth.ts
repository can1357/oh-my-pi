import { STREAM_AUTH_ENV, STREAM_AUTH_PROVIDER } from "@oh-my-pi/pi-wire";
import { discoverAuthStorage } from "../sdk";
import type { AuthStorage } from "../session/auth-storage";

/**
 * Bearer credential `omp stream` presents to the stream server.
 *
 * `STENCIL_API_KEY` wins outright (debug and CI: `STENCIL_API_KEY=test omp
 * stream …`); otherwise the stencil.so credential stored by `/login` is used
 * and re-resolved before every dial so a refreshed access token is sent after
 * a reconnect. `resolve()` returns null when neither exists.
 */
export class StreamCredential {
	#storage?: AuthStorage;

	async resolve(): Promise<string | null> {
		const fromEnv = process.env[STREAM_AUTH_ENV]?.trim();
		if (fromEnv) return fromEnv;
		this.#storage ??= await discoverAuthStorage();
		const token = await this.#storage.getApiKey(STREAM_AUTH_PROVIDER);
		return token?.trim() || null;
	}

	/** Human guidance for a missing credential. */
	static get missingMessage(): string {
		return `omp stream needs a stencil.so account: run omp and use /login → Stencil, or set ${STREAM_AUTH_ENV}`;
	}

	close(): void {
		this.#storage?.close();
		this.#storage = undefined;
	}
}
