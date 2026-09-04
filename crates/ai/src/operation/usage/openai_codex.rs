//! `OpenAI` Codex `ChatGPT` account usage and saved-reset retrieval.

use std::{
	fmt::Write as _,
	sync::Arc,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures::FutureExt as _;
use http::{
	HeaderMap, HeaderValue, Method,
	header::{AUTHORIZATION, CONTENT_TYPE, USER_AGENT},
};
use omp_catalog::snapshot;
use omp_core::{ExposeSecret as _, SecretString, Str, base64_url, parse_rfc3339, sf};
use ring::rand::{SecureRandom as _, SystemRandom};
use serde_json::{Map, Value};
use tokio::{sync::Mutex, time};
use url::Url;
use zeroize::Zeroizing;

use crate::{
	account::AccountPool,
	answer::{
		UsageAccountMetadata, UsageAmount, UsageQuantity, UsageResetCredit, UsageResetCredits,
		UsageStatus, UsageUnit, UsageWindow, UsageWindowKind,
	},
	auth::{
		CredentialBroker, CredentialNeed, CredentialSource as _, OAuthHttpClient, OAuthHttpRequest,
		OAuthHttpResponse,
	},
	catalog::{AuthSpecId, ProviderId},
	id::AccountId,
	operation::usage::{
		ConsoleUsageFetcher, ConsoleUsageObservation, UsageCredentialRequirement, UsageFetchError,
	},
	receipt::UsageSource,
};

const PROVIDER: &str = "openai-codex";
const CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api";
const CODEX_USAGE_PATH: &str = "wham/usage";
const RESET_CREDITS_PATH: &str = "wham/rate-limit-reset-credits";
const RESET_CREDITS_CONSUME_PATH: &str = "wham/rate-limit-reset-credits/consume";
const JWT_AUTH_CLAIM: &str = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM: &str = "https://api.openai.com/profile";

/// Application-registered `OpenAI` Codex account usage fetcher.
#[derive(Clone)]
pub struct OpenAiCodexUsageFetcher {
	provider: ProviderId,
	http:     Arc<dyn OAuthHttpClient>,
}

impl OpenAiCodexUsageFetcher {
	/// Constructs a fetcher over the application's shared bounded HTTP client.
	pub fn new(http: Arc<dyn OAuthHttpClient>) -> Self {
		Self { provider: ProviderId::from(PROVIDER), http }
	}
}

impl ConsoleUsageFetcher for OpenAiCodexUsageFetcher {
	fn provider(&self) -> &ProviderId<str> {
		&self.provider
	}

	fn credential_requirement(&self) -> UsageCredentialRequirement {
		UsageCredentialRequirement::Required
	}

	fn fetch<'a>(
		&'a self,
		credential: Option<&'a SecretString>,
		now: SystemTime,
		deadline: Option<Instant>,
	) -> futures::future::BoxFuture<'a, Result<ConsoleUsageObservation, UsageFetchError>> {
		async move {
			let token = credential.ok_or(UsageFetchError::Protocol)?.expose_secret();
			fetch_openai_codex_usage_until(token, self.http.as_ref(), now, deadline).await
		}
		.boxed()
	}
}

/// Normalizes a provider override to the canonical `ChatGPT` account API.
///
/// Streaming proxies and provider response paths are intentionally ignored:
/// `wham` account endpoints exist only on `chatgpt.com` and `chat.openai.com`.
pub fn normalize_codex_base_url(base_url: Option<&str>) -> Str {
	let Some(trimmed) = base_url.map(str::trim).filter(|value| !value.is_empty()) else {
		return sf!(CODEX_BASE_URL);
	};
	let Ok(url) = Url::parse(trimmed.trim_end_matches('/')) else {
		return sf!(CODEX_BASE_URL);
	};
	let Some(host) = url.host_str() else {
		return sf!(CODEX_BASE_URL);
	};
	if url.port().is_some()
		|| !(host.eq_ignore_ascii_case("chatgpt.com") || host.eq_ignore_ascii_case("chat.openai.com"))
	{
		return sf!(CODEX_BASE_URL);
	}
	sf!("{}/backend-api", url.origin().ascii_serialization())
}

/// Extracts `ChatGPT` account id and normalized email claims from a JWT.
pub fn parse_codex_jwt_identity(token: &str) -> (Option<Str>, Option<Str>) {
	let mut parts = token.split('.');
	let (Some(_header), Some(payload), Some(_signature), None) =
		(parts.next(), parts.next(), parts.next(), parts.next())
	else {
		return (None, None);
	};
	let Ok(decoded) = base64_url::decode_raw(payload.as_bytes()).into_vec() else {
		return (None, None);
	};
	let Ok(payload) = serde_json::from_slice::<Value>(&decoded) else {
		return (None, None);
	};
	let Some(root) = payload.as_object() else {
		return (None, None);
	};
	let account_id = root
		.get(JWT_AUTH_CLAIM)
		.and_then(Value::as_object)
		.and_then(|claim| claim.get("chatgpt_account_id"))
		.and_then(Value::as_str)
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(Str::new);
	let email = root
		.get(JWT_PROFILE_CLAIM)
		.and_then(Value::as_object)
		.and_then(|claim| claim.get("email"))
		.and_then(Value::as_str)
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(|value| Str::new(value.to_ascii_lowercase()));
	(account_id, email)
}

