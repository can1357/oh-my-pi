//! Typed web-search routing and provider convars.

use omp_con::Ctx;
use omp_core::Str;
use serde::{Deserialize, Serialize};
use strum::{EnumString, IntoStaticStr, VariantNames};
use url::Url;

/// Antigravity endpoint selection.
#[derive(Clone, Copy, Debug, Default, EnumString, Eq, IntoStaticStr, PartialEq, VariantNames)]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum AntigravityMode {
	/// Select the endpoint automatically.
	#[default]
	Auto,
	/// Use the production endpoint.
	Production,
	/// Use the sandbox endpoint.
	Sandbox,
}

omp_con::con_enum!(AntigravityMode);

/// Search provider routing and endpoint policy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct WebSearchSettings {
	/// Automatic provider preference order.
	pub order:                Vec<Str>,
	/// Providers omitted from automatic search.
	pub exclusions:           Vec<Str>,
	/// Per-provider attempt timeout in seconds.
	pub timeout_seconds:      u32,
	/// Optional self-hosted `SearXNG` endpoint.
	pub searxng_endpoint:     Option<Str>,
	/// Optional Gemini grounding model.
	pub gemini_model:         Option<Str>,
	/// Antigravity endpoint selection (`auto`, `production`, or `sandbox`).
	pub antigravity_mode:     Str,
	/// Whether Perplexity uses its Responses endpoint.
	pub perplexity_responses: bool,
}

/// Resolves a user-facing search engine name to its catalog provider key.
pub fn catalog_provider_name(name: &str) -> &str {
	match name {
		"google" => "google-search",
		_ => name,
	}
}

impl Default for WebSearchSettings {
	fn default() -> Self {
		Self {
			order:                default_order(),
			exclusions:           Vec::new(),
			timeout_seconds:      60,
			searxng_endpoint:     None,
			gemini_model:         None,
			antigravity_mode:     Str::new_static("auto"),
			perplexity_responses: false,
		}
	}
}

impl WebSearchSettings {
	/// Projects web-search routing from the control plane.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		let searxng_endpoint = AI_SEARCH_SEARXNG_ENDPOINT.get(ctx);
		let gemini_model = AI_SEARCH_GEMINI_MODEL.get(ctx);
		let mode: &'static str = AI_SEARCH_ANTIGRAVITY_MODE.get(ctx).into();
		Self {
			order:                AI_SEARCH_ORDER.get(ctx),
			exclusions:           AI_SEARCH_EXCLUSIONS.get(ctx),
			timeout_seconds:      AI_SEARCH_TIMEOUT_SECONDS.get(ctx),
			searxng_endpoint:     (!searxng_endpoint.is_empty()).then_some(searxng_endpoint),
			gemini_model:         (!gemini_model.is_empty()).then_some(gemini_model),
			antigravity_mode:     Str::new_static(mode),
			perplexity_responses: AI_SEARCH_PERPLEXITY_RESPONSES.get(ctx),
		}
	}

	/// Reports whether all cross-variable search policy invariants hold.
	#[must_use]
	pub fn validate(&self) -> bool {
		let unique = |values: &[Str]| {
			values.iter().all(|value| !value.is_empty())
				&& values
					.iter()
					.enumerate()
					.all(|(index, value)| values[..index].iter().all(|prior| prior != value))
		};
		let endpoint_valid = self.searxng_endpoint.as_deref().is_none_or(|endpoint| {
			Url::parse(endpoint).is_ok_and(|url| url.scheme() == "https" && url.host_str().is_some())
		});
		unique(&self.order)
			&& unique(&self.exclusions)
			&& (1..=300).contains(&self.timeout_seconds)
			&& matches!(self.antigravity_mode.as_str(), "auto" | "production" | "sandbox")
			&& endpoint_valid
	}
}

fn default_order() -> Vec<Str> {
	[
		"perplexity",
		"gemini",
		"anthropic",
		"codex",
		"xai",
		"zai",
		"exa",
		"tinyfish",
		"jina",
		"kagi",
		"tavily",
		"firecrawl",
		"brave",
		"kimi",
		"parallel",
		"synthetic",
		"searxng",
		"startpage",
		"duckduckgo",
		"ecosia",
		"google",
		"mojeek",
		"public",
	]
	.into_iter()
	.map(Str::new_static)
	.collect()
}

