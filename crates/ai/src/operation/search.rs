//! Standalone search negotiation, deterministic ranking, and hosted-search
//! intent handoff.

use std::{
	cmp::Ordering,
	future::Future,
	sync::Arc,
	task::{Context, Poll},
	time::{Duration, SystemTime},
};

use omp_core::{Str, sf};
use tower::Service;

use crate::{
	answer::{Answer, AnswerBody, SearchMetadata, SearchResult, SearchResults},
	body::{AttemptBodyEvidence, RetryDecision},
	call::{
		Call, EmulationPolicy, HostedTool, MismatchPolicy, OperationCall, SearchRecency,
		SearchRequest, Setting,
	},
	catalog::{Emulation, OperationKind, SearchCapabilities, SearchFeatureBits},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	operation::{
		OperationRequest, OperationResponse,
		search_query::{SearchQuery, parse_date_value},
	},
	receipt::{Adjustment, ExecutionReceipt, FeatureId, ReasonId, Usage, UsageSource},
};

/// Provider search document before canonical filtering and rank assignment.
#[derive(Clone, Debug, PartialEq)]
pub struct SearchDocument {
	/// Result URL.
	pub url:          Str,
	/// Result title.
	pub title:        Str,
	/// Optional provider snippet.
	pub snippet:      Option<Str>,
	/// Optional relevance score; larger values rank first.
	pub score:        Option<f32>,
	/// Publication time when known.
	pub published_at: Option<SystemTime>,
	/// BCP-47 locale of the document when known.
	pub locale:       Option<Str>,
}

/// Typed backend page retained until operation policy has filtered and ranked
/// it.
#[derive(Clone, Debug, PartialEq)]
pub struct SearchPage {
	/// Candidate documents in provider order.
	pub documents: Vec<SearchDocument>,
	/// Optional provider-generated answer synthesis.
	pub answer:    Option<Str>,
	/// Search usage reported by the backend.
	pub usage:     Usage,
}

/// Canonical hosted-search intent handed to a chat codec, never executed as
/// standalone search.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostedSearchIntent {
	/// Domains the hosted tool may search.
	pub allowed_domains: Arc<[Str]>,
	/// Domains the hosted tool must not search.
	pub blocked_domains: Arc<[Str]>,
	/// Maximum result age in days.
	pub recency_days:    Option<u32>,
}

impl HostedSearchIntent {
	/// Extracts and validates hosted-search intent without conflating it with
	/// [`SearchRequest`].
	pub fn from_tool(tool: &HostedTool) -> Result<Option<Self>, Error> {
		let HostedTool::WebSearch { allowed_domains, blocked_domains, recency_days } = tool else {
			return Ok(None);
		};
		for domain in allowed_domains.iter().chain(blocked_domains.iter()) {
			validate_domain(domain)?;
		}
		if allowed_domains.iter().any(|allowed| {
			blocked_domains
				.iter()
				.any(|blocked| domain_eq(allowed, blocked))
		}) {
			return Err(request_error("hosted_search.domains", "domain_both_allowed_and_blocked"));
		}
		if *recency_days == Some(0) {
			return Err(request_error("hosted_search.recency", "zero_day_recency"));
		}
		Ok(Some(Self {
			allowed_domains: Arc::clone(allowed_domains),
			blocked_domains: Arc::clone(blocked_domains),
			recency_days:    *recency_days,
		}))
	}
}

/// Concrete standalone-search service over one constructed route backend.
#[derive(Clone, Debug)]
pub struct SearchService<S> {
	inner:        S,
	capabilities: SearchCapabilities,
	clock:        fn() -> SystemTime,
}

impl<S> SearchService<S> {
	/// Constructs a service using the system wall clock for recency filtering.
	pub fn new(inner: S, capabilities: SearchCapabilities) -> Result<Self, Error> {
		if capabilities.maximum_results == Some(0) {
			return Err(planning_error(
				"search.maximum_results",
				"search_service_has_zero_result_capacity",
			));
		}
		Ok(Self { inner, capabilities, clock: SystemTime::now })
	}