/// Fetches Codex account usage with a raw `ChatGPT` OAuth access token.
pub async fn fetch_openai_codex_usage(
	access_token: &str,
	http: &dyn OAuthHttpClient,
	now: SystemTime,
) -> Result<ConsoleUsageObservation, UsageFetchError> {
	fetch_openai_codex_usage_until(access_token, http, now, None).await
}

async fn fetch_openai_codex_usage_until(
	access_token: &str,
	http: &dyn OAuthHttpClient,
	now: SystemTime,
	deadline: Option<Instant>,
) -> Result<ConsoleUsageObservation, UsageFetchError> {
	if access_token.is_empty() {
		return Err(UsageFetchError::Protocol);
	}
	let base_url = normalize_codex_base_url(None);
	let (account_id, email) = parse_codex_jwt_identity(access_token);
	let headers = codex_headers(access_token, account_id.as_deref(), false)?;
	let response = execute(
		http,
		OAuthHttpRequest::new(Method::GET, &build_url(&base_url, CODEX_USAGE_PATH), headers, None)
			.map_err(|_| UsageFetchError::Protocol)?,
		deadline,
	)
	.await?;
	classify_status(response.status)?;
	let payload: Value = serde_json::from_str(response.body.expose_secret())
		.map_err(|_| UsageFetchError::Unavailable)?;
	let root = payload.as_object().ok_or(UsageFetchError::Unavailable)?;
	let plan = string(root.get("plan_type"));
	let windows = parse_windows(root, account_id.as_deref(), now);
	let mut reset_credits = parse_reset_credit_count(root);
	if reset_credits
		.as_ref()
		.is_some_and(|credits| credits.available > 0)
		&& let Ok(list) = list_codex_reset_credits_until(
			access_token,
			account_id.as_deref(),
			&base_url,
			http,
			deadline,
		)
		.await
	{
		let credits = list
			.credits
			.into_iter()
			.filter(|credit| {
				credit
					.status
					.as_deref()
					.is_none_or(|status| status.eq_ignore_ascii_case("available"))
			})
			.map(|credit| UsageResetCredit {
				granted_at: credit.granted_at,
				expires_at: credit.expires_at,
				status:     credit.status,
			})
			.collect::<Vec<_>>()
			.into_boxed_slice();
		reset_credits = Some(UsageResetCredits { available: list.available_count, credits });
	}
	if windows.is_empty() && reset_credits.is_none() {
		return Err(UsageFetchError::Unavailable);
	}

	Ok(ConsoleUsageObservation {
		account_meta: UsageAccountMetadata {
			provider_account_id: account_id,
			email,
			..UsageAccountMetadata::default()
		},
		plan,
		source_label: Some(sf!("chatgpt-backend")),
		notes: Box::default(),
		reset_credits,
		windows,
	})
}

fn parse_windows(
	root: &Map<String, Value>,
	account_id: Option<&str>,
	now: SystemTime,
) -> Vec<UsageWindow> {
	let mut windows = Vec::new();
	if let Some(rate_limit) = root.get("rate_limit").and_then(Value::as_object) {
		append_rate_limit_windows(&mut windows, rate_limit, None, None, account_id, now);
	}
	if let Some(additional) = root.get("additional_rate_limits").and_then(Value::as_array) {
		for value in additional {
			let Some(entry) = value.as_object() else {
				continue;
			};
			let limit_name = string(entry.get("limit_name"));
			let metered_feature = string(entry.get("metered_feature"));
			let Some(rate_limit) = entry.get("rate_limit").and_then(Value::as_object) else {
				continue;
			};
			let slug = additional_slug(limit_name.as_deref(), metered_feature.as_deref());
			let display_name = additional_display_name(&slug, limit_name.as_deref());
			append_rate_limit_windows(
				&mut windows,
				rate_limit,
				Some((&slug, &display_name)),
				limit_name.as_deref(),
				account_id,
				now,
			);
		}
	}
	windows
}

fn append_rate_limit_windows(
	windows: &mut Vec<UsageWindow>,
	rate_limit: &Map<String, Value>,
	additional: Option<(&str, &str)>,
	model_id: Option<&str>,
	_account_id: Option<&str>,
	now: SystemTime,
) {
	let allowed = rate_limit.get("allowed").and_then(Value::as_bool);
	let limit_reached = rate_limit.get("limit_reached").and_then(Value::as_bool);
	for (key, field) in [("primary", "primary_window"), ("secondary", "secondary_window")] {
		let Some(payload) = rate_limit.get(field).and_then(Value::as_object) else {
			continue;
		};
		let Some(parsed) = ParsedWindow::parse(payload) else {
			continue;
		};
		let explicitly_allowed = allowed == Some(true) && limit_reached == Some(false);
		windows.push(build_window(key, parsed, additional, model_id, explicitly_allowed, now));
	}
}

#[derive(Clone, Copy)]
struct ParsedWindow {
	used_percent:         Option<f64>,
	limit_window_seconds: Option<f64>,
	reset_after_seconds:  Option<f64>,
	reset_at:             Option<f64>,
}

impl ParsedWindow {
	fn parse(value: &Map<String, Value>) -> Option<Self> {
		let parsed = Self {
			used_percent:         number(value.get("used_percent")),
			limit_window_seconds: number(value.get("limit_window_seconds")),
			reset_after_seconds:  number(value.get("reset_after_seconds")),
			reset_at:             number(value.get("reset_at")),
		};
		(parsed.used_percent.is_some()
			|| parsed.limit_window_seconds.is_some()
			|| parsed.reset_after_seconds.is_some()
			|| parsed.reset_at.is_some())
		.then_some(parsed)
	}
}