const fn invalid(reason: &'static str) -> Result<(), Str> {
	Err(Str::new_static(reason))
}

fn validate_unique(_: &Ctx, values: &Vec<Str>) -> Result<(), Str> {
	if values.iter().all(|value| !value.is_empty())
		&& values
			.iter()
			.enumerate()
			.all(|(index, value)| values[..index].iter().all(|prior| prior != value))
	{
		Ok(())
	} else {
		invalid("search provider lists require non-empty unique values")
	}
}

fn validate_searxng_endpoint(_: &Ctx, endpoint: &Str) -> Result<(), Str> {
	if endpoint.is_empty()
		|| Url::parse(endpoint).is_ok_and(|url| url.scheme() == "https" && url.host_str().is_some())
	{
		Ok(())
	} else {
		invalid("SearXNG endpoint must be empty or an HTTPS URL with a host")
	}
}

omp_con::var! {
	/// Prioritized providers for the web_search tool; unlisted providers retain their default order afterward
	pub static AI_SEARCH_ORDER = ai_search_order: Vec<Str> {
		default: default_order(),
		suggest: ["perplexity", "gemini", "anthropic", "codex", "xai", "zai", "exa", "tinyfish", "jina", "kagi", "tavily", "firecrawl", "brave", "kimi", "parallel", "synthetic", "searxng", "startpage", "duckduckgo", "ecosia", "google", "mojeek", "public"],
		validate: validate_unique,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Services",
			"ui.label": "Web Search Provider Order",
			"ui.ordered": "true",
			"ui.option.perplexity": "Perplexity",
			"ui.option.perplexity.desc": "Uses auth when configured; explicit selection falls back to anonymous search",
			"ui.option.gemini": "Gemini",
			"ui.option.gemini.desc": "Google Search grounding via Gemini (uses google-gemini-cli or google-antigravity OAuth)",
			"ui.option.anthropic": "Anthropic",
			"ui.option.anthropic.desc": "Claude's native web_search tool (uses Anthropic OAuth or ANTHROPIC_API_KEY)",
			"ui.option.codex": "OpenAI",
			"ui.option.codex.desc": "OpenAI's native web_search (uses ChatGPT OAuth via /login openai-codex)",
			"ui.option.xai": "xAI",
			"ui.option.xai.desc": "Grok web search via xAI Responses API (uses SuperGrok/X Premium+ OAuth via /login xai-oauth, or XAI_API_KEY)",
			"ui.option.zai": "Z.AI",
			"ui.option.zai.desc": "Calls Z.AI webSearchPrime MCP",
			"ui.option.exa": "Exa",
			"ui.option.exa.desc": "API via /login exa or EXA_API_KEY; explicit keyless fallback via MCP",
			"ui.option.tinyfish": "TinyFish",
			"ui.option.tinyfish.desc": "Requires TINYFISH_API_KEY",
			"ui.option.jina": "Jina",
			"ui.option.jina.desc": "Requires JINA_API_KEY",
			"ui.option.kagi": "Kagi",
			"ui.option.kagi.desc": "Requires KAGI_API_KEY and Kagi Search API beta access",
			"ui.option.tavily": "Tavily",
			"ui.option.tavily.desc": "Requires TAVILY_API_KEY",
			"ui.option.firecrawl": "Firecrawl",
			"ui.option.firecrawl.desc": "Uses Firecrawl API when FIRECRAWL_API_KEY is set; falls back to keyless mode",
			"ui.option.brave": "Brave",
			"ui.option.brave.desc": "Requires BRAVE_API_KEY",
			"ui.option.kimi": "Kimi",
			"ui.option.kimi.desc": "Kimi Code search (requires a Kimi Code Console key via KIMI_SEARCH_API_KEY/MOONSHOT_SEARCH_API_KEY or /login kimi-code; not MOONSHOT_API_KEY)",
			"ui.option.parallel": "Parallel",
			"ui.option.parallel.desc": "Requires PARALLEL_API_KEY",
			"ui.option.synthetic": "Synthetic",
			"ui.option.synthetic.desc": "Requires SYNTHETIC_API_KEY",
			"ui.option.searxng": "SearXNG",
			"ui.option.searxng.desc": "Requires SEARXNG_ENDPOINT or searxng.endpoint",
			"ui.option.startpage": "Startpage",
			"ui.option.startpage.desc": "Credential-free scrape of Startpage (Google-backed) results; may be bot-challenged",
			"ui.option.duckduckgo": "DuckDuckGo",
			"ui.option.duckduckgo.desc": "Credential-free best-effort fallback; may be bot-challenged on datacenter/shared-egress IPs",
			"ui.option.ecosia": "Ecosia",
			"ui.option.ecosia.desc": "Credential-free browser-backed scrape of Ecosia (Google-backed) results",
			"ui.option.google": "Google",
			"ui.option.google.desc": "Credential-free browser-backed fallback; slower and may be bot-challenged",
			"ui.option.mojeek": "Mojeek",
			"ui.option.mojeek.desc": "Credential-free browser-backed scrape of Mojeek's independent index",
			"ui.option.public": "Public Web",
			"ui.option.public.desc": "Queries every credential-free engine in parallel and consolidates deduplicated results",
			"legacy.path": "providers.webSearchOrder",
			"legacy.path": "web_search.order",
		},
	};
	/// Providers that web_search should never use, even as fallbacks
	pub static AI_SEARCH_EXCLUSIONS = ai_search_exclusions: Vec<Str> {
		default: Vec::new(),
		suggest: ["perplexity", "gemini", "anthropic", "codex", "xai", "zai", "exa", "tinyfish", "jina", "kagi", "tavily", "firecrawl", "brave", "kimi", "parallel", "synthetic", "searxng", "startpage", "duckduckgo", "ecosia", "google", "mojeek", "public"],
		validate: validate_unique,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Services",
			"ui.label": "Excluded Web Search Providers",
			"ui.option.perplexity": "Perplexity",
			"ui.option.perplexity.desc": "Uses auth when configured; explicit selection falls back to anonymous search",
			"ui.option.gemini": "Gemini",
			"ui.option.gemini.desc": "Google Search grounding via Gemini (uses google-gemini-cli or google-antigravity OAuth)",
			"ui.option.anthropic": "Anthropic",
			"ui.option.anthropic.desc": "Claude's native web_search tool (uses Anthropic OAuth or ANTHROPIC_API_KEY)",
			"ui.option.codex": "OpenAI",
			"ui.option.codex.desc": "OpenAI's native web_search (uses ChatGPT OAuth via /login openai-codex)",
			"ui.option.xai": "xAI",
			"ui.option.xai.desc": "Grok web search via xAI Responses API (uses SuperGrok/X Premium+ OAuth via /login xai-oauth, or XAI_API_KEY)",
			"ui.option.zai": "Z.AI",
			"ui.option.zai.desc": "Calls Z.AI webSearchPrime MCP",
			"ui.option.exa": "Exa",
			"ui.option.exa.desc": "API via /login exa or EXA_API_KEY; explicit keyless fallback via MCP",
			"ui.option.tinyfish": "TinyFish",
			"ui.option.tinyfish.desc": "Requires TINYFISH_API_KEY",
			"ui.option.jina": "Jina",
			"ui.option.jina.desc": "Requires JINA_API_KEY",
			"ui.option.kagi": "Kagi",
			"ui.option.kagi.desc": "Requires KAGI_API_KEY and Kagi Search API beta access",
			"ui.option.tavily": "Tavily",
			"ui.option.tavily.desc": "Requires TAVILY_API_KEY",
			"ui.option.firecrawl": "Firecrawl",
			"ui.option.firecrawl.desc": "Uses Firecrawl API when FIRECRAWL_API_KEY is set; falls back to keyless mode",
			"ui.option.brave": "Brave",
			"ui.option.brave.desc": "Requires BRAVE_API_KEY",
			"ui.option.kimi": "Kimi",
			"ui.option.kimi.desc": "Kimi Code search (requires a Kimi Code Console key via KIMI_SEARCH_API_KEY/MOONSHOT_SEARCH_API_KEY or /login kimi-code; not MOONSHOT_API_KEY)",
			"ui.option.parallel": "Parallel",
			"ui.option.parallel.desc": "Requires PARALLEL_API_KEY",
			"ui.option.synthetic": "Synthetic",
			"ui.option.synthetic.desc": "Requires SYNTHETIC_API_KEY",
			"ui.option.searxng": "SearXNG",
			"ui.option.searxng.desc": "Requires SEARXNG_ENDPOINT or searxng.endpoint",
			"ui.option.startpage": "Startpage",
			"ui.option.startpage.desc": "Credential-free scrape of Startpage (Google-backed) results; may be bot-challenged",
			"ui.option.duckduckgo": "DuckDuckGo",
			"ui.option.duckduckgo.desc": "Credential-free best-effort fallback; may be bot-challenged on datacenter/shared-egress IPs",
			"ui.option.ecosia": "Ecosia",
			"ui.option.ecosia.desc": "Credential-free browser-backed scrape of Ecosia (Google-backed) results",
			"ui.option.google": "Google",
			"ui.option.google.desc": "Credential-free browser-backed fallback; slower and may be bot-challenged",
			"ui.option.mojeek": "Mojeek",
			"ui.option.mojeek.desc": "Credential-free browser-backed scrape of Mojeek's independent index",
			"ui.option.public": "Public Web",
			"ui.option.public.desc": "Queries every credential-free engine in parallel and consolidates deduplicated results",
			"legacy.path": "providers.webSearchExclude",
			"legacy.path": "web_search.exclusions",
		},
	};
	/// Hard timeout for each provider's search transport before web_search advances to the next fallback, in seconds (maximum 300)
	pub static AI_SEARCH_TIMEOUT_SECONDS = ai_search_timeout_seconds: u32 {
		default: 60,
		min: 1,
		max: 300,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Services",
			"ui.label": "Web Search Timeout",
			"ui.unit": "s",
			"ui.option.30": "30 seconds",
			"ui.option.60": "1 minute",
			"ui.option.120": "2 minutes",
			"ui.option.180": "3 minutes",
			"ui.option.300": "5 minutes",
			"legacy.path": "providers.webSearchTimeoutSeconds",
			"legacy.path": "web_search.timeout_seconds",
		},
	};
	/// Base URL of a self-hosted SearXNG instance used for web search
	pub static AI_SEARCH_SEARXNG_ENDPOINT = ai_search_searxng_endpoint: Str {
		default: Str::new_static(""),
		validate: validate_searxng_endpoint,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Services",
			"ui.label": "SearXNG Endpoint",
			"legacy.path": "searxng.endpoint",
			"legacy.path": "web_search.searxng_endpoint",
		},
	};
	/// Model ID for Gemini Google Search grounding. Defaults to gemini-2.5-flash.
	pub static AI_SEARCH_GEMINI_MODEL = ai_search_gemini_model: Str {
		default: Str::new_static(""),
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Services",
			"ui.label": "Gemini web_search model",
			"legacy.path": "providers.webSearchGeminiModel",
			"legacy.path": "web_search.gemini_model",
		},
	};
	/// Endpoint routing strategy for google-antigravity providers (chat, search, image, discovery)
	pub static AI_SEARCH_ANTIGRAVITY_MODE = ai_search_antigravity_mode: AntigravityMode {
		default: AntigravityMode::Auto,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Services",
			"ui.label": "Antigravity Endpoint Mode",
			"ui.option.auto": "Auto",
			"ui.option.auto.desc": "Try production endpoint, fail over to sandbox on 5xx/429",
			"ui.option.production": "Production Only",
			"ui.option.production.desc": "Force production endpoint only",
			"ui.option.sandbox": "Sandbox Only",
			"ui.option.sandbox.desc": "Force sandbox endpoint only",
			"legacy.path": "providers.antigravityEndpoint",
			"legacy.path": "web_search.antigravity_mode",
		},
	};
	/// Use the Perplexity Responses endpoint.
	pub static AI_SEARCH_PERPLEXITY_RESPONSES = ai_search_perplexity_responses: bool {
		default: false,
		flags: archive,
		meta: {
			"legacy.path": "web_search.perplexity_responses",
		},
	};
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn projection_reads_ctx_and_rejects_invalid_timeout() {
		let ctx = Ctx::new();
		AI_SEARCH_TIMEOUT_SECONDS
			.set(&ctx, 42)
			.expect("set search timeout");
		let projected = WebSearchSettings::from_con(&ctx);
		assert_eq!(projected.timeout_seconds, 42);
		assert!(projected.validate());
		assert!(!WebSearchSettings { timeout_seconds: 301, ..Default::default() }.validate());
	}
}