	/// Overrides the wall clock, primarily for deterministic replay tests.
	pub fn with_clock(mut self, clock: fn() -> SystemTime) -> Self {
		self.clock = clock;
		self
	}

	/// Negotiates native and lossless post-filtered controls before execution.
	pub fn plan(&self, request: &SearchRequest) -> Result<SearchPlan, Error> {
		plan_search(request, self.capabilities, (self.clock)())
	}
}

/// Negotiated standalone-search execution and post-filter plan.
#[derive(Clone, Debug)]
pub struct SearchPlan {
	backend_request: Arc<SearchRequest>,
	filter_request:  Arc<SearchRequest>,
	now:             SystemTime,
	adjustments:     Vec<Adjustment>,
	require_answer:  bool,
	strip_answer:    bool,
}

impl SearchPlan {
	/// Returns the request partition containing only controls handled by the
	/// backend.
	pub(crate) fn backend_request(&self) -> Arc<SearchRequest> {
		Arc::clone(&self.backend_request)
	}
}

impl<S> Service<Call> for SearchService<S>
where
	S: Service<
			OperationRequest<SearchRequest>,
			Response = OperationResponse<SearchPage>,
			Error = Error,
		>,
	S::Future: Send + 'static,
{
	type Error = Error;
	type Response = Answer;

	type Future = impl Future<Output = Result<Answer, Error>> + Send;

	fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		self.inner.poll_ready(context)
	}

	fn call(&mut self, call: Call) -> Self::Future {
		let prepared = match &call.operation {
			OperationCall::Search(request) => self.plan(request).map(|plan| {
				let backend = OperationRequest::from_call(&call, Arc::clone(&plan.backend_request));
				(plan, backend)
			}),
			_ => Err(wrong_operation(&call)),
		};
		let pending = prepared
			.as_ref()
			.ok()
			.map(|(_, request)| self.inner.call(request.clone()));
		async move {
			let (plan, _) = prepared?;
			let Some(pending) = pending else {
				return Err(request_error("search", "search_backend_not_called"));
			};
			let mut response = pending.await?;
			let mut results = finalize_search(&plan, response.output)?;
			results.metadata.provider = Some(response.meta.provider.clone());
			results.metadata.account = response
				.receipt
				.attempts
				.iter()
				.rev()
				.find_map(|attempt| attempt.account.clone());
			response.receipt.adjustments.extend(plan.adjustments);
			Ok(OperationResponse {
				meta:    response.meta,
				receipt: response.receipt,
				output:  results,
			}
			.into_answer(AnswerBody::Search))
		}
	}
}