fn build_window(
	key: &str,
	window: ParsedWindow,
	additional: Option<(&str, &str)>,
	model_id: Option<&str>,
	explicitly_allowed: bool,
	now: SystemTime,
) -> UsageWindow {
	let (label, duration) = window
		.limit_window_seconds
		.filter(|seconds| *seconds > 0.0)
		.map_or_else(
			|| {
				let label = if key == "primary" {
					"Primary window"
				} else {
					"Secondary window"
				};
				(sf!(label), None)
			},
			window_description,
		);
	let (id, label, scope) = match additional {
		Some((slug, display_name)) => {
			(sf!("openai-codex:{slug}:{key}"), sf!("{label} ({display_name})"), Str::new(slug))
		},
		None => (sf!("openai-codex:{key}"), label, sf!("shared")),
	};
	let used = window.used_percent.map(|value| value.clamp(0.0, 100.0));
	let status = used.map_or(UsageStatus::Unknown, |used| {
		if used >= 100.0 {
			if explicitly_allowed {
				UsageStatus::Warning
			} else {
				UsageStatus::Exhausted
			}
		} else if used >= 90.0 {
			UsageStatus::Warning
		} else {
			UsageStatus::Ok
		}
	});
	let notes = model_id
		.map_or_else(Box::default, |model_id| Box::new([sf!("model:{model_id}")]) as Box<[Str]>);
	UsageWindow {
		id,
		kind: UsageWindowKind::RateLimit,
		dimension: sf!("percent"),
		label: Some(label),
		scope: Some(scope),
		amount: UsageAmount {
			unit:      UsageUnit::Percent,
			consumed:  used.and_then(decimal_quantity),
			remaining: used.and_then(|used| decimal_quantity(100.0 - used)),
			limit:     used.map(|_| UsageQuantity::new(100, 0)),
		},
		status: Some(status),
		duration,
		resets_at: resolve_reset(window, now),
		reset_label: None,
		notes,
		source: UsageSource::Provider,
		observed_at: now,
	}
}

fn window_description(seconds: f64) -> (Str, Option<Duration>) {
	let duration = Duration::try_from_secs_f64(seconds).ok();
	if seconds >= 86_400.0 {
		let days = (seconds / 86_400.0).round().max(1.0) as u64;
		let suffix = if days == 1 { "day" } else { "days" };
		(sf!("{days} {suffix}"), duration)
	} else {
		let hours = (seconds / 3_600.0).round().max(1.0) as u64;
		let suffix = if hours == 1 { "hour" } else { "hours" };
		(sf!("{hours} {suffix}"), duration)
	}
}

fn resolve_reset(window: ParsedWindow, now: SystemTime) -> Option<SystemTime> {
	if let Some(reset_at) = window.reset_at.filter(|value| *value > 0.0) {
		let seconds = if reset_at >= 1_000_000_000_000.0 {
			reset_at / 1_000.0
		} else {
			reset_at
		};
		return UNIX_EPOCH.checked_add(Duration::try_from_secs_f64(seconds).ok()?);
	}
	let after = window.reset_after_seconds.filter(|value| *value >= 0.0)?;
	now.checked_add(Duration::try_from_secs_f64(after).ok()?)
}

fn additional_slug(limit_name: Option<&str>, metered_feature: Option<&str>) -> String {
	let probe =
		format!("{} {}", limit_name.unwrap_or_default(), metered_feature.unwrap_or_default())
			.to_ascii_lowercase();
	if probe.contains("spark") || probe.contains("bengalfox") {
		return "spark".to_owned();
	}
	let source = metered_feature
		.or(limit_name)
		.unwrap_or("extra")
		.to_ascii_lowercase();
	let source = source
		.strip_prefix("codex_")
		.or_else(|| source.strip_prefix("codex-"))
		.unwrap_or(&source);
	let mut slug = String::with_capacity(source.len());
	let mut separator = false;
	for character in source.chars() {
		if character.is_ascii_alphanumeric() {
			if separator && !slug.is_empty() {
				slug.push('-');
			}
			slug.push(character);
			separator = false;
		} else {
			separator = true;
		}
	}
	if slug.is_empty() {
		"extra".to_owned()
	} else {
		slug
	}
}

fn additional_display_name(slug: &str, limit_name: Option<&str>) -> Str {
	if slug == "spark" {
		return sf!("Spark");
	}
	if let Some(limit_name) = limit_name {
		return Str::new(limit_name);
	}
	let mut display = String::with_capacity(slug.len());
	for (index, part) in slug.split('-').enumerate() {
		if index > 0 {
			display.push(' ');
		}
		let mut chars = part.chars();
		if let Some(first) = chars.next() {
			display.extend(first.to_uppercase());
			display.extend(chars);
		}
	}
	Str::new(display)
}

fn parse_reset_credit_count(root: &Map<String, Value>) -> Option<UsageResetCredits> {
	let count = root
		.get("rate_limit_reset_credits")
		.and_then(Value::as_object)
		.and_then(|block| number(block.get("available_count")))?;
	let available = count.max(0.0).trunc().min(u64::MAX as f64) as u64;
	Some(UsageResetCredits { available, credits: Box::default() })
}

/// One saved Codex rate-limit reset returned by the detail endpoint.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexResetCredit {
	/// Opaque credit identifier used by the consume endpoint.
	pub id:         Str,
	/// Provider lifecycle state such as `available` or `redeemed`.
	pub status:     Option<Str>,
	/// Time at which the credit was granted.
	pub granted_at: Option<SystemTime>,
	/// Time after which the credit can no longer be redeemed.
	pub expires_at: Option<SystemTime>,
}

