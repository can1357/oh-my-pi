//! Canonical web-search tool over an application-owned inference backend.

use std::{fmt::Write as _, sync::Arc};

use async_stream::stream;
use bytes::Bytes;
use futures::Stream;
use omp_core::{Str, sf};
use omp_proto::inference::v1::{self as pb, search_request};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, ArgPath, CallOutcome, CommitError, Constraint, Diag, DiagKind,
	Effects, Ev, ExecEffects, IncomingParams, InferenceEffects, LiftedCall, ParamError, Part,
	PromptCaps, RecordedCall, Rev, Tool, ToolSpec, ToolTerminal, Usd,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Arguments accepted by `web_search@2`.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Google-style search query.
	pub query:              Str,
	/// Optional recency window: `day`, `week`, `month`, or `year`.
	#[serde(default)]
	pub recency:            Option<Recency>,
	/// Maximum results returned to the caller.
	#[serde(default)]
	#[schemars(range(min = 1, max = 100))]
	pub limit:              Option<u32>,
	/// Inclusive publication-date lower bound.
	#[serde(default)]
	pub after:              Option<Str>,
	/// Exclusive publication-date upper bound.
	#[serde(default)]
	pub before:             Option<Str>,
	/// Domains results may come from.
	#[serde(default)]
	pub allowed_domains:    Vec<Str>,
	/// Domains results must not come from.
	#[serde(default)]
	pub excluded_domains:   Vec<Str>,
	/// ISO 3166-1 alpha-2 country hint.
	#[serde(default)]
	pub country:            Option<Str>,
	/// ISO 639-1 language hint.
	#[serde(default)]
	pub language:           Option<Str>,
	/// Maximum tokens in a synthesized answer.
	#[serde(default)]
	#[schemars(range(min = 1, max = 131_072))]
	pub max_tokens:         Option<u32>,
	/// Synthesis sampling temperature.
	#[serde(default)]
	#[schemars(range(min = 0.0, max = 2.0))]
	pub temperature:        Option<f64>,
	/// Provider retrieval count when distinct from `limit`.
	#[serde(default)]
	#[schemars(range(min = 1, max = 100))]
	pub num_search_results: Option<u32>,
	/// Explicit provider selection; omitted or `auto` walks configured
	/// providers.
	#[serde(default)]
	pub provider:           Option<Provider>,
	/// Per-provider deadline in milliseconds.
	#[serde(default)]
	#[schemars(range(min = 1, max = 300_000))]
	pub timeout_ms:         Option<u32>,
}

/// Supported relative recency windows.
#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Recency {
	/// Previous day.
	Day,
	/// Previous week.
	Week,
	/// Previous month.
	Month,
	/// Previous year.
	Year,
}

/// Search provider names exposed by the stable tool contract.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	JsonSchema,
	PartialEq,
	Eq,
	Serialize,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum Provider {
	/// Walk the configured provider chain.
	Auto,
	/// Perplexity search.
	Perplexity,
	/// Gemini grounded search.
	Gemini,
	/// Anthropic hosted search.
	Anthropic,
	/// `OpenAI` Codex hosted search.
	Codex,
	/// xAI hosted search.
	Xai,
	/// Z.AI search.
	Zai,
	/// Exa search.
	Exa,
	/// `TinyFish` search.
	Tinyfish,
	/// Jina search.
	Jina,
	/// Kagi search.
	Kagi,
	/// Tavily search.
	Tavily,
	/// Firecrawl search.
	Firecrawl,
	/// Brave search.
	Brave,
	/// Kimi search.
	Kimi,
	/// Parallel search.
	Parallel,
	/// Synthetic search.
	Synthetic,
	/// Self-hosted `SearXNG`.
	Searxng,
	/// Startpage search.
	Startpage,
	/// `DuckDuckGo` search.
	Duckduckgo,
	/// Ecosia search.
	Ecosia,
	/// Google search.
	Google,
	/// Mojeek search.
	Mojeek,
	/// Consolidated credential-free search.
	Public,
}

/// Lossless canonical search response.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Payload {
	/// Canonical response returned by the inference facade.
	pub response: pb::SearchResponse,
}

