//! Search-provider credential modes and deterministic lease precedence.

/// Search authentication tiers supported by the combined daemon authority.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, strum::Display)]
#[strum(serialize_all = "kebab-case")]
pub enum SearchCredentialMode {
	/// Browser-session cookies held only by the authority.
	Cookie,
	/// Refreshable OAuth access.
	Oauth,
	/// Provider API key.
	ApiKey,
	/// `OpenRouter` gateway credential.
	OpenRouter,
	/// Explicitly borrowed short-lived desktop or broker token.
	BorrowedToken,
	/// Ephemeral anonymous provider session.
	Anonymous,
}

/// Perplexity credential ladder.
pub const PERPLEXITY_LADDER: [SearchCredentialMode; 6] = [
	SearchCredentialMode::Cookie,
	SearchCredentialMode::Oauth,
	SearchCredentialMode::ApiKey,
	SearchCredentialMode::OpenRouter,
	SearchCredentialMode::BorrowedToken,
	SearchCredentialMode::Anonymous,
];

/// Normal API-provider ladder with borrowed credentials after persisted
/// authority-owned credentials and no anonymous admission.
pub const API_PROVIDER_LADDER: [SearchCredentialMode; 3] =
	[SearchCredentialMode::Oauth, SearchCredentialMode::ApiKey, SearchCredentialMode::BorrowedToken];

/// Selects the first available mode without exposing credential values.
pub fn select_search_credential(
	ladder: &[SearchCredentialMode],
	mut available: impl FnMut(SearchCredentialMode) -> bool,
) -> Option<SearchCredentialMode> {
	ladder.iter().copied().find(|mode| available(*mode))
}

/// Whether a provider is eligible for automatic fallback. Anonymous and
/// keyless modes remain explicit-only unless the provider opts into auto.
pub fn automatically_available(
	selected: Option<SearchCredentialMode>,
	allow_anonymous: bool,
) -> bool {
	selected.is_some_and(|mode| mode != SearchCredentialMode::Anonymous || allow_anonymous)
}