/// Saved-reset detail response with the live redeemable count.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexResetCreditList {
	/// Parsed credit objects, including non-available history rows.
	pub credits:         Vec<CodexResetCredit>,
	/// Backend-reported count currently available.
	pub available_count: u64,
}

/// Result of consuming one saved reset credit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexResetConsumeResult {
	/// Whether the backend reported that a reset was applied.
	pub ok:     bool,
	/// Provider business result code, with `reset` denoting success.
	pub code:   Str,
	/// HTTP response status.
	pub status: u16,
}
/// Why autonomous recovery is spending a saved Codex reset.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display)]
#[strum(serialize_all = "snake_case")]
pub enum CodexRedemptionReason {
	/// Preserve an otherwise successful partial generation after quota
	/// exhaustion.
	Salvage,
	/// Restore a request that produced no usable output.
	Restore,
}

/// Session-local coordinator for autonomous saved-reset redemption.
#[derive(Clone, Debug)]
pub struct CodexRedemptionCoordinator {
	cooldown:            Duration,
	next_attempt:        Option<Instant>,
	history_generation:  u64,
	redeemed_generation: Option<u64>,
}

impl CodexRedemptionCoordinator {
	/// Creates a coordinator with the minimum interval between provider
	/// mutations.
	pub const fn new(cooldown: Duration) -> Self {
		Self { cooldown, next_attempt: None, history_generation: 0, redeemed_generation: None }
	}

	/// Resets per-history redemption state after a compaction reseeds Codex.
	pub const fn post_compaction_reset(&mut self) {
		self.history_generation = self.history_generation.wrapping_add(1);
		self.redeemed_generation = None;
	}

	/// Lists, selects, and consumes the soonest-expiring available reset.
	///
	/// At most one successful redemption is admitted for each compacted
	/// history generation, and every provider mutation arms the cooldown.
	pub async fn redeem(
		&mut self,
		_reason: CodexRedemptionReason,
		access_token: &str,
		account_id: Option<&str>,
		http: &dyn OAuthHttpClient,
		now: Instant,
	) -> Result<Option<CodexResetConsumeResult>, UsageFetchError> {
		if self.redeemed_generation == Some(self.history_generation)
			|| self.next_attempt.is_some_and(|next| now < next)
		{
			return Ok(None);
		}
		self.next_attempt = Some(now + self.cooldown);
		let credits = list_codex_reset_credits(access_token, account_id, http).await?;
		if credits.available_count == 0 {
			return Ok(None);
		}
		let Some(credit) = pick_soonest_expiring_credit(&credits.credits) else {
			return Ok(None);
		};
		let result =
			consume_codex_reset_credit(access_token, account_id, &credit.id, None, http).await?;
		if result.ok {
			self.redeemed_generation = Some(self.history_generation);
		}
		Ok(Some(result))
	}
}

impl Default for CodexRedemptionCoordinator {
	fn default() -> Self {
		Self::new(Duration::from_secs(60))
	}
}

/// Production saved-reset redemption service over the shared credential
/// broker and account pool.
///
/// Owns the session-local [`CodexRedemptionCoordinator`] and leases the Codex
/// access token per attempt, so tokens never escape this crate. The app
/// adapts this onto the agent's `RedemptionAuthority` boundary.
pub struct CodexRedemption {
	auth:        AuthSpecId,
	provider:    ProviderId,
	broker:      CredentialBroker,
	accounts:    AccountPool,
	http:        Arc<dyn OAuthHttpClient>,
	coordinator: Mutex<CodexRedemptionCoordinator>,
}

impl CodexRedemption {
	/// Builds the service when the catalog carries an `openai-codex` route.
	///
	/// Returns `None` when the provider is absent so hosts without Codex skip
	/// registration entirely.
	pub fn from_catalog(
		catalog: &snapshot::Catalog,
		broker: CredentialBroker,
		accounts: AccountPool,
		http: Arc<dyn OAuthHttpClient>,
	) -> Option<Self> {
		let provider = ProviderId::from(PROVIDER);
		let route = catalog
			.routes()
			.iter()
			.find(|route| route.provider.as_str() == PROVIDER)?;
		Some(Self {
			auth: route.auth.clone(),
			provider,
			broker,
			accounts,
			http,
			coordinator: Mutex::new(CodexRedemptionCoordinator::default()),
		})
	}

	/// Attempts one saved-reset redemption; `true` means a credit was consumed.
	pub async fn redeem(&self, reason: CodexRedemptionReason) -> bool {
		let account = self
			.accounts
			.accounts()
			.into_iter()
			.find(|record| record.enabled && record.provider == self.provider)
			.map(|record| record.account);
		match account {
			Some(account) => self.redeem_account(reason, &account).await,
			None => false,
		}
	}