/// Web search does not stream partial tool updates.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Update {}

/// Stable, redacted backend failure class.
#[derive(
	Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, strum::Display, strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum BackendErrorKind {
	/// The caller cancelled the request.
	Cancelled,
	/// The provider attempt exceeded its deadline.
	Timeout,
	/// Credentials were missing or rejected.
	Authentication,
	/// The credential lacks required access.
	Permission,
	/// Provider quota or rate limits rejected the request.
	RateLimited,
	/// The request shape was invalid.
	InvalidRequest,
	/// No configured provider could serve the request.
	Unavailable,
	/// A provider returned a protocol or service failure.
	Provider,
}

/// Stable backend failure safe to project to the model.
///
/// Provider response bodies and credential diagnostics never cross this
/// boundary. `code` is an owner-authored stable identifier, not upstream text.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BackendError {
	/// Coarse machine-readable class.
	pub kind:   BackendErrorKind,
	/// Stable secret-free identifier.
	pub code:   Str,
	/// Optional HTTP status when the serving owner can safely report it.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub status: Option<u16>,
}

/// Search invocation failure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
	/// The application-owned inference backend rejected or failed the request.
	#[error("web search failed ({category}: {code})")]
	Search {
		/// Provider selected explicitly for the failed attempt, when known.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		provider: Option<Provider>,
		/// Coarse machine-readable class.
		category: BackendErrorKind,
		/// Stable owner-authored identifier.
		code:     Str,
		/// Optional safe HTTP status.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		status:   Option<u16>,
	},
}

/// Application-owned canonical search execution boundary.
///
/// Implementations must route through the one production inference facade;
/// tools never construct providers, credentials, or fallback registries.
pub trait SearchBackend: Send + Sync + 'static {
	/// Executes one canonical protobuf request.
	fn search(
		&self,
		request: pb::SearchRequest,
	) -> impl Future<Output = Result<pb::SearchResponse, BackendError>> + Send + '_;
}

/// Versioned `web_search` executor.
pub struct WebSearch<B> {
	backend: Arc<B>,
	spec:    ToolSpec,
}

/// Creates `web_search@2` over an application-owned inference backend.
pub fn tool<B: SearchBackend>(backend: Arc<B>) -> WebSearch<B> {
	WebSearch {
		backend,
		spec: ToolSpec {
			name:            sf!("web_search"),
			rev:             Rev { family: Default::default(), n: 2 },
			description:     sf!(
				"Searches the web through configured providers. Supports Google-style query \
				 directives, ordered automatic fallback, or an explicit provider pin."
			),
			schema:          omp_tool::schema::<Params>(),
			constraint:      Constraint::Schema {
				priority:       100,
				on_unsupported: omp_tool::Fallback::Unspecified,
			},
			effects:         Effects {
				documents: None,
				exec:      Some(ExecEffects { network: true, commands: Arc::default() }),
				inference: Some(InferenceEffects {
					max_requests: 1,
					max_usd:      Usd::from_nanos(u64::MAX),
				}),
				desktop:   None,
				subagents: 0,
			},
			projection_code: omp_tool::native_projection_code(
				env!("CARGO_PKG_NAME"),
				env!("CARGO_PKG_VERSION"),
				include_bytes!("web_search.rs"),
			)
			.into(),
		},
	}
}