/// Builds a deterministic execution plan and rejects every unsupported explicit
/// option.
pub fn plan_search(
	request: &SearchRequest,
	capabilities: SearchCapabilities,
	now: SystemTime,
) -> Result<SearchPlan, Error> {
	if request.query.trim().is_empty() {
		return Err(request_error("search.query", "empty_search_query"));
	}
	if request.max_results == 0 {
		return Err(request_error("search.max_results", "zero_search_results_requested"));
	}
	if request.retrieval_results == Some(0) {
		return Err(request_error("search.retrieval_results", "zero_search_retrieval_count"));
	}
	if request.max_output_tokens == Some(0) {
		return Err(request_error("search.max_output_tokens", "zero_search_output_tokens"));
	}
	if request.temperature.is_some_and(|value| !value.is_finite()) {
		return Err(request_error("search.temperature", "non_finite_search_temperature"));
	}
	if request.attempt_timeout.is_zero() || request.attempt_timeout > Duration::from_secs(300) {
		return Err(request_error("search.attempt_timeout", "search_timeout_out_of_range"));
	}
	for domain in request
		.include_domains
		.iter()
		.chain(request.exclude_domains.iter())
	{
		validate_domain(domain)?;
	}
	if request.include_domains.iter().any(|included| {
		request
			.exclude_domains
			.iter()
			.any(|excluded| domain_eq(included, excluded))
	}) {
		return Err(request_error("search.domains", "domain_both_included_and_excluded"));
	}
	if let Some(locale) = &request.locale {
		validate_locale(locale)?;
	}
	if matches!(request.recency, Some(SearchRecency::Days(0))) {
		return Err(request_error("search.recency", "zero_day_recency"));
	}

	let domains_native = capabilities.features.contains(SearchFeatureBits::DOMAINS);
	let recency_native = capabilities.features.contains(SearchFeatureBits::RECENCY);
	let locale_native = capabilities.features.contains(SearchFeatureBits::LOCALE);
	let mut adjustments = Vec::new();
	negotiate_filter(
		!request.include_domains.is_empty() || !request.exclude_domains.is_empty(),
		domains_native,
		"search.domains",
		request,
		&mut adjustments,
	)?;
	negotiate_filter(
		request.recency.is_some(),
		recency_native,
		"search.recency",
		request,
		&mut adjustments,
	)?;
	negotiate_filter(
		request.locale.is_some(),
		locale_native,
		"search.locale",
		request,
		&mut adjustments,
	)?;

	let synthesis_native = capabilities
		.features
		.contains(SearchFeatureBits::ANSWER_SYNTHESIS);
	let (require_answer, strip_answer, synthesis) = match request.synthesize_answer.clone() {
		Setting::Unset => (false, false, Setting::Unset),
		Setting::Require(false) | Setting::Prefer(false) => (false, true, Setting::Unset),
		Setting::Require(true) if synthesis_native => (true, false, Setting::Require(true)),
		Setting::Prefer(true) if synthesis_native => (false, false, Setting::Prefer(true)),
		Setting::Prefer(true)
			if request.negotiation.vendor_option_mismatch == MismatchPolicy::DropPreferred =>
		{
			adjustments.push(Adjustment::Dropped {
				feature: FeatureId(sf!("search.answer_synthesis")),
				reason:  ReasonId(sf!("answer_synthesis_unsupported")),
			});
			(false, true, Setting::Unset)
		},
		Setting::Require(true) | Setting::Prefer(true) => {
			return Err(planning_error("search.answer_synthesis", "answer_synthesis_unsupported"));
		},
	};

	let effective_max = capabilities
		.maximum_results
		.map_or(request.max_results, |maximum| request.max_results.min(u32::from(maximum)));
	if effective_max != request.max_results {
		adjustments.push(Adjustment::Substituted {
			feature: FeatureId(sf!("search.max_results")),
			from:    Str::new(request.max_results.to_string()),
			to:      Str::new(effective_max.to_string()),
		});
	}
	let mut filter = request.clone();
	filter.include_domains = if domains_native {
		Arc::new([])
	} else {
		Arc::clone(&request.include_domains)
	};
	filter.exclude_domains = if domains_native {
		Arc::new([])
	} else {
		Arc::clone(&request.exclude_domains)
	};
	filter.recency = (!recency_native).then_some(request.recency).flatten();
	filter.locale = (!locale_native).then(|| request.locale.clone()).flatten();
	filter.max_results = request.max_results;
	let filter_request = Arc::new(filter);

	let mut backend = request.clone();
	backend.include_domains = if domains_native {
		Arc::clone(&request.include_domains)
	} else {
		Arc::new([])
	};
	backend.exclude_domains = if domains_native {
		Arc::clone(&request.exclude_domains)
	} else {
		Arc::new([])
	};
	backend.recency = recency_native.then_some(request.recency).flatten();
	backend.locale = locale_native.then(|| request.locale.clone()).flatten();
	backend.max_results = effective_max;
	backend.synthesize_answer = synthesis;
	let backend_request = Arc::new(backend);
	Ok(SearchPlan {
		backend_request,
		filter_request,
		now,
		adjustments,
		require_answer,
		strip_answer,
	})
}

