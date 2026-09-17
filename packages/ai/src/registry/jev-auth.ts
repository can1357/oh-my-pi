/** Canonical TypeSafe Jev auth id (System One judgments, not a chat model). */
export const JEV_PROVIDER = "jev";

/** Legacy login ids that share the same credential bucket as {@link JEV_PROVIDER}. */
export const JEV_AUTH_LEGACY_IDS = ["typesafe"] as const;

/** Resolver-only alias (no separate auth policy). */
export const JEV_AUTH_RESOLVER_ALIASES = ["typesafe-ai"] as const;

export function isJevAuthProvider(provider: string): boolean {
	return (
		provider === JEV_PROVIDER ||
		(JEV_AUTH_LEGACY_IDS as readonly string[]).includes(provider) ||
		(JEV_AUTH_RESOLVER_ALIASES as readonly string[]).includes(provider)
	);
}

/** Stored-credential ids checked for Jev auth (canonical first). */
export function jevAuthCredentialIds(): readonly string[] {
	return [JEV_PROVIDER, ...JEV_AUTH_LEGACY_IDS];
}

const AUTH_DEFINITION_ALIASES: Record<string, string> = {
	typesafe: JEV_PROVIDER,
	"typesafe-ai": JEV_PROVIDER,
};

/** Map a login / resolver alias to the canonical auth policy id. */
export function resolveAuthProviderId(id: string): string {
	return AUTH_DEFINITION_ALIASES[id] ?? id;
}