	/// Attempts one saved-reset redemption for one exact durable account.
	pub async fn redeem_account(
		&self,
		reason: CodexRedemptionReason,
		account: &AccountId<str>,
	) -> bool {
		let record = self.accounts.accounts().into_iter().find(|record| {
			record.enabled
				&& record.provider == self.provider
				&& record.account.as_str() == account.as_ref()
		});
		let principal = match record {
			Some(record) => record.principal,
			None => return false,
		};
		let Ok(lease) = self
			.broker
			.lease(CredentialNeed {
				spec:        self.auth.clone(),
				account:     Some(account.to_owned()),
				principal:   Some(principal),
				valid_after: SystemTime::now(),
			})
			.await
		else {
			return false;
		};
		let Some(token) = lease.scalar_secret() else {
			return false;
		};
		let (provider_account_id, _) = parse_codex_jwt_identity(token.expose_secret());
		let mut coordinator = self.coordinator.lock().await;
		matches!(
			coordinator
				.redeem(
					reason,
					token.expose_secret(),
					provider_account_id.as_deref(),
					self.http.as_ref(),
					Instant::now(),
				)
				.await,
			Ok(Some(CodexResetConsumeResult { ok: true, .. }))
		)
	}

	/// Records that provider-native history was reseeded, opening the next
	/// per-history redemption window.
	pub async fn history_reseeded(&self) {
		self.coordinator.lock().await.post_compaction_reset();
	}
}

/// Lists saved Codex rate-limit reset credits.
pub async fn list_codex_reset_credits(
	access_token: &str,
	account_id: Option<&str>,
	http: &dyn OAuthHttpClient,
) -> Result<CodexResetCreditList, UsageFetchError> {
	list_codex_reset_credits_until(
		access_token,
		account_id,
		&normalize_codex_base_url(None),
		http,
		None,
	)
	.await
}

async fn list_codex_reset_credits_until(
	access_token: &str,
	account_id: Option<&str>,
	base_url: &str,
	http: &dyn OAuthHttpClient,
	deadline: Option<Instant>,
) -> Result<CodexResetCreditList, UsageFetchError> {
	let response = execute(
		http,
		OAuthHttpRequest::new(
			Method::GET,
			&build_url(base_url, RESET_CREDITS_PATH),
			codex_headers(access_token, account_id, false)?,
			None,
		)
		.map_err(|_| UsageFetchError::Protocol)?,
		deadline,
	)
	.await?;
	classify_status(response.status)?;
	let payload: Value = serde_json::from_str(response.body.expose_secret())
		.map_err(|_| UsageFetchError::Unavailable)?;
	let root = payload.as_object().ok_or(UsageFetchError::Unavailable)?;
	let credits = root
		.get("credits")
		.and_then(Value::as_array)
		.map_or_else(Vec::new, |credits| credits.iter().filter_map(parse_credit).collect::<Vec<_>>());
	let available_count = number(root.get("available_count")).map_or_else(
		|| {
			credits
				.iter()
				.filter(|credit| {
					credit
						.status
						.as_deref()
						.is_none_or(|status| status.eq_ignore_ascii_case("available"))
				})
				.count() as u64
		},
		|value| value.max(0.0).trunc().min(u64::MAX as f64) as u64,
	);
	Ok(CodexResetCreditList { credits, available_count })
}

fn parse_credit(value: &Value) -> Option<CodexResetCredit> {
	let root = value.as_object()?;
	Some(CodexResetCredit {
		id:         string(root.get("id"))?,
		status:     string(root.get("status")),
		granted_at: root
			.get("granted_at")
			.and_then(Value::as_str)
			.and_then(parse_rfc3339),
		expires_at: root
			.get("expires_at")
			.and_then(Value::as_str)
			.and_then(parse_rfc3339),
	})
}

/// Picks the available credit with the soonest finite expiry.
///
/// Undated available credits rank after dated credits. When no row is
/// available, the first row is returned so the backend can surface its own
/// business outcome.
pub fn pick_soonest_expiring_credit(credits: &[CodexResetCredit]) -> Option<&CodexResetCredit> {
	let mut best = None;
	let mut best_expiry = None;
	let mut undated = None;
	for credit in credits {
		if credit
			.status
			.as_deref()
			.is_some_and(|status| !status.eq_ignore_ascii_case("available"))
		{
			continue;
		}
		match credit.expires_at {
			Some(expiry) if best_expiry.is_none_or(|current| expiry < current) => {
				best = Some(credit);
				best_expiry = Some(expiry);
			},
			Some(_) => {},
			None => {
				undated.get_or_insert(credit);
			},
		}
	}
	best.or(undated).or_else(|| credits.first())
}

/// Consumes one saved Codex rate-limit reset credit.
///
/// When `redeem_request_id` is absent, a cryptographically random RFC 4122 v4
/// UUID is generated as the idempotency key.
pub async fn consume_codex_reset_credit(
	access_token: &str,
	account_id: Option<&str>,
	credit_id: &str,
	redeem_request_id: Option<&str>,
	http: &dyn OAuthHttpClient,
) -> Result<CodexResetConsumeResult, UsageFetchError> {
	let redeem_request_id = match redeem_request_id {
		Some(value) => value.to_owned(),
		None => random_uuid_v4()?,
	};
	let mut body = Map::new();
	body.insert("credit_id".to_owned(), Value::String(credit_id.to_owned()));
	body.insert("redeem_request_id".to_owned(), Value::String(redeem_request_id));
	if let Some(account_id) = account_id {
		body.insert("account_id".to_owned(), Value::String(account_id.to_owned()));
	}
	let response = execute(
		http,
		OAuthHttpRequest::new(
			Method::POST,
			&build_url(&normalize_codex_base_url(None), RESET_CREDITS_CONSUME_PATH),
			codex_headers(access_token, account_id, true)?,
			Some(SecretString::from(Value::Object(body).to_string())),
		)
		.map_err(|_| UsageFetchError::Protocol)?,
		None,
	)
	.await?;
	let payload = serde_json::from_str::<Value>(response.body.expose_secret()).ok();
	let code = payload
		.as_ref()
		.and_then(Value::as_object)
		.and_then(|root| string(root.get("code")))
		.unwrap_or_else(|| {
			if (200..300).contains(&response.status) {
				sf!("reset")
			} else {
				sf!("http_{}", response.status)
			}
		});
	Ok(CodexResetConsumeResult { ok: code == "reset", code, status: response.status })
}