/// Filters and ranks one backend page into canonical output.
pub fn finalize_search(plan: &SearchPlan, mut page: SearchPage) -> Result<SearchResults, Error> {
	for document in &page.documents {
		if document.title.is_empty()
			|| url_host(&document.url).is_none()
			|| !(document.url.starts_with("https://") || document.url.starts_with("http://"))
		{
			return Err(protocol_error("search_result_invalid_url_or_title"));
		}
		if document.score.is_some_and(|score| !score.is_finite()) {
			return Err(protocol_error("search_result_score_non_finite"));
		}
	}
	let request = &plan.filter_request;
	let parsed = request.parsed_query.as_ref();
	let mut warnings = Vec::new();
	apply_dimension(
		&mut page.documents,
		&mut warnings,
		domain_label(&request.include_domains, &request.exclude_domains),
		|document| {
			matches_domain_filters(&document.url, &request.include_domains, &request.exclude_domains)
		},
	);
	apply_query_dimensions(&mut page.documents, parsed, &mut warnings);
	if let Some(locale) = request.locale.as_deref() {
		apply_dimension(
			&mut page.documents,
			&mut warnings,
			Some(Str::new(format!("language:{locale}"))),
			|document| matches_locale(document.locale.as_deref(), Some(locale)),
		);
	}
	if request.recency.is_some() {
		apply_dimension(&mut page.documents, &mut warnings, Some(sf!("recency")), |document| {
			matches_recency(document.published_at, request.recency, plan.now)
		});
	}
	page
		.documents
		.sort_by(|left, right| match (left.score, right.score) {
			(Some(left), Some(right)) => right.total_cmp(&left),
			(Some(_), None) => Ordering::Less,
			(None, Some(_)) => Ordering::Greater,
			(None, None) => Ordering::Equal,
		});
	page.documents.truncate(request.max_results as usize);
	if plan.require_answer && page.answer.is_none() {
		return Err(protocol_error("required_search_answer_missing"));
	}
	if plan.strip_answer {
		page.answer = None;
	}
	if page.usage.search_calls == 0 {
		page.usage.search_calls = 1;
		if page.usage.source == UsageSource::Unknown {
			page.usage.source = UsageSource::Measured;
		}
	}
	let results = page
		.documents
		.into_iter()
		.enumerate()
		.map(|(index, document)| SearchResult {
			rank:         index as u32 + 1,
			url:          document.url,
			title:        document.title,
			snippet:      document.snippet,
			score:        document.score,
			published_at: document.published_at,
			author:       None,
		})
		.collect();
	Ok(SearchResults {
		results,
		answer: page.answer,
		usage: page.usage,
		metadata: SearchMetadata { warnings, ..Default::default() },
	})
}