impl<B: SearchBackend> Tool for WebSearch<B> {
	type Fault = Fault;
	type Params = Params;
	type Payload = Payload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Update, Payload, Fault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<Params>().await {
				Ok(value) => value,
				Err(error) => { yield param_event(error); return; }
			};
			if let Err(issue) = validate(&params) {
				yield Ev::Args(issue);
				return;
			}
			if let Err(error) = incoming.interruptable().committed().await {
				yield commit_event(error);
				return;
			}
			let provider = params.provider;
			let request = into_request(params);
			let result = match self.backend.search(request).await {
				Ok(response) => {
					for warning in &response.warnings {
						yield Ev::Diag(Diag::warn(
							DiagKind::ProviderWarning,
							Str::from(warning.as_str()),
						));
					}
					Ok(Payload { response })
				},
				Err(error) if error.kind == BackendErrorKind::Cancelled => {
					yield Ev::Aborted(Abort::Interrupted { reason: sf!("web search cancelled") });
					return;
				},
				Err(error) => Err(Fault::Search {
					provider,
					category: error.kind,
					code: error.code,
					status: error.status,
				}),
			};
			yield Ev::Done(ToolTerminal::Done { result, useless: false });
		}
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, caps: &PromptCaps) -> Vec<Part> {
		let text = match view {
			Ok(payload) => render_response(&payload.response),
			Err(fault) => fault.to_string(),
		};
		(caps.maximum_parts != 0 && caps.maximum_text_bytes != 0 && !text.is_empty())
			.then(|| Part::Text { text: Str::new(text) })
			.into_iter()
			.collect()
	}

	fn lift(&self, from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
		lift_rev1(from, call)
	}
}

const MAX_QUERY_BYTES: usize = 16 * 1024;
const MAX_DOMAINS: usize = 64;
const MAX_DOMAIN_BYTES: usize = 253;

fn validate(params: &Params) -> Result<(), ArgIssue> {
	if params.query.trim().is_empty() || params.query.len() > MAX_QUERY_BYTES {
		return Err(argument_issue("query", "a non-empty Google-style query no larger than 16 KiB"));
	}
	if params
		.limit
		.is_some_and(|limit| !(1..=100).contains(&limit))
	{
		return Err(argument_issue("limit", "an integer from 1 through 100"));
	}
	if params
		.max_tokens
		.is_some_and(|tokens| !(1..=131_072).contains(&tokens))
	{
		return Err(argument_issue("max_tokens", "an integer from 1 through 131072"));
	}
	if params
		.num_search_results
		.is_some_and(|results| !(1..=100).contains(&results))
	{
		return Err(argument_issue("num_search_results", "an integer from 1 through 100"));
	}
	if params
		.temperature
		.is_some_and(|temperature| !temperature.is_finite() || !(0.0..=2.0).contains(&temperature))
	{
		return Err(argument_issue("temperature", "a finite number from 0 through 2"));
	}
	if params
		.timeout_ms
		.is_some_and(|timeout| !(1..=300_000).contains(&timeout))
	{
		return Err(argument_issue("timeout_ms", "an integer from 1 through 300000"));
	}
	let domain_count = params.allowed_domains.len() + params.excluded_domains.len();
	if domain_count > MAX_DOMAINS
		|| params
			.allowed_domains
			.iter()
			.chain(&params.excluded_domains)
			.any(|domain| domain.trim().is_empty() || domain.len() > MAX_DOMAIN_BYTES)
	{
		return Err(argument_issue(
			"allowed_domains",
			"at most 64 non-empty domain names, each no larger than 253 bytes",
		));
	}
	Ok(())
}

fn argument_issue(key: &'static str, expected: &'static str) -> ArgIssue {
	ArgIssue {
		path:     vec![ArgPath::Key(Str::new_static(key))],
		expected: Str::new_static(expected),
		kind:     ArgIssueKind::Malformed,
		example:  None,
		found:    None,
	}
}

