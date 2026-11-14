//! Envd-owned URL-scheme generation for ADR 0050 S2/S3.
//!
//! One [`SchemeGeneration`] is the unknown-scheme broker (`HostResources`) that
//! `HostUriResolver` already calls. Publish replaces the envd-owned map (same
//! replace semantics as `set_host_uri_schemes`); the RPC stub stays unused on
//! chat compositions. A declared scheme's body is served by CONTROL
//! `omp.schemes.read` on the owning extension host.
//!
//! S3 adds declaration-based [`HostUriJudgment`] and live-only line-selector
//! peel gating via [`SchemeGeneration::is_live`].

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use async_trait::async_trait;
use omp_core::{Str, sf};
use omp_tool::FetchEffects;
use omp_tools::read::resolver::Scheme;
use parking_lot::RwLock;

use crate::{
	HostResourceResult, HostResources, HostUriJudgment,
	exthost::{
		CallbackConcurrency,
		control::{ControlConnectionIdentity, ControlProtocolError},
		dispatch::{CallbackDispatcher, NestedCallbackDispatcher},
	},
};

/// Fixed refusal for declared-scheme writes in S2.
pub const WRITE_NOT_ENABLED: &str = "declared scheme writes are not enabled";

/// One live scheme in the envd-owned generation.
#[derive(Clone, Debug)]
pub struct LiveScheme {
	/// Canonical spelling without `://`.
	pub scheme:      Str,
	/// Optional model-facing description.
	pub description: Option<Str>,
	/// Whether the extension accepts writes (S2 still refuses writes).
	pub writable:    bool,
	/// Whether reads are immutable.
	pub immutable:   bool,
	/// Extension has `env.net.fetch` / `env.net` at fold (ADR 0050 D4).
	pub fetch:       bool,
	/// Extension has a non-empty `credentials.allow` provider list at fold.
	pub credentials: bool,
	/// Extension id or `"rpc-host"`.
	pub owner:       Str,
	/// Live CONTROL identity used to invoke `omp.schemes.read`, when known.
	pub identity:    Option<Arc<ControlConnectionIdentity>>,
}

/// Claim metadata published into the generation (without a live identity).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SchemeClaim {
	/// Canonical spelling.
	pub scheme:      Str,
	/// Optional description.
	pub description: Option<Str>,
	/// Writable flag from the declaration.
	pub writable:    bool,
	/// Immutable flag from the declaration.
	pub immutable:   bool,
	/// Per-extension fetch capability copied onto every claim at fold.
	pub fetch:       bool,
	/// Per-extension credentials.allow non-empty flag copied at fold.
	pub credentials: bool,
}

impl LiveScheme {
	/// Declaration-based judgment for this live scheme (ADR 0050 D5).
	#[must_use]
	pub const fn judgment(&self) -> HostUriJudgment {
		judgment_from_flags(self.fetch, self.credentials)
	}
}

impl SchemeClaim {
	/// Declaration-based judgment for this claim (ADR 0050 D5).
	#[must_use]
	pub const fn judgment(&self) -> HostUriJudgment {
		judgment_from_flags(self.fetch, self.credentials)
	}
}

/// Maps fold capability flags to a host URI judgment.
///
/// `credentials` without `fetch` never becomes [`HostUriJudgment::Fetch`].
#[must_use]
pub const fn judgment_from_flags(fetch: bool, credentials: bool) -> HostUriJudgment {
	if fetch {
		HostUriJudgment::Fetch(FetchEffects { credentials })
	} else {
		HostUriJudgment::Unknown
	}
}

/// Refusal while folding claims into the generation.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SchemeFoldError {
	/// The spelling is a built-in wire name.
	#[error("URL scheme {scheme} is a built-in wire name")]
	Builtin {
		/// The refused spelling.
		scheme: Str,
	},
	/// Another live owner already claimed the spelling.
	#[error("URL scheme {scheme} is owned by {existing}; {claimant} cannot claim it")]
	Collision {
		/// The contested spelling.
		scheme:   Str,
		/// Owner that already holds the spelling.
		existing: Str,
		/// Owner that attempted the claim.
		claimant: Str,
	},
	/// The union would exceed [`omp_ext::scheme::MAX_SCHEMES`].
	#[error("{count} URL schemes are published; the limit is {}", omp_ext::scheme::MAX_SCHEMES)]
	TooMany {
		/// Size the union would reach.
		count: usize,
	},
	/// The spelling misses the host-URI grammar.
	#[error("URL scheme {scheme} does not match ^[a-z][a-z0-9+.-]*$")]
	Grammar {
		/// The refused spelling.
		scheme: Str,
	},
}