fn apply_query_dimensions(
	documents: &mut Vec<SearchDocument>,
	query: &SearchQuery,
	warnings: &mut Vec<Str>,
) {
	if !query.sites.is_empty() {
		let label = query
			.sites
			.iter()
			.map(|site| format!("site:{site}"))
			.collect::<Vec<_>>()
			.join(" OR ");
		apply_dimension(documents, warnings, Some(Str::new(label)), |document| {
			query
				.sites
				.iter()
				.any(|site| matches_site(&document.url, site))
		});
	}
	if !query.excluded_sites.is_empty() {
		let label = query
			.excluded_sites
			.iter()
			.map(|site| format!("-site:{site}"))
			.collect::<Vec<_>>()
			.join(" ");
		apply_dimension(documents, warnings, Some(Str::new(label)), |document| {
			!query
				.excluded_sites
				.iter()
				.any(|site| matches_site(&document.url, site))
		});
	}
	apply_text_dimension(documents, warnings, "inurl", &query.in_url, false, |document| {
		document.url.as_str()
	});
	apply_text_dimension(documents, warnings, "-inurl", &query.excluded_in_url, true, |document| {
		document.url.as_str()
	});
	apply_text_dimension(documents, warnings, "intitle", &query.in_title, false, |document| {
		document.title.as_str()
	});
	apply_text_dimension(
		documents,
		warnings,
		"-intitle",
		&query.excluded_in_title,
		true,
		|document| document.title.as_str(),
	);
	if !query.filetypes.is_empty() {
		let label = query
			.filetypes
			.iter()
			.map(|extension| format!("filetype:{extension}"))
			.collect::<Vec<_>>()
			.join(" OR ");
		apply_dimension(documents, warnings, Some(Str::new(label)), |document| {
			query
				.filetypes
				.iter()
				.any(|extension| matches_filetype(&document.url, extension))
		});
	}
	if !query.excluded_filetypes.is_empty() {
		let label = query
			.excluded_filetypes
			.iter()
			.map(|extension| format!("-filetype:{extension}"))
			.collect::<Vec<_>>()
			.join(" ");
		apply_dimension(documents, warnings, Some(Str::new(label)), |document| {
			!query
				.excluded_filetypes
				.iter()
				.any(|extension| matches_filetype(&document.url, extension))
		});
	}
	if query.after.is_some() || query.before.is_some() {
		let after = query.after.as_deref().and_then(iso_date_time);
		let before = query.before.as_deref().and_then(iso_date_time);
		let label = [
			query.after.as_ref().map(|date| format!("after:{date}")),
			query.before.as_ref().map(|date| format!("before:{date}")),
		]
		.into_iter()
		.flatten()
		.collect::<Vec<_>>()
		.join(" ");
		apply_dimension(documents, warnings, Some(Str::new(label)), |document| {
			let Some(published) = document.published_at else {
				return true;
			};
			after.is_none_or(|bound| published >= bound)
				&& before.is_none_or(|bound| published < bound)
		});
	}
}

fn apply_text_dimension(
	documents: &mut Vec<SearchDocument>,
	warnings: &mut Vec<Str>,
	name: &str,
	values: &[Str],
	excluded: bool,
	field: impl for<'a> Fn(&'a SearchDocument) -> &'a str,
) {
	if values.is_empty() {
		return;
	}
	let label = values
		.iter()
		.map(|value| format!("{name}:{value}"))
		.collect::<Vec<_>>()
		.join(" ");
	apply_dimension(documents, warnings, Some(Str::new(label)), |document| {
		let haystack = field(document);
		if excluded {
			!values
				.iter()
				.any(|value| contains_ascii_case_insensitive(haystack, value))
		} else {
			values
				.iter()
				.all(|value| contains_ascii_case_insensitive(haystack, value))
		}
	});
}

fn apply_dimension(
	documents: &mut Vec<SearchDocument>,
	warnings: &mut Vec<Str>,
	label: Option<Str>,
	matches: impl Fn(&SearchDocument) -> bool,
) {
	let Some(label) = label else {
		return;
	};
	if documents.is_empty() {
		return;
	}
	if documents.iter().any(&matches) {
		documents.retain(matches);
	} else {
		warnings.push(Str::new(format!("no results matched `{label}`; the constraint was relaxed")));
	}
}

fn domain_label(included: &[Str], excluded: &[Str]) -> Option<Str> {
	if included.is_empty() && excluded.is_empty() {
		return None;
	}
	let mut labels = included
		.iter()
		.map(|domain| format!("site:{domain}"))
		.collect::<Vec<_>>();
	labels.extend(excluded.iter().map(|domain| format!("-site:{domain}")));
	Some(Str::new(labels.join(" ")))
}

fn matches_site(url: &str, site: &str) -> bool {
	let Some(host) = url_host(url) else {
		return false;
	};
	let (site_host, site_path) = site.split_once('/').unwrap_or((site, ""));
	if !host_matches(host, site_host) {
		return false;
	}
	if site_path.is_empty() {
		return true;
	}
	let Some((_, rest)) = url.split_once("://") else {
		return false;
	};
	let path = rest.find('/').map_or("", |index| &rest[index + 1..]);
	path
		.get(..site_path.len())
		.is_some_and(|prefix| prefix.eq_ignore_ascii_case(site_path))
}