fn into_request(params: Params) -> pb::SearchRequest {
	let engine = params
		.provider
		.filter(|provider| *provider != Provider::Auto)
		.map_or_else(String::new, |provider| <&'static str>::from(provider).to_owned());
	pb::SearchRequest {
		query: params.query.to_string(),
		limit: params.limit.unwrap_or(0),
		recency: params.recency.map_or(0, |recency| match recency {
			Recency::Day => search_request::Recency::Day as i32,
			Recency::Week => search_request::Recency::Week as i32,
			Recency::Month => search_request::Recency::Month as i32,
			Recency::Year => search_request::Recency::Year as i32,
		}),
		after: params.after.map_or_else(String::new, String::from),
		before: params.before.map_or_else(String::new, String::from),
		allowed_domains: params
			.allowed_domains
			.into_iter()
			.map(String::from)
			.collect(),
		excluded_domains: params
			.excluded_domains
			.into_iter()
			.map(String::from)
			.collect(),
		country: params.country.map_or_else(String::new, String::from),
		language: params.language.map_or_else(String::new, String::from),
		engine,
		timeout_ms: params.timeout_ms.unwrap_or(0),
		max_tokens: params.max_tokens.unwrap_or(0),
		temperature: params.temperature,
		num_search_results: params.num_search_results.unwrap_or(0),
		..Default::default()
	}
}

fn render_response(response: &pb::SearchResponse) -> String {
	let mut output = String::new();
	if !response.engine.is_empty() {
		let _ = writeln!(output, "Provider: {}", response.engine);
	}
	if !response.answer.is_empty() {
		if !output.is_empty() {
			output.push('\n');
		}
		output.push_str(&response.answer);
		output.push('\n');
	}
	if !response.sources.is_empty() {
		let _ = write!(output, "\n## Sources\n{} source", response.sources.len());
		if response.sources.len() != 1 {
			output.push('s');
		}
		output.push('\n');
		for (index, source) in response.sources.iter().enumerate() {
			let title = if source.title.trim().is_empty() {
				source.url.as_str()
			} else {
				source.title.as_str()
			};
			let _ = writeln!(output, "[{}] {title}\n    {}", index + 1, source.url);
			if !source.snippet.is_empty() {
				let _ = writeln!(output, "    {}", source.snippet);
			}
		}
	}
	if !response.citations.is_empty() {
		let _ = write!(output, "\n## Citations\n{} citation", response.citations.len());
		if response.citations.len() != 1 {
			output.push('s');
		}
		output.push('\n');
		for (index, citation) in response.citations.iter().enumerate() {
			let title = if citation.title.trim().is_empty() {
				citation.url.as_str()
			} else {
				citation.title.as_str()
			};
			let _ = writeln!(output, "[{}] {title}\n    {}", index + 1, citation.url);
			if !citation.cited_text.is_empty() {
				let _ = writeln!(output, "    {}", citation.cited_text);
			}
		}
	}
	if !response.related.is_empty() {
		output.push_str("\n## Related\n");
		for question in &response.related {
			let _ = writeln!(output, "- {question}");
		}
	}
	if !response.search_queries.is_empty() {
		output.push_str("\n## Search queries\n");
		for query in &response.search_queries {
			let _ = writeln!(output, "- {query}");
		}
	}
	if !response.failures.is_empty() {
		output.push_str("\n## Earlier provider attempts\n");
		for failure in &response.failures {
			let kind = pb::search_response::failure::Kind::try_from(failure.kind)
				.unwrap_or(pb::search_response::failure::Kind::Unspecified)
				.as_str_name();
			let _ = write!(output, "- {}: {}", failure.provider, kind);
			if let Some(status) = failure.status {
				let _ = write!(output, " (HTTP {status})");
			}
			if !failure.code.is_empty() {
				let _ = write!(output, " [{}]", failure.code);
			}
			output.push('\n');
		}
	}
	output
}

fn lift_rev1(from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
	if !from.family.is_empty() || from.n != 1 {
		return None;
	}
	let mut raw_args = serde_json::from_slice::<serde_json::Value>(call.raw_args).ok()?;
	let object = raw_args.as_object_mut()?;
	object.remove("i");
	object.remove("notrunc");
	let params = serde_json::from_value::<Params>(raw_args).ok()?;
	validate(&params).ok()?;
	let previous = serde_json::from_slice::<CallOutcome<Payload, Rev1Fault>>(call.verdict).ok()?;
	let lifted = match previous {
		CallOutcome::Ok(payload) => CallOutcome::Ok(payload),
		CallOutcome::Faulted(Rev1Fault::Search { provider, code, .. }) => {
			let provider = provider.and_then(|provider| provider.parse().ok());
			CallOutcome::Faulted(Fault::Search {
				provider,
				category: classify_legacy_code(&code),
				code,
				status: None,
			})
		},
		CallOutcome::ArgsRejected(issue) => CallOutcome::ArgsRejected(issue),
		CallOutcome::Aborted { abort, kind, policy } => CallOutcome::Aborted { abort, kind, policy },
	};
	Some(LiftedCall {
		raw_args: Bytes::copy_from_slice(call.raw_args),
		verdict:  Bytes::from(serde_json::to_vec(&lifted).ok()?),
	})
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Rev1Fault {
	Search {
		#[serde(default)]
		provider: Option<Str>,
		code:     Str,
		#[serde(default, rename = "message")]
		_message: Option<Str>,
	},
}

fn classify_legacy_code(code: &str) -> BackendErrorKind {
	let code = code.to_ascii_lowercase();
	if code.contains("cancel") {
		BackendErrorKind::Cancelled
	} else if code.contains("deadline") || code.contains("timeout") {
		BackendErrorKind::Timeout
	} else if code.contains("auth") || code.contains("credential") {
		BackendErrorKind::Authentication
	} else if code.contains("permission") || code.contains("forbidden") {
		BackendErrorKind::Permission
	} else if code.contains("rate") || code.contains("quota") || code.contains("resource_exhausted")
	{
		BackendErrorKind::RateLimited
	} else if code.contains("argument") || code.contains("request") {
		BackendErrorKind::InvalidRequest
	} else if code.contains("unavailable") || code.contains("unbound") {
		BackendErrorKind::Unavailable
	} else {
		BackendErrorKind::Provider
	}
}

fn param_event(error: ParamError) -> Ev<Update, Payload, Fault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn commit_event(error: CommitError) -> Ev<Update, Payload, Fault> {
	match error {
		CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		CommitError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed JSON argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  Some(sf!(r#"{{"query":"rust async traits"}} "#)),
		found:    Some(message),
	}
}

#[cfg(test)]
mod tests {
	use futures::StreamExt as _;

	use super::*;

	struct WarningBackend;

	impl SearchBackend for WarningBackend {
		fn search(
			&self,
			_: pb::SearchRequest,
		) -> impl Future<Output = Result<pb::SearchResponse, BackendError>> + Send + '_ {
			std::future::ready(Ok(pb::SearchResponse {
				answer: sf!("result").to_string(),
				warnings: vec![sf!("a constraint was relaxed").to_string()],
				..Default::default()
			}))
		}
	}

	fn params() -> Params {
		Params {
			query:              sf!("rust tower"),
			recency:            None,
			limit:              None,
			after:              None,
			before:             None,
			allowed_domains:    Vec::new(),
			excluded_domains:   Vec::new(),
			country:            None,
			language:           None,
			max_tokens:         None,
			temperature:        None,
			num_search_results: None,
			provider:           None,
			timeout_ms:         None,
		}
	}

	#[test]
	fn schema_options_lift_losslessly_to_the_search_rpc() {
		let request = into_request(Params {
			query:              sf!(r#""tower Service" site:docs.rs"#),
			recency:            Some(Recency::Month),
			limit:              Some(7),
			after:              Some(sf!("2026-01-01")),
			before:             Some(sf!("2026-09-01")),
			allowed_domains:    vec![sf!("docs.rs")],
			excluded_domains:   vec![sf!("example.com")],
			country:            Some(sf!("US")),
			language:           Some(sf!("en")),
			max_tokens:         Some(2_048),
			temperature:        Some(0.2),
			num_search_results: Some(12),
			provider:           Some(Provider::Exa),
			timeout_ms:         Some(4_000),
		});
		assert_eq!(request.engine, "exa");
		assert_eq!(request.limit, 7);
		assert_eq!(request.recency, search_request::Recency::Month as i32);
		assert_eq!(request.after, "2026-01-01");
		assert_eq!(request.before, "2026-09-01");
		assert_eq!(request.allowed_domains, ["docs.rs"]);
		assert_eq!(request.excluded_domains, ["example.com"]);
		assert_eq!(request.country, "US");
		assert_eq!(request.language, "en");
		assert_eq!(request.max_tokens, 2_048);
		assert_eq!(request.temperature, Some(0.2));
		assert_eq!(request.num_search_results, 12);
		assert_eq!(request.timeout_ms, 4_000);
	}

	#[test]
	fn auto_provider_and_omitted_options_preserve_server_defaults() {
		let mut params = params();
		params.provider = Some(Provider::Auto);
		let request = into_request(params);
		assert!(request.engine.is_empty());
		assert_eq!(request.limit, 0);
		assert_eq!(request.timeout_ms, 0);
	}

	#[test]
	fn invocation_bounds_reject_before_execution_commit() {
		let mut invalid = params();
		invalid.limit = Some(0);
		assert_eq!(validate(&invalid).unwrap_err().path, vec![ArgPath::Key(sf!("limit"))]);
		invalid.limit = Some(1);
		invalid.temperature = Some(f64::NAN);
		assert_eq!(validate(&invalid).unwrap_err().path, vec![ArgPath::Key(sf!("temperature"))]);
	}

	#[test]
	fn rev1_fault_lift_discards_provider_diagnostics() {
		let raw_args = br#"{"query":"rust tower","provider":"exa"}"#;
		let verdict = br#"{"kind":"faulted","value":{"kind":"search","provider":"exa","code":"rate_limit","message":"secret upstream body"}}"#;
		let lifted =
			lift_rev1(&Rev { family: Default::default(), n: 1 }, RecordedCall { raw_args, verdict })
				.expect("rev1 call lifts");
		let outcome =
			serde_json::from_slice::<CallOutcome<Payload, Fault>>(&lifted.verdict).expect("outcome");
		let CallOutcome::Faulted(Fault::Search { category, code, .. }) = outcome else {
			panic!("fault expected");
		};
		assert_eq!(category, BackendErrorKind::RateLimited);
		assert_eq!(code, "rate_limit");
		assert!(!String::from_utf8_lossy(&lifted.verdict).contains("secret upstream body"));
	}

	#[tokio::test]
	async fn provider_warnings_are_emitted_as_diagnostics() {
		let search = tool(Arc::new(WarningBackend));
		let raw = r#"{"query":"rust tower"}"#;
		let (feed, incoming) = IncomingParams::channel();
		feed.arg_text(raw.into()).expect("stream args");
		feed.args_committed(raw.into()).expect("commit args");
		let events = search.call(incoming).collect::<Vec<_>>().await;
		assert!(matches!(events.as_slice(), [
			Ev::Diag(Diag { severity: omp_tool::Severity::Warn, .. }),
			Ev::Done(ToolTerminal::Done { result: Ok(_), .. })
		]));
		let Ev::Diag(diag) = &events[0] else {
			panic!("provider warning diagnostic");
		};
		assert_eq!(diag.native_kind(), Some(DiagKind::ProviderWarning));
		let Ev::Done(ToolTerminal::Done { result: Ok(payload), .. }) = &events[1] else {
			panic!("successful search result");
		};
		assert_eq!(render_response(&payload.response), "result\n");
	}

	#[test]
	fn prompt_projection_keeps_citations_queries_and_redacted_attempts() {
		let response = pb::SearchResponse {
			engine: sf!("exa").to_string(),
			answer: sf!("Tower is a service abstraction.").to_string(),
			sources: vec![pb::search_response::Source {
				url: sf!("https://docs.rs/tower").to_string(),
				title: sf!("Tower").to_string(),
				snippet: sf!("Async service abstractions.").to_string(),
				..Default::default()
			}],
			citations: vec![pb::search_response::Citation {
				url: sf!("https://docs.rs/tower").to_string(),
				title: sf!("Tower docs").to_string(),
				cited_text: sf!("Service abstraction").to_string(),
				..Default::default()
			}],
			search_queries: vec![sf!("tower rust").to_string()],
			related: vec![sf!("What is tower::Service?").to_string()],
			warnings: vec![sf!("a constraint was relaxed").to_string()],
			failures: vec![pb::search_response::Failure {
				provider: sf!("brave").to_string(),
				kind:     pb::search_response::failure::Kind::Timeout as i32,
				status:   Some(504),
				code:     sf!("deadline_exceeded").to_string(),
			}],
			..Default::default()
		};
		let rendered = render_response(&response);
		assert!(rendered.contains("## Sources"));
		assert!(rendered.contains("## Citations"));
		assert!(rendered.contains("## Related"));
		assert!(rendered.contains("## Search queries"));
		assert!(rendered.contains("Earlier provider attempts"));
		assert!(!rendered.contains("credential"));
	}
}