/// Envd-owned generation that implements [`HostResources`].
#[derive(Default)]
pub struct SchemeGeneration {
	schemes:     RwLock<BTreeMap<Str, LiveScheme>>,
	callbacks:   RwLock<Option<Arc<dyn CallbackDispatcher>>>,
	/// Optional in-process reader used by tests (and only tests) when CONTROL
	/// is not wired. Production always uses CONTROL via
	/// [`Self::bind_callbacks`].
	test_reader: RwLock<Option<Arc<dyn SchemeTestReader>>>,
}

/// Test-only read hook so unit tests can prove resolve without a live child.
#[async_trait]
pub trait SchemeTestReader: Send + Sync {
	/// Returns the body for one declared-scheme URL.
	async fn read(&self, scheme: &str, url: &str) -> Result<HostResourceResult, Str>;
}

impl SchemeGeneration {
	/// Empty generation.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Installs the callback dispatcher used for CONTROL `omp.schemes.read`.
	pub fn bind_callbacks(&self, callbacks: Arc<dyn CallbackDispatcher>) {
		*self.callbacks.write() = Some(callbacks);
	}

	/// Test-only reader used when CONTROL is absent.
	pub fn bind_test_reader(&self, reader: Arc<dyn SchemeTestReader>) {
		*self.test_reader.write() = Some(reader);
	}

	/// Snapshot of every live scheme, in scheme order.
	pub fn snapshot(&self) -> Vec<LiveScheme> {
		self.schemes.read().values().cloned().collect()
	}

	/// Whether a spelling is a built-in wire name of the closed vocabulary.
	#[must_use]
	pub fn is_builtin_wire_name(spelling: &str) -> bool {
		!matches!(Scheme::parse(spelling), Scheme::Unknown)
	}

	/// Whether `scheme` is currently live in this generation (ADR 0050 S3).
	#[must_use]
	pub fn is_live(&self, scheme: &str) -> bool {
		let Ok(canonical) = normalize_scheme(scheme) else {
			return false;
		};
		self.schemes.read().contains_key(canonical.as_str())
	}

	/// Declaration-based judgment for `url` (ADR 0050 D5).
	#[must_use]
	pub fn judge(&self, url: &str) -> HostUriJudgment {
		let Some(scheme) = scheme_of(url) else {
			return HostUriJudgment::Undeclared;
		};
		self
			.schemes
			.read()
			.get(scheme.as_str())
			.map_or(HostUriJudgment::Undeclared, LiveScheme::judgment)
	}

	/// Replaces every scheme owned by `owner` with `claims` (union publish).
	///
	/// Schemes owned by other owners are preserved. Built-in wire names,
	/// collisions with another owner, and a union above 32 are refused. On
	/// refusal the generation is unchanged.
	pub fn replace_owner(
		&self,
		owner: impl Into<Str>,
		identity: Option<Arc<ControlConnectionIdentity>>,
		claims: Vec<SchemeClaim>,
	) -> Result<(), SchemeFoldError> {
		let owner = owner.into();
		let mut prepared = Vec::with_capacity(claims.len());
		for claim in claims {
			let scheme = normalize_scheme(claim.scheme.as_str())?;
			if Self::is_builtin_wire_name(scheme.as_str()) {
				return Err(SchemeFoldError::Builtin { scheme });
			}
			prepared.push(LiveScheme {
				scheme,
				description: claim.description,
				writable: claim.writable,
				immutable: claim.immutable,
				fetch: claim.fetch,
				credentials: claim.credentials,
				owner: owner.clone(),
				identity: identity.clone(),
			});
		}
		let mut next = self
			.schemes
			.read()
			.iter()
			.filter(|(_, live)| live.owner != owner)
			.map(|(key, live)| (key.clone(), live.clone()))
			.collect::<BTreeMap<_, _>>();
		for live in prepared {
			if let Some(existing) = next.get(&live.scheme)
				&& existing.owner != owner
			{
				return Err(SchemeFoldError::Collision {
					scheme:   live.scheme,
					existing: existing.owner.clone(),
					claimant: owner,
				});
			}
			next.insert(live.scheme.clone(), live);
		}
		if next.len() > omp_ext::scheme::MAX_SCHEMES {
			return Err(SchemeFoldError::TooMany { count: next.len() });
		}
		*self.schemes.write() = next;
		Ok(())
	}