fn random_uuid_v4() -> Result<String, UsageFetchError> {
	let mut bytes = [0_u8; 16];
	SystemRandom::new()
		.fill(&mut bytes)
		.map_err(|_| UsageFetchError::Unavailable)?;
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	let mut value = String::with_capacity(36);
	write!(
		value,
		"{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:\
		 02x}{:02x}",
		bytes[0],
		bytes[1],
		bytes[2],
		bytes[3],
		bytes[4],
		bytes[5],
		bytes[6],
		bytes[7],
		bytes[8],
		bytes[9],
		bytes[10],
		bytes[11],
		bytes[12],
		bytes[13],
		bytes[14],
		bytes[15]
	)
	.map_err(|_| UsageFetchError::Unavailable)?;
	Ok(value)
}

fn codex_headers(
	access_token: &str,
	account_id: Option<&str>,
	json_body: bool,
) -> Result<HeaderMap, UsageFetchError> {
	let mut headers = HeaderMap::new();
	headers.insert(AUTHORIZATION, bearer_header(access_token)?);
	headers.insert(USER_AGENT, HeaderValue::from_static(omp_core::USER_AGENT));
	if let Some(account_id) = account_id {
		headers.insert(
			"chatgpt-account-id",
			HeaderValue::from_str(account_id).map_err(|_| UsageFetchError::Protocol)?,
		);
	}
	if json_body {
		headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
	}
	Ok(headers)
}

fn bearer_header(token: &str) -> Result<HeaderValue, UsageFetchError> {
	let mut bytes = Zeroizing::new(Vec::with_capacity(7 + token.len()));
	bytes.extend_from_slice(b"Bearer ");
	bytes.extend_from_slice(token.as_bytes());
	let mut value = HeaderValue::from_bytes(&bytes).map_err(|_| UsageFetchError::Protocol)?;
	value.set_sensitive(true);
	Ok(value)
}

fn build_url(base_url: &str, path: &str) -> String {
	format!("{}/{path}", base_url.trim_end_matches('/'))
}

async fn execute(
	http: &dyn OAuthHttpClient,
	request: OAuthHttpRequest,
	deadline: Option<Instant>,
) -> Result<OAuthHttpResponse, UsageFetchError> {
	match deadline {
		Some(deadline) => time::timeout_at(deadline.into(), http.execute(request))
			.await
			.map_err(|_| UsageFetchError::Unavailable)?
			.map_err(|_| UsageFetchError::Unavailable),
		None => http
			.execute(request)
			.await
			.map_err(|_| UsageFetchError::Unavailable),
	}
}

const fn classify_status(status: u16) -> Result<(), UsageFetchError> {
	match status {
		200..=299 => Ok(()),
		401 | 403 => Err(UsageFetchError::AuthRejected),
		_ => Err(UsageFetchError::Unavailable),
	}
}

fn string(value: Option<&Value>) -> Option<Str> {
	value
		.and_then(Value::as_str)
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(Str::new)
}

fn number(value: Option<&Value>) -> Option<f64> {
	match value? {
		Value::Number(value) => value.as_f64().filter(|value| value.is_finite()),
		Value::String(value) => value.parse::<f64>().ok().filter(|value| value.is_finite()),
		_ => None,
	}
}

fn decimal_quantity(value: f64) -> Option<UsageQuantity> {
	if !value.is_finite() || value < 0.0 {
		return None;
	}
	let rendered = format!("{value:.9}");
	let rendered = rendered.trim_end_matches('0').trim_end_matches('.');
	let (whole, fraction) = rendered.split_once('.').unwrap_or((rendered, ""));
	let units = format!("{whole}{fraction}").parse().ok()?;
	Some(UsageQuantity::new(units, fraction.len().try_into().ok()?))
}