fn matches_filetype(url: &str, extension: &str) -> bool {
	let without_query = url.split(['?', '#']).next().unwrap_or(url);
	let suffix = format!(".{extension}");
	without_query
		.get(without_query.len().saturating_sub(suffix.len())..)
		.is_some_and(|ending| ending.eq_ignore_ascii_case(&suffix))
}

fn contains_ascii_case_insensitive(haystack: &str, needle: &str) -> bool {
	if needle.is_empty() {
		return true;
	}
	haystack
		.as_bytes()
		.windows(needle.len())
		.any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

fn iso_date_time(value: &str) -> Option<SystemTime> {
	let normalized = parse_date_value(value)?;
	let mut parts = normalized.as_str().split('-').map(str::parse::<i64>);
	let year = parts.next()?.ok()?;
	let month = parts.next()?.ok()?;
	let day = parts.next()?.ok()?;
	let year = year - i64::from(month <= 2);
	let era = if year >= 0 { year } else { year - 399 } / 400;
	let year_of_era = year - era * 400;
	let shifted_month = month + if month > 2 { -3 } else { 9 };
	let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
	let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
	let days = era * 146_097 + day_of_era - 719_468;
	let seconds = days.checked_mul(86_400)?;
	u64::try_from(seconds)
		.ok()
		.map(|seconds| SystemTime::UNIX_EPOCH + Duration::from_secs(seconds))
}

/// Returns whether route fallback is permitted by both the error and exact body
/// evidence.
pub fn fallback_allowed(error: &Error, body: AttemptBodyEvidence) -> bool {
	!error.committed
		&& error.kind != ErrorKind::Cancelled
		&& body.retry_decision == RetryDecision::Allow
		&& matches!(error.action, RetryAction::ReselectRoute)
}

fn negotiate_filter(
	requested: bool,
	native: bool,
	feature: &'static str,
	request: &SearchRequest,
	adjustments: &mut Vec<Adjustment>,
) -> Result<(), Error> {
	if !requested {
		return Ok(());
	}
	if native {
		adjustments.push(Adjustment::Native { feature: FeatureId(Str::new(feature)) });
		return Ok(());
	}
	if request.negotiation.emulation == EmulationPolicy::Forbid {
		return Err(planning_error(feature, "search_filter_requires_lossless_post_filter"));
	}
	adjustments.push(Adjustment::Emulated {
		feature: FeatureId(Str::new(feature)),
		method:  Emulation::ResponseTransform,
	});
	Ok(())
}

fn matches_domain_filters(url: &str, includes: &[Str], excludes: &[Str]) -> bool {
	let Some(host) = url_host(url) else {
		return false;
	};
	let included = includes.is_empty() || includes.iter().any(|domain| host_matches(host, domain));
	included && !excludes.iter().any(|domain| host_matches(host, domain))
}

fn url_host(url: &str) -> Option<&str> {
	let (_, rest) = url.split_once("://")?;
	let authority = rest.split(['/', '?', '#']).next()?;
	let host = authority
		.rsplit_once('@')
		.map_or(authority, |(_, host)| host);
	let host = host.split(':').next().unwrap_or(host);
	(!host.is_empty()).then_some(host)
}

fn host_matches(host: &str, domain: &str) -> bool {
	let domain = domain.trim_start_matches('.');
	let host_bytes = host.as_bytes();
	let domain_bytes = domain.as_bytes();
	host.eq_ignore_ascii_case(domain)
		|| host_bytes.len() > domain_bytes.len()
			&& host_bytes[host_bytes.len() - domain_bytes.len() - 1] == b'.'
			&& host_bytes[host_bytes.len() - domain_bytes.len()..].eq_ignore_ascii_case(domain_bytes)
}

fn matches_locale(actual: Option<&str>, requested: Option<&str>) -> bool {
	let Some(requested) = requested else {
		return true;
	};
	let Some(actual) = actual else { return false };
	actual.eq_ignore_ascii_case(requested)
		|| actual
			.split_once('-')
			.is_some_and(|(language, _)| language.eq_ignore_ascii_case(requested))
}

fn matches_recency(
	published_at: Option<SystemTime>,
	recency: Option<SearchRecency>,
	now: SystemTime,
) -> bool {
	let Some(recency) = recency else { return true };
	let Some(published_at) = published_at else {
		return false;
	};
	let days = match recency {
		SearchRecency::Day => 1,
		SearchRecency::Week => 7,
		SearchRecency::Month => 31,
		SearchRecency::Year => 366,
		SearchRecency::Days(days) => u64::from(days),
	};
	now.duration_since(published_at)
		.map_or(true, |age| age <= Duration::from_days(days))
}

fn validate_domain(domain: &str) -> Result<(), Error> {
	let domain = domain.trim_start_matches('.');
	let valid = !domain.is_empty()
		&& domain.len() <= 253
		&& !domain.contains("://")
		&& !domain.contains(['/', '?', '#', ':'])
		&& domain.split('.').all(|label| {
			!label.is_empty()
				&& label.len() <= 63
				&& label
					.as_bytes()
					.first()
					.is_some_and(|byte| byte.is_ascii_alphanumeric())
				&& label
					.as_bytes()
					.last()
					.is_some_and(|byte| byte.is_ascii_alphanumeric())
				&& label
					.bytes()
					.all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
		});
	if !valid {
		return Err(request_error("search.domains", "invalid_search_domain"));
	}
	Ok(())
}

fn validate_locale(locale: &str) -> Result<(), Error> {
	let mut subtags = locale.split('-');
	let valid = subtags.next().is_some_and(|language| {
		(2..=8).contains(&language.len()) && language.bytes().all(|byte| byte.is_ascii_alphabetic())
	}) && subtags.all(|subtag| {
		(1..=8).contains(&subtag.len()) && subtag.bytes().all(|byte| byte.is_ascii_alphanumeric())
	});
	if !valid {
		return Err(request_error("search.locale", "invalid_search_locale"));
	}
	Ok(())
}

fn domain_eq(left: &str, right: &str) -> bool {
	left
		.trim_start_matches('.')
		.eq_ignore_ascii_case(right.trim_start_matches('.'))
}

fn wrong_operation(call: &Call) -> Error {
	Error::new(
		ErrorKind::InternalInvariant,
		ErrorPhase::Internal,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::capability(
		Str::new(OperationKind::Search.to_string()),
		ReasonId(sf!("operation_service_mismatch")),
	))
	.request_id(call.id.clone())
}

fn request_error(feature: &'static str, reason: &'static str) -> Error {
	Error::planning(
		ErrorKind::InvalidRequest,
		ErrorDetail::capability(Str::new(feature), ReasonId(Str::new(reason))),
		ExecutionReceipt::default(),
	)
}

fn planning_error(feature: &'static str, reason: &'static str) -> Error {
	Error::planning(
		ErrorKind::CapabilityMismatch,
		ErrorDetail::capability(Str::new(feature), ReasonId(Str::new(reason))),
		ExecutionReceipt::default(),
	)
}

fn protocol_error(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::ProviderContractMismatch,
		ErrorPhase::Recovery,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

#[cfg(test)]
mod tests {
	use std::{
		sync::Arc,
		time::{Duration, UNIX_EPOCH},
	};

	use super::{
		HostedSearchIntent, SearchDocument, SearchPage, fallback_allowed, finalize_search,
		plan_search,
	};
	use crate::{
		body::{AttemptBodyEvidence, Replayability, RetryDecision, RetryDecisionReason},
		call::{
			EmulationPolicy, HostedTool, NegotiationPolicy, SearchRecency, SearchRequest, Setting,
		},
		catalog::{SearchCapabilities, SearchFeatureBits},
		error::{Error, ErrorKind, ErrorPhase, RetryAction},
		receipt::{ExecutionReceipt, Usage, UsageSource},
	};

	#[test]
	fn replay_page_is_filtered_ranked_and_measured() {
		let now = UNIX_EPOCH + Duration::from_days(10);
		let request = SearchRequest {
			query: "rust tower".into(),
			include_domains: Arc::new(["example.test".into()]),
			exclude_domains: Arc::new(["blocked.example.test".into()]),
			recency: Some(SearchRecency::Week),
			locale: Some("en".into()),
			max_results: 2,
			synthesize_answer: Setting::Unset,
			negotiation: NegotiationPolicy {
				emulation: EmulationPolicy::AllowLossless,
				..NegotiationPolicy::default()
			},
			..SearchRequest::new("rust tower", 2)
		};
		let plan = plan_search(
			&request,
			SearchCapabilities {
				features:        SearchFeatureBits::empty(),
				maximum_results: Some(5),
			},
			now,
		)
		.expect("lossless post-filter plan");
		let results = finalize_search(&plan, SearchPage {
			documents: vec![
				SearchDocument {
					url:          "https://example.test/low".into(),
					title:        "Low".into(),
					snippet:      None,
					score:        Some(0.25),
					published_at: Some(now - Duration::from_days(1)),
					locale:       Some("en-US".into()),
				},
				SearchDocument {
					url:          "https://blocked.example.test/high".into(),
					title:        "Blocked".into(),
					snippet:      None,
					score:        Some(1.0),
					published_at: Some(now),
					locale:       Some("en".into()),
				},
				SearchDocument {
					url:          "https://example.test/high".into(),
					title:        "High".into(),
					snippet:      None,
					score:        Some(0.75),
					published_at: Some(now),
					locale:       Some("en".into()),
				},
			],
			answer:    None,
			usage:     Usage::default(),
		})
		.expect("canonical search results");
		assert_eq!(
			results
				.results
				.iter()
				.map(|result| result.title.as_str())
				.collect::<Vec<_>>(),
			["High", "Low"]
		);
		assert_eq!(results.usage.search_calls, 1);
		assert_eq!(results.usage.source, UsageSource::Measured);
	}

	#[test]
	fn cancellation_and_consumed_one_shot_suppress_fallback() {
		let cancelled = Error::new(
			ErrorKind::Cancelled,
			ErrorPhase::Streaming,
			RetryAction::ReselectRoute,
			ExecutionReceipt::default(),
		);
		let consumed = AttemptBodyEvidence {
			opened:         true,
			consumed:       true,
			replayability:  Replayability::OneShot,
			retry_decision: RetryDecision::Suppress,
			reason:         RetryDecisionReason::ConsumedOneShot,
		};
		assert!(!fallback_allowed(&cancelled, consumed));
	}

	#[test]
	fn hosted_search_intent_is_validated_without_becoming_standalone_search() {
		let intent = HostedSearchIntent::from_tool(&HostedTool::WebSearch {
			allowed_domains: Arc::new(["example.test".into()]),
			blocked_domains: Arc::new(["blocked.test".into()]),
			recency_days:    Some(7),
		})
		.expect("valid hosted intent")
		.expect("web search intent");
		assert_eq!(intent.allowed_domains[0].as_str(), "example.test");
		assert_eq!(intent.recency_days, Some(7));
		assert!(
			HostedSearchIntent::from_tool(&HostedTool::CodeExecution)
				.expect("unrelated hosted tool")
				.is_none()
		);
		assert!(
			HostedSearchIntent::from_tool(&HostedTool::WebSearch {
				allowed_domains: Arc::new(["example.test".into()]),
				blocked_domains: Arc::new(["EXAMPLE.TEST".into()]),
				recency_days:    Some(7),
			})
			.is_err()
		);
	}
}
