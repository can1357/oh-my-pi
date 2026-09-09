//! Standalone hosted-search portfolio without conflating chat tool intent.

use std::sync::Arc;

use omp_core::Str;

use super::search::HostedSearchIntent;
use crate::call::HostedTool;

/// Provider families capable of executing hosted web search.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, strum::Display, strum::EnumString)]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum HostedSearchProvider {
	/// Anthropic server-side web-search tool.
	Anthropic,
	/// Gemini grounding with Google Search.
	Gemini,
	/// `OpenAI` Codex Responses web search.
	Codex,
	/// xAI server-side web search.
	Xai,
	/// Kimi Code Search.
	Kimi,
	/// Z.AI MCP-backed web search.
	Zai,
	/// A model selected from the synthetic search registry.
	Synthetic,
}

/// Standalone hosted-search selection handed to the provider route.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostedSearchRequest {
	/// Concrete provider family.
	pub provider: HostedSearchProvider,
	/// User query supplied to the hosted search turn.
	pub query:    Str,
	/// Validated hosted-tool constraints.
	pub intent:   HostedSearchIntent,
	/// Optional concrete model override for synthetic and hosted routes.
	pub model:    Option<Str>,
}

/// Builds a dedicated hosted-search request. The returned value is not a chat
/// request and therefore cannot accidentally inherit the user's chat tool
/// choice or conversation.
pub fn prepare_hosted_search(
	provider: HostedSearchProvider,
	query: Str,
	allowed_domains: Arc<[Str]>,
	model: Option<Str>,
) -> Result<HostedSearchRequest, HostedSearchError> {
	if query.trim().is_empty() {
		return Err(HostedSearchError::EmptyQuery);
	}
	if matches!(provider, HostedSearchProvider::Synthetic)
		&& model.as_ref().is_none_or(|model| model.trim().is_empty())
	{
		return Err(HostedSearchError::SyntheticModelRequired);
	}
	let tool =
		HostedTool::WebSearch { allowed_domains, blocked_domains: Arc::new([]), recency_days: None };
	let intent = HostedSearchIntent::from_tool(&tool)
		.map_err(|_| HostedSearchError::InvalidDomains)?
		.ok_or(HostedSearchError::InvalidDomains)?;
	Ok(HostedSearchRequest { provider, query, intent, model })
}

/// Invalid standalone hosted-search selection.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum HostedSearchError {
	/// Search query is empty.
	#[error("hosted search query is empty")]
	EmptyQuery,
	/// Domain constraints are invalid.
	#[error("hosted search domain constraints are invalid")]
	InvalidDomains,
	/// Synthetic search requires an explicit model.
	#[error("synthetic hosted search requires a model")]
	SyntheticModelRequired,
}