#[cfg(test)]
mod tests {
	use std::{
		collections::VecDeque,
		sync::Arc,
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use futures::{FutureExt as _, future::BoxFuture};
	use http::{HeaderMap, Method};
	use omp_core::{ExposeSecret as _, SecretString, base64_url, parse_rfc3339, sf};
	use parking_lot::Mutex;

	use super::{
		CodexResetCredit, consume_codex_reset_credit, fetch_openai_codex_usage,
		normalize_codex_base_url, parse_codex_jwt_identity, pick_soonest_expiring_credit,
		random_uuid_v4,
	};
	use crate::{
		auth::{OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthTransportError},
		operation::usage::UsageFetchError,
	};

	#[derive(Clone)]
	struct RecordedRequest {
		method:  Method,
		url:     String,
		headers: HeaderMap,
		body:    Option<String>,
	}

	#[derive(Clone, Default)]
	struct ScriptedHttp {
		responses: Arc<Mutex<VecDeque<OAuthHttpResponse>>>,
		requests:  Arc<Mutex<Vec<RecordedRequest>>>,
	}

	impl ScriptedHttp {
		fn new<S: Into<String>>(items: impl IntoIterator<Item = (u16, S)>) -> Self {
			Self {
				responses: Arc::new(Mutex::new(
					items
						.into_iter()
						.map(|(status, body)| OAuthHttpResponse {
							status,
							headers: HeaderMap::new(),
							body: SecretString::from(body.into()),
						})
						.collect(),
				)),
				requests:  Arc::new(Mutex::new(Vec::new())),
			}
		}
	}

	impl OAuthHttpClient for ScriptedHttp {
		fn execute(
			&self,
			request: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
			let (method, url, headers, body) = request.into_parts();
			self.requests.lock().push(RecordedRequest {
				method,
				url: url.to_string(),
				headers,
				body: body.map(|body| body.expose_secret().to_owned()),
			});
			let response = self
				.responses
				.lock()
				.pop_front()
				.expect("scripted response");
			async move { Ok(response) }.boxed()
		}
	}

	fn now() -> SystemTime {
		UNIX_EPOCH + Duration::from_secs(1_700_000_000)
	}

	fn jwt() -> String {
		let payload = br#"{"https://api.openai.com/auth":{"chatgpt_account_id":"acct-1"},"https://api.openai.com/profile":{"email":" User@Example.COM "}}"#;
		format!("x.{}.y", base64_url::encode_raw(payload).into_string())
	}

	#[test]
	fn canonicalizes_account_api_base_urls() {
		assert_eq!(normalize_codex_base_url(None).as_str(), "https://chatgpt.com/backend-api");
		assert_eq!(
			normalize_codex_base_url(Some("http://127.0.0.1:8787/v1")).as_str(),
			"https://chatgpt.com/backend-api"
		);
		assert_eq!(
			normalize_codex_base_url(Some("https://chatgpt.com")).as_str(),
			"https://chatgpt.com/backend-api"
		);
		assert_eq!(
			normalize_codex_base_url(Some("https://chatgpt.com/backend-api/codex/responses")).as_str(),
			"https://chatgpt.com/backend-api"
		);
		assert_eq!(
			normalize_codex_base_url(Some("https://chat.openai.com/v1")).as_str(),
			"https://chat.openai.com/backend-api"
		);
	}

	#[test]
	fn parses_jwt_identity_and_normalizes_email() {
		let (account_id, email) = parse_codex_jwt_identity(&jwt());
		assert_eq!(account_id.as_deref(), Some("acct-1"));
		assert_eq!(email.as_deref(), Some("user@example.com"));
		assert_eq!(parse_codex_jwt_identity("not-a-jwt"), (None, None));
	}

	#[tokio::test]
	async fn emits_primary_secondary_and_exact_auth_headers() {
		let http = ScriptedHttp::new([(
			200,
			r#"{
			"plan_type":"pro","rate_limit":{"allowed":true,"limit_reached":false,
			"primary_window":{"used_percent":4,"limit_window_seconds":18000,"reset_after_seconds":60},
			"secondary_window":{"used_percent":1,"limit_window_seconds":604800,"reset_at":1700600000}}
		}"#,
		)]);
		let token = jwt();
		let report = fetch_openai_codex_usage(&token, &http, now())
			.await
			.expect("usage");
		assert_eq!(report.plan.as_deref(), Some("pro"));
		assert_eq!(report.account_meta.provider_account_id.as_deref(), Some("acct-1"));
		assert_eq!(report.windows.len(), 2);
		assert_eq!(report.windows[0].id.as_str(), "openai-codex:primary");
		assert_eq!(report.windows[0].label.as_deref(), Some("5 hours"));
		assert_eq!(report.windows[0].amount.consumed.map(|value| value.units), Some(4));
		assert_eq!(report.windows[1].id.as_str(), "openai-codex:secondary");
		assert_eq!(report.windows[1].label.as_deref(), Some("7 days"));
		let requests = http.requests.lock();
		assert_eq!(requests.len(), 1);
		assert_eq!(requests[0].url, "https://chatgpt.com/backend-api/wham/usage");
		assert_eq!(
			requests[0].headers["authorization"]
				.to_str()
				.expect("header"),
			format!("Bearer {token}")
		);
		assert_eq!(requests[0].headers["chatgpt-account-id"], "acct-1");
		assert_eq!(requests[0].headers["user-agent"], omp_core::USER_AGENT);
	}

	#[tokio::test]
	async fn allowed_team_cap_is_warning_and_shared_rejection_does_not_poison_headroom() {
		let http = ScriptedHttp::new([(
			200,
			r#"{
			"rate_limit":{"allowed":true,"limit_reached":false,
			"primary_window":{"used_percent":4},"secondary_window":{"used_percent":100}}
		}"#,
		)]);
		let report = fetch_openai_codex_usage("x.e30.y", &http, now())
			.await
			.expect("usage");
		assert_eq!(report.windows[0].status, Some(crate::answer::UsageStatus::Ok));
		assert_eq!(report.windows[1].status, Some(crate::answer::UsageStatus::Warning));