	/// Full replace of the envd-owned map (RPC-host style generation replace).
	pub fn replace_all(&self, schemes: Vec<LiveScheme>) -> Result<(), SchemeFoldError> {
		if schemes.len() > omp_ext::scheme::MAX_SCHEMES {
			return Err(SchemeFoldError::TooMany { count: schemes.len() });
		}
		let mut next: BTreeMap<Str, LiveScheme> = BTreeMap::new();
		for live in schemes {
			let scheme = normalize_scheme(live.scheme.as_str())?;
			if Self::is_builtin_wire_name(scheme.as_str()) {
				return Err(SchemeFoldError::Builtin { scheme });
			}
			if let Some(existing) = next.get(&scheme) {
				return Err(SchemeFoldError::Collision {
					scheme:   scheme.clone(),
					existing: existing.owner.clone(),
					claimant: live.owner,
				});
			}
			next.insert(scheme.clone(), LiveScheme { scheme, ..live });
		}
		*self.schemes.write() = next;
		Ok(())
	}

	fn lookup(&self, url: &str) -> Result<LiveScheme, Str> {
		let scheme =
			scheme_of(url).ok_or_else(|| Str::new_static("host resource URI is malformed"))?;
		self
			.schemes
			.read()
			.get(scheme.as_str())
			.cloned()
			.ok_or_else(|| sf!("no handler is registered for scheme {scheme}"))
	}
}

#[async_trait]
impl HostResources for SchemeGeneration {
	async fn resolve_read(&self, url: &str) -> Result<HostResourceResult, Str> {
		let live = self.lookup(url)?;
		let test_reader = self.test_reader.read().clone();
		if let Some(reader) = test_reader {
			return reader.read(live.scheme.as_str(), url).await;
		}
		let identity = live
			.identity
			.clone()
			.ok_or_else(|| sf!("declared scheme {} has no live extension host", live.scheme))?;
		let callbacks = self
			.callbacks
			.read()
			.clone()
			.ok_or_else(|| Str::new_static("extension callback supervisor is not active"))?;
		let nested = NestedCallbackDispatcher::new(callbacks);
		let mut arguments = serde_json::Map::new();
		arguments.insert("scheme".into(), serde_json::Value::String(live.scheme.to_string()));
		arguments.insert("url".into(), serde_json::Value::String(url.to_owned()));
		let value = nested
			.dispatch_host(
				identity,
				"omp.schemes.read",
				arguments,
				CallbackConcurrency::Serialized,
				Duration::from_secs(30),
				None,
			)
			.await
			.map_err(control_error)?;
		normalize_read_value(value)
	}

	async fn resolve_write(&self, _url: &str, _content: String) -> Result<HostResourceResult, Str> {
		Err(Str::new_static(WRITE_NOT_ENABLED))
	}

	fn judge(&self, url: &str) -> HostUriJudgment {
		SchemeGeneration::judge(self, url)
	}
}

fn normalize_scheme(spelling: &str) -> Result<Str, SchemeFoldError> {
	let canonical = spelling.to_ascii_lowercase();
	if !grammar_matches(canonical.as_bytes()) {
		return Err(SchemeFoldError::Grammar { scheme: Str::new(spelling) });
	}
	Ok(Str::from(canonical))
}

fn grammar_matches(spelling: &[u8]) -> bool {
	let [first, rest @ ..] = spelling else {
		return false;
	};
	first.is_ascii_lowercase()
		&& rest.iter().all(|byte| {
			byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'+' | b'.' | b'-')
		})
}

fn scheme_of(url: &str) -> Option<Str> {
	let (scheme, rest) = url.split_once("://")?;
	if rest.is_empty() && !url.contains("://") {
		return None;
	}
	normalize_scheme(scheme).ok()
}

fn control_error(error: ControlProtocolError) -> Str {
	error.message
}

fn normalize_read_value(value: serde_json::Value) -> Result<HostResourceResult, Str> {
	match value {
		serde_json::Value::String(content) => {
			Ok(HostResourceResult { content: Some(content), notes: Vec::new() })
		},
		serde_json::Value::Object(mut map) => {
			let content = match map.remove("content") {
				Some(serde_json::Value::String(content)) => Some(content),
				Some(serde_json::Value::Null) | None => None,
				Some(_) => {
					return Err(Str::new_static(
						"omp.schemes.read content must be a string when present",
					));
				},
			};
			let notes = match map.remove("notes") {
				Some(serde_json::Value::Array(items)) => items
					.into_iter()
					.map(|item| match item {
						serde_json::Value::String(note) => Ok(note),
						_ => Err(Str::new_static("omp.schemes.read notes must be strings")),
					})
					.collect::<Result<Vec<_>, _>>()?,
				Some(serde_json::Value::Null) | None => Vec::new(),
				Some(_) => {
					return Err(Str::new_static("omp.schemes.read notes must be an array"));
				},
			};
			Ok(HostResourceResult { content, notes })
		},
		_ => Err(Str::new_static("omp.schemes.read must return a string or a mapping with content")),
	}
}

