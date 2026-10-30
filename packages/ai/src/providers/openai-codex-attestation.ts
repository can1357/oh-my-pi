/** Host integration boundary for just-in-time `x-oai-attestation` values. */
export type CodexAttestationProvider = () => Promise<string | undefined>;

let codexAttestationProvider: CodexAttestationProvider | undefined;

/** Install the process-wide just-in-time Codex attestation provider. */
export function setCodexAttestationProvider(provider: CodexAttestationProvider | undefined): void {
	codexAttestationProvider = provider;
}

/** Resolve an attestation only for ChatGPT-OAuth credentials. */
export async function getCodexAttestationHeader(accountId: string | undefined): Promise<string | undefined> {
	if (!accountId || !codexAttestationProvider) return undefined;
	try {
		return await codexAttestationProvider();
	} catch {
		return undefined;
	}
}