		let http = ScriptedHttp::new([(
			200,
			r#"{"rate_limit":{"limit_reached":true,"primary_window":{"used_percent":4}}}"#,
		)]);
		let report = fetch_openai_codex_usage("x.e30.y", &http, now())
			.await
			.expect("usage");
		assert_eq!(report.windows[0].status, Some(crate::answer::UsageStatus::Ok));
	}

	#[tokio::test]
	async fn surfaces_bengalfox_as_independent_spark_windows_and_additional_only_report() {
		let http = ScriptedHttp::new([(
			200,
			r#"{"additional_rate_limits":[{
			"metered_feature":"codex_bengalfox","rate_limit":{"allowed":false,"limit_reached":true,
			"primary_window":{"used_percent":17,"limit_window_seconds":18000},
			"secondary_window":{"used_percent":100,"limit_window_seconds":604800}}
		}]}"#,
		)]);
		let report = fetch_openai_codex_usage("x.e30.y", &http, now())
			.await
			.expect("usage");
		assert_eq!(report.windows.len(), 2);
		assert_eq!(report.windows[0].id.as_str(), "openai-codex:spark:primary");
		assert_eq!(report.windows[0].label.as_deref(), Some("5 hours (Spark)"));
		assert_eq!(report.windows[0].scope.as_deref(), Some("spark"));
		assert_eq!(report.windows[0].status, Some(crate::answer::UsageStatus::Ok));
		assert_eq!(report.windows[1].status, Some(crate::answer::UsageStatus::Exhausted));
	}

	#[tokio::test]
	async fn populates_live_reset_credit_details_and_skips_list_at_zero() {
		let http = ScriptedHttp::new([
			(
				200,
				r#"{"rate_limit":{"primary_window":{"used_percent":4}},"rate_limit_reset_credits":{"available_count":2}}"#,
			),
			(
				200,
				r#"{"available_count":2,"credits":[
				{"id":"a","status":"available","granted_at":"2026-06-01T00:00:00Z","expires_at":"2026-08-20T00:00:00Z"},
				{"id":"b","status":"available","expires_at":"2026-08-21T00:00:00Z"},
				{"id":"c","status":"redeemed","expires_at":"2026-08-19T00:00:00Z"}] }"#,
			),
		]);
		let report = fetch_openai_codex_usage("x.e30.y", &http, now())
			.await
			.expect("usage");
		let reset = report.reset_credits.expect("reset credits");
		assert_eq!(reset.available, 2);
		assert_eq!(reset.credits.len(), 2);
		assert_eq!(
			http.requests.lock()[1].url,
			"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
		);

		let zero = ScriptedHttp::new([(
			200,
			r#"{"rate_limit":{"primary_window":{"used_percent":4}},"rate_limit_reset_credits":{"available_count":0}}"#,
		)]);
		let report = fetch_openai_codex_usage("x.e30.y", &zero, now())
			.await
			.expect("usage");
		assert_eq!(report.reset_credits.expect("zero block").available, 0);
		assert_eq!(zero.requests.lock().len(), 1);

		let absent =
			ScriptedHttp::new([(200, r#"{"rate_limit":{"primary_window":{"used_percent":4}}}"#)]);
		let report = fetch_openai_codex_usage("x.e30.y", &absent, now())
			.await
			.expect("usage");
		assert!(report.reset_credits.is_none());
	}

	#[tokio::test]
	async fn consume_posts_exact_idempotent_body_and_picker_uses_soonest_expiry() {
		let credits = [
			CodexResetCredit {
				id:         sf!("later"),
				status:     Some(sf!("available")),
				granted_at: None,
				expires_at: parse_rfc3339("2026-09-01T00:00:00Z"),
			},
			CodexResetCredit {
				id:         sf!("soon"),
				status:     Some(sf!("available")),
				granted_at: None,
				expires_at: parse_rfc3339("2026-08-20T00:00:00Z"),
			},
			CodexResetCredit {
				id:         sf!("redeemed"),
				status:     Some(sf!("redeemed")),
				granted_at: None,
				expires_at: parse_rfc3339("2026-08-19T00:00:00Z"),
			},
		];
		assert_eq!(
			pick_soonest_expiring_credit(&credits).map(|credit| credit.id.as_str()),
			Some("soon")
		);

		let http = ScriptedHttp::new([(200, r#"{"code":"reset"}"#)]);
		let result = consume_codex_reset_credit(
			"token",
			Some("acct-1"),
			"soon",
			Some("00000000-0000-4000-8000-000000000001"),
			&http,
		)
		.await
		.expect("consume");
		assert!(result.ok);
		let requests = http.requests.lock();
		assert_eq!(requests[0].method, Method::POST);
		assert_eq!(
			requests[0].url,
			"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
		);
		assert_eq!(requests[0].headers["content-type"], "application/json");
		assert_eq!(requests[0].headers["authorization"], "Bearer token");
		let body: serde_json::Value =
			serde_json::from_str(requests[0].body.as_deref().expect("body")).expect("json");
		assert_eq!(
			body,
			serde_json::json!({"credit_id":"soon","redeem_request_id":"00000000-0000-4000-8000-000000000001","account_id":"acct-1"})
		);
	}

	#[test]
	fn generated_redeem_id_is_an_rfc4122_v4_uuid() {
		let value = random_uuid_v4().expect("uuid");
		let bytes = value.as_bytes();
		assert_eq!(bytes.len(), 36);
		assert_eq!((bytes[8], bytes[13], bytes[18], bytes[23]), (b'-', b'-', b'-', b'-'));
		assert_eq!(bytes[14], b'4');
		assert!(matches!(bytes[19], b'8' | b'9' | b'a' | b'b'));
	}

	#[tokio::test]
	async fn auth_and_rate_limit_failures_are_typed_without_retry() {
		for (status, expected) in [
			(401, UsageFetchError::AuthRejected),
			(403, UsageFetchError::AuthRejected),
			(429, UsageFetchError::Unavailable),
		] {
			let http = ScriptedHttp::new([(status, "{}")]);
			assert_eq!(
				fetch_openai_codex_usage("x.e30.y", &http, now())
					.await
					.expect_err("failure"),
				expected
			);
			assert_eq!(http.requests.lock().len(), 1);
		}
	}
}