const _: () = assert!(size_of::<SchemeClaim>() <= 128, "SchemeClaim must stay compact");

#[cfg(test)]
mod tests {
	use super::*;

	struct FixedReader {
		body: String,
	}

	#[async_trait]
	impl SchemeTestReader for FixedReader {
		async fn read(&self, _scheme: &str, _url: &str) -> Result<HostResourceResult, Str> {
			Ok(HostResourceResult { content: Some(self.body.clone()), notes: Vec::new() })
		}
	}

	fn claim(name: &str) -> SchemeClaim {
		SchemeClaim {
			scheme:      Str::new(name),
			description: None,
			writable:    false,
			immutable:   false,
			fetch:       false,
			credentials: false,
		}
	}

	fn claim_fetch(name: &str, fetch: bool, credentials: bool) -> SchemeClaim {
		SchemeClaim { fetch, credentials, ..claim(name) }
	}

	#[test]
	fn fold_refuses_builtin_wire_names() {
		let generation = SchemeGeneration::new();
		for spelling in ["https", "pr", "file", "mcp", "HTTPS", "Pr"] {
			let error = generation
				.replace_owner("acme.widgets", None, vec![claim(spelling)])
				.expect_err(spelling);
			assert!(matches!(error, SchemeFoldError::Builtin { .. }), "{spelling}: {error:?}");
		}
		assert!(generation.snapshot().is_empty());
	}

	#[test]
	fn fold_refuses_second_owner_collision() {
		let generation = SchemeGeneration::new();
		generation
			.replace_owner("acme.widgets", None, vec![claim("widget")])
			.expect("first owner");
		let error = generation
			.replace_owner("other.ext", None, vec![claim("widget")])
			.expect_err("collision");
		assert_eq!(error, SchemeFoldError::Collision {
			scheme:   Str::new_static("widget"),
			existing: Str::new_static("acme.widgets"),
			claimant: Str::new_static("other.ext"),
		});
	}

	#[tokio::test]
	async fn declared_scheme_read_returns_body_and_write_refuses() {
		let generation = SchemeGeneration::new();
		generation
			.replace_owner("acme.widgets", None, vec![claim("widget")])
			.expect("fold");
		generation.bind_test_reader(Arc::new(FixedReader { body: String::from("widget body") }));
		let read = generation
			.resolve_read("widget://records/1")
			.await
			.expect("read");
		assert_eq!(read.content.as_deref(), Some("widget body"));
		let write = generation
			.resolve_write("widget://records/1", String::from("x"))
			.await
			.expect_err("write refused");
		assert_eq!(write.as_str(), WRITE_NOT_ENABLED);
	}

	#[test]
	fn builtin_detector_covers_vocabulary_aliases() {
		assert!(SchemeGeneration::is_builtin_wire_name("https"));
		assert!(SchemeGeneration::is_builtin_wire_name("pr"));
		assert!(!SchemeGeneration::is_builtin_wire_name("widget"));
	}

	#[test]
	fn omit_fetch_and_credentials_judges_unknown() {
		let generation = SchemeGeneration::new();
		generation
			.replace_owner("acme.widgets", None, vec![claim("widget")])
			.expect("fold");
		assert_eq!(generation.judge("widget://id"), HostUriJudgment::Unknown);
		assert!(generation.is_live("widget"));
		assert!(!generation.is_live("custom"));
	}

	#[test]
	fn fetch_flag_judges_fetch_effects() {
		let generation = SchemeGeneration::new();
		generation
			.replace_owner("acme.widgets", None, vec![
				claim_fetch("widget", true, false),
				claim_fetch("secure", true, true),
			])
			.expect("fold");
		assert_eq!(
			generation.judge("widget://id"),
			HostUriJudgment::Fetch(FetchEffects { credentials: false })
		);
		assert_eq!(
			generation.judge("secure://id"),
			HostUriJudgment::Fetch(FetchEffects { credentials: true })
		);
	}

	#[test]
	fn credentials_without_fetch_stays_unknown() {
		assert_eq!(
			judgment_from_flags(false, true),
			HostUriJudgment::Unknown,
			"credentials alone never becomes Fetch"
		);
	}

	#[test]
	fn undeclared_never_inherits_declared_judgment() {
		let generation = SchemeGeneration::new();
		generation
			.replace_owner("acme.widgets", None, vec![claim_fetch("widget", true, true)])
			.expect("fold");
		assert_eq!(generation.judge("custom://pending:raw"), HostUriJudgment::Undeclared);
		assert_eq!(
			generation.judge("widget://id"),
			HostUriJudgment::Fetch(FetchEffects { credentials: true })
		);
	}
}
