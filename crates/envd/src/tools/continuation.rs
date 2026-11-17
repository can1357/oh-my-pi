//! Session-scoped continuation ledger and per-extension policy.
//!
//! Accounting is session-scoped for this slice: a Continue accepted here
//! debits this session's ledger only. Recursive debit across a spawned agent
//! tree remains a documented gap (see `docs/adr/TASKS.md`).

use std::{
	collections::BTreeMap,
	sync::Arc,
	time::{SystemTime, UNIX_EPOCH},
};

use omp_contract::hooks::SETTLE_CONTINUATION_CAP;
use omp_core::Str;
use parking_lot::Mutex;
use serde_json::{Map as JsonMap, Value as JsonValue, json};

use crate::exthost::control::{
	ControlAuthority, ControlAuthorityFactory, ControlCompositionError, ControlConnectionIdentity,
	ControlEffect, ControlProtocolError, ControlRequestContext,
};

/// What happens when a policy or core cap refuses further continuation.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum OnExhausted {
	/// Settle quietly after journaling the refusal in the ledger.
	Settle,
	/// Settle and increment refusals so `continuations()` surfaces the stop.
	#[default]
	Notify,
}

impl OnExhausted {
	fn parse(value: &str) -> Self {
		match value {
			"settle" => Self::Settle,
			_ => Self::Notify,
		}
	}

	fn as_str(self) -> &'static str {
		match self {
			Self::Settle => "settle",
			Self::Notify => "notify",
		}
	}
}

/// Per-extension recursive continuation policy (session-scoped enforcement).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ContinuationPolicy {
	/// Consecutive continuations since the last user submission.
	pub max_consecutive: u32,
	/// Optional lifetime total for this session.
	pub max_total:       Option<u32>,
	/// Minimum milliseconds between accepted Continuations.
	pub min_interval_ms: u64,
	/// Behavior when consecutive/total/interval refuses the next Continue.
	pub on_exhausted:    OnExhausted,
}

impl Default for ContinuationPolicy {
	fn default() -> Self {
		Self {
			max_consecutive: SETTLE_CONTINUATION_CAP,
			max_total:       None,
			min_interval_ms: 0,
			on_exhausted:    OnExhausted::Notify,
		}
	}
}

impl ContinuationPolicy {
	/// Clamps `max_consecutive` to the core ceiling and returns the effective
	/// policy.
	#[must_use]
	pub fn clamped(mut self) -> Self {
		self.max_consecutive = self.max_consecutive.min(SETTLE_CONTINUATION_CAP).max(1);
		self
	}

	fn from_wire(value: &JsonValue) -> Result<Self, Str> {
		let object = value
			.as_object()
			.ok_or_else(|| Str::new_static("policy must be an object"))?;
		let max_consecutive = object
			.get("max_consecutive")
			.and_then(JsonValue::as_u64)
			.ok_or_else(|| Str::new_static("policy.max_consecutive must be an integer"))?;
		let max_consecutive = u32::try_from(max_consecutive)
			.map_err(|_| Str::new_static("policy.max_consecutive out of range"))?;
		let max_total = match object.get("max_total") {
			None | Some(JsonValue::Null) => None,
			Some(value) => {
				let total = value
					.as_u64()
					.ok_or_else(|| Str::new_static("policy.max_total must be an integer or null"))?;
				Some(
					u32::try_from(total)
						.map_err(|_| Str::new_static("policy.max_total out of range"))?,
				)
			},
		};
		let min_interval_ms = object
			.get("min_interval_ms")
			.and_then(JsonValue::as_u64)
			.unwrap_or(0);
		let on_exhausted = object
			.get("on_exhausted")
			.and_then(JsonValue::as_str)
			.map_or(OnExhausted::Notify, OnExhausted::parse);
		Ok(Self { max_consecutive, max_total, min_interval_ms, on_exhausted }.clamped())
	}
}

/// Durable view of the session continuation budget.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContinuationLedger {
	/// Continuations since the last user submission.
	pub consecutive: u32,
	/// Continuations accepted in this session.
	pub total:       u32,
	/// Effective ceiling after clamping policy against the core cap.
	pub cap:         u32,
	/// Milliseconds since Unix epoch of the last accepted Continue.
	pub last_ms:     u64,
	/// Times a Continue was refused by policy or the core cap.
	pub refusals:    u32,
	/// Extension/label that owns the current consecutive streak.
	pub owner:       Option<Str>,
}

impl Default for ContinuationLedger {
	fn default() -> Self {
		Self {
			consecutive: 0,
			total:       0,
			cap:         SETTLE_CONTINUATION_CAP,
			last_ms:     0,
			refusals:    0,
			owner:       None,
		}
	}
}

impl ContinuationLedger {
	fn to_json(&self) -> JsonValue {
		json!({
			"consecutive": self.consecutive,
			"total": self.total,
			"cap": self.cap,
			"last_ms": self.last_ms,
			"refusals": self.refusals,
			"owner": self.owner.as_ref().map(Str::as_str),
		})
	}
}

#[derive(Debug, Default)]
struct State {
	ledger:   ContinuationLedger,
	policies: BTreeMap<Str, ContinuationPolicy>,
}

/// Shared session ledger + per-extension policies for `agent_settled`
/// Continues.
#[derive(Clone, Debug, Default)]
pub struct ContinuationBook {
	inner: Arc<Mutex<State>>,
}

/// Why [`ContinuationBook::try_accept`] refused a Continue.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ContinuationRefused {
	/// Effective cap that stopped the Continue.
	pub cap:          u32,
	/// Policy `on_exhausted` for the refused extension.
	pub on_exhausted: OnExhausted,
}

impl ContinuationBook {
	/// Empty ledger with no per-extension overrides.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Snapshot readable via `omp.agents.continuations()`.
	#[must_use]
	pub fn snapshot(&self) -> ContinuationLedger {
		self.inner.lock().ledger.clone()
	}

	/// JSON body for the CONTROL `omp.agents.continuations` operation.
	#[must_use]
	pub fn snapshot_json(&self) -> JsonValue {
		self.snapshot().to_json()
	}

	/// Installs or replaces one extension's policy (clamped to the core cap).
	pub fn set_policy(&self, extension: impl Into<Str>, policy: ContinuationPolicy) {
		let extension = extension.into();
		let policy = policy.clamped();
		let mut state = self.inner.lock();
		state.policies.insert(extension, policy);
		state.ledger.cap = policy.max_consecutive;
	}

	/// Parses and installs a policy from the CONTROL wire object.
	pub fn set_policy_wire(&self, extension: impl Into<Str>, policy: &JsonValue) -> Result<(), Str> {
		let policy = ContinuationPolicy::from_wire(policy)?;
		self.set_policy(extension, policy);
		Ok(())
	}

	/// Policy for `extension`, or the default clamped to the core cap.
	#[must_use]
	pub fn policy_for(&self, extension: &str) -> ContinuationPolicy {
		self
			.inner
			.lock()
			.policies
			.get(extension)
			.copied()
			.unwrap_or_default()
			.clamped()
	}

	/// Clears consecutive after a real user submission starts.
	pub fn reset_consecutive(&self) {
		let mut state = self.inner.lock();
		state.ledger.consecutive = 0;
		state.ledger.owner = None;
	}

	/// Records a core-cap refusal when the kernel stops calling `agent_settled`.
	pub fn record_core_refusal(&self) {
		let mut state = self.inner.lock();
		state.ledger.refusals = state.ledger.refusals.saturating_add(1);
		state.ledger.cap = SETTLE_CONTINUATION_CAP;
	}

	/// Debits the ledger when a Continue is accepted, or refuses it.
	pub fn try_accept(&self, extension: &str, owner: &str) -> Result<(), ContinuationRefused> {
		let mut state = self.inner.lock();
		let policy = state
			.policies
			.get(extension)
			.copied()
			.unwrap_or_default()
			.clamped();
		let now_ms = now_ms();
		let cap = policy.max_consecutive.min(SETTLE_CONTINUATION_CAP);
		state.ledger.cap = cap;
		if state.ledger.consecutive >= cap {
			state.ledger.refusals = state.ledger.refusals.saturating_add(1);
			return Err(ContinuationRefused { cap, on_exhausted: policy.on_exhausted });
		}
		if let Some(max_total) = policy.max_total
			&& state.ledger.total >= max_total
		{
			state.ledger.refusals = state.ledger.refusals.saturating_add(1);
			return Err(ContinuationRefused {
				cap:          max_total.min(cap),
				on_exhausted: policy.on_exhausted,
			});
		}
		if policy.min_interval_ms > 0
			&& state.ledger.last_ms > 0
			&& now_ms.saturating_sub(state.ledger.last_ms) < policy.min_interval_ms
		{
			state.ledger.refusals = state.ledger.refusals.saturating_add(1);
			return Err(ContinuationRefused { cap, on_exhausted: policy.on_exhausted });
		}
		state.ledger.consecutive = state.ledger.consecutive.saturating_add(1);
		state.ledger.total = state.ledger.total.saturating_add(1);
		state.ledger.last_ms = now_ms;
		state.ledger.owner = Some(Str::from(owner));
		Ok(())
	}

	/// Handles CONTROL ops owned by this book.
	pub fn handle_control(
		&self,
		extension: &str,
		operation: &str,
		arguments: &JsonMap<String, JsonValue>,
	) -> Result<Option<JsonValue>, Str> {
		match operation {
			"omp.agents.continuations" => Ok(Some(self.snapshot_json())),
			"omp.agents.set_continuation_policy" => {
				let policy = arguments
					.get("policy")
					.ok_or_else(|| Str::new_static("set_continuation_policy requires policy"))?;
				self.set_policy_wire(extension, policy)?;
				Ok(Some(JsonValue::Null))
			},
			_ => Ok(None),
		}
	}
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|duration| duration.as_millis() as u64)
		.unwrap_or(0)
}

/// Grant an extension must hold before `omp.agents.set_continuation_policy`
/// changes its continuation policy. Reading `omp.agents.continuations` and
/// returning `Continue` from an `agent_settled` hook need no grant.
pub const CONTINUATION_CAPABILITY: &str = "agents.continuation";

fn continuation_authority_denied() -> ControlProtocolError {
	const REASON: &str =
		"continuation authority (`agents.continuation`) is not granted to this extension";
	ControlProtocolError::new("PolicyDenied", REASON).with_details(json!({
		"reason": REASON,
		"code": "capability_denied",
		"decision_id": "",
		"rules": [],
	}))
}

fn is_continuation_control(operation: &str) -> bool {
	matches!(operation, "omp.agents.continuations" | "omp.agents.set_continuation_policy")
}

fn same_control_connection(
	expected: &ControlConnectionIdentity,
	actual: &ControlConnectionIdentity,
) -> bool {
	expected.extension == actual.extension
		&& expected.principal == actual.principal
		&& expected.artifact_digest == actual.artifact_digest
		&& expected.layer == actual.layer
		&& expected.tier == actual.tier
		&& expected.trust == actual.trust
		&& expected.host_generation == actual.host_generation
		&& expected.session_generation == actual.session_generation
		&& expected.capabilities == actual.capabilities
}

/// Agents factory that owns session continuation CONTROL and forwards the rest.
pub struct ContinuationAwareAgentsFactory {
	book:  ContinuationBook,
	inner: Arc<dyn ControlAuthorityFactory>,
}

impl ContinuationAwareAgentsFactory {
	/// Wraps `inner` so continuation ledger ops stay session-local.
	#[must_use]
	pub fn new(book: ContinuationBook, inner: Arc<dyn ControlAuthorityFactory>) -> Self {
		Self { book, inner }
	}
}

impl ControlAuthorityFactory for ContinuationAwareAgentsFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		Ok(Arc::new(ContinuationAwareAgentsAuthority {
			book: self.book.clone(),
			inner: self.inner.bind(Arc::clone(&identity))?,
			identity,
		}))
	}
}

struct ContinuationAwareAgentsAuthority {
	book:     ContinuationBook,
	inner:    Arc<dyn ControlAuthority>,
	identity: Arc<ControlConnectionIdentity>,
}

#[async_trait::async_trait]
impl ControlAuthority for ContinuationAwareAgentsAuthority {
	fn handles(&self, operation: &str) -> bool {
		is_continuation_control(operation) || self.inner.handles(operation)
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		operation: &str,
		arguments: &JsonMap<String, JsonValue>,
	) -> Result<(), ControlProtocolError> {
		if !same_control_connection(&self.identity, &context.connection) {
			return Err(ControlProtocolError::new(
				"StaleGeneration",
				"Agents authority belongs to a replaced extension-host connection",
			));
		}
		if operation == "omp.agents.set_continuation_policy"
			&& !self.identity.capabilities.contains(CONTINUATION_CAPABILITY)
		{
			return Err(continuation_authority_denied());
		}
		if is_continuation_control(operation) {
			return Ok(());
		}
		self.inner.authorize(context, operation, arguments)
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: JsonMap<String, JsonValue>,
	) -> Result<JsonValue, ControlProtocolError> {
		self.authorize(&context, operation.as_str(), &arguments)?;
		if let Some(value) = self
			.book
			.handle_control(self.identity.extension.as_str(), operation.as_str(), &arguments)
			.map_err(|message| ControlProtocolError::new("InvalidArgument", message))?
		{
			return Ok(value);
		}
		self.inner.request(context, operation, arguments).await
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		self.inner.effect(context, effect).await
	}
}

#[cfg(test)]
mod tests {
	use std::collections::BTreeSet;

	use omp_core::{Principal, sf};

	use super::*;

	#[test]
	fn clamps_max_consecutive_to_core_cap() {
		let book = ContinuationBook::new();
		book.set_policy("goal", ContinuationPolicy {
			max_consecutive: 100,
			max_total:       None,
			min_interval_ms: 0,
			on_exhausted:    OnExhausted::Notify,
		});
		assert_eq!(book.policy_for("goal").max_consecutive, SETTLE_CONTINUATION_CAP);
		assert_eq!(book.snapshot().cap, SETTLE_CONTINUATION_CAP);
	}

	#[test]
	fn try_accept_enforces_consecutive_and_resets() {
		let book = ContinuationBook::new();
		book.set_policy("goal", ContinuationPolicy {
			max_consecutive: 2,
			max_total:       None,
			min_interval_ms: 0,
			on_exhausted:    OnExhausted::Settle,
		});
		assert!(book.try_accept("goal", "goal").is_ok());
		assert!(book.try_accept("goal", "goal").is_ok());
		assert!(book.try_accept("goal", "goal").is_err());
		assert_eq!(book.snapshot().refusals, 1);
		book.reset_consecutive();
		assert!(book.try_accept("goal", "goal").is_ok());
		assert_eq!(book.snapshot().consecutive, 1);
		assert_eq!(book.snapshot().total, 3);
	}

	#[test]
	fn control_wire_round_trips_policy() {
		let book = ContinuationBook::new();
		let mut args = JsonMap::new();
		args.insert(
			"policy".to_owned(),
			json!({
				"max_consecutive": 3,
				"max_total": 10,
				"min_interval_ms": 1000,
				"on_exhausted": "settle",
			}),
		);
		assert_eq!(
			book
				.handle_control("ext", "omp.agents.set_continuation_policy", &args)
				.expect("ok"),
			Some(JsonValue::Null)
		);
		let policy = book.policy_for("ext");
		assert_eq!(policy.max_consecutive, 3);
		assert_eq!(policy.max_total, Some(10));
		assert_eq!(policy.min_interval_ms, 1000);
		assert_eq!(policy.on_exhausted, OnExhausted::Settle);
		assert_eq!(policy.on_exhausted.as_str(), "settle");
	}
	struct NoInner;

	#[async_trait::async_trait]
	impl ControlAuthority for NoInner {
		fn handles(&self, _operation: &str) -> bool {
			false
		}

		fn authorize(
			&self,
			_context: &ControlRequestContext,
			_operation: &str,
			_arguments: &JsonMap<String, JsonValue>,
		) -> Result<(), ControlProtocolError> {
			Err(ControlProtocolError::new("Unsupported", "no inner authority in this test"))
		}

		async fn request(
			&self,
			_context: ControlRequestContext,
			_operation: Str,
			_arguments: JsonMap<String, JsonValue>,
		) -> Result<JsonValue, ControlProtocolError> {
			Err(ControlProtocolError::new("Unsupported", "no inner authority in this test"))
		}

		async fn effect(
			&self,
			_context: ControlRequestContext,
			_effect: ControlEffect,
		) -> Result<(), ControlProtocolError> {
			Err(ControlProtocolError::new("Unsupported", "no inner authority in this test"))
		}
	}

	fn identity_with(capabilities: &[&'static str]) -> Arc<ControlConnectionIdentity> {
		Arc::new(ControlConnectionIdentity {
			extension:          sf!("dev.example.goal"),
			principal:          Principal::new(sf!("test"), sf!("Test")),
			artifact_digest:    sf!("sha256:test"),
			layer:              sf!("project"),
			tier:               sf!("trusted"),
			trust:              sf!("trusted"),
			host_generation:    1,
			session_generation: 1,
			capabilities:       Arc::new(
				capabilities
					.iter()
					.copied()
					.map(Str::new_static)
					.collect::<BTreeSet<_>>(),
			),
		})
	}

	fn bound(
		book: &ContinuationBook,
		identity: &Arc<ControlConnectionIdentity>,
	) -> Arc<dyn ControlAuthority> {
		let inner: Arc<dyn ControlAuthorityFactory> = Arc::new(
			|_identity: Arc<ControlConnectionIdentity>| -> Result<
				Arc<dyn ControlAuthority>,
				ControlCompositionError,
			> { Ok(Arc::new(NoInner)) },
		);
		ContinuationAwareAgentsFactory::new(book.clone(), inner)
			.bind(Arc::clone(identity))
			.expect("bind continuation authority")
	}

	fn context(identity: &Arc<ControlConnectionIdentity>) -> ControlRequestContext {
		ControlRequestContext { connection: Arc::clone(identity), request_id: 1, invocation: None }
	}

	fn policy_args() -> JsonMap<String, JsonValue> {
		let mut args = JsonMap::new();
		args.insert(
			"policy".to_owned(),
			json!({
				"max_consecutive": 3,
				"max_total": 10,
				"min_interval_ms": 0,
				"on_exhausted": "settle",
			}),
		);
		args
	}

	#[tokio::test]
	async fn set_policy_without_grant_is_policy_denied() {
		let book = ContinuationBook::new();
		let identity = identity_with(&["agents.continuations"]);
		let error = bound(&book, &identity)
			.request(
				context(&identity),
				Str::new_static("omp.agents.set_continuation_policy"),
				policy_args(),
			)
			.await
			.expect_err("set_continuation_policy without agents.continuation must be denied");
		assert_eq!(error.code.as_str(), "PolicyDenied");
		assert_eq!(error.details["code"], "capability_denied");
		assert_eq!(error.details["decision_id"], "");
		assert_eq!(error.details["rules"], json!([]));
		assert!(
			error.details["reason"]
				.as_str()
				.is_some_and(|reason| reason.contains("agents.continuation"))
		);
		assert_eq!(book.policy_for("dev.example.goal"), ContinuationPolicy::default());
	}

	#[tokio::test]
	async fn set_policy_with_grant_is_applied() {
		let book = ContinuationBook::new();
		let identity = identity_with(&["agents.continuation"]);
		let value = bound(&book, &identity)
			.request(
				context(&identity),
				Str::new_static("omp.agents.set_continuation_policy"),
				policy_args(),
			)
			.await
			.expect("granted set_continuation_policy");
		assert_eq!(value, JsonValue::Null);
		assert_eq!(book.policy_for("dev.example.goal").max_consecutive, 3);
	}

	#[tokio::test]
	async fn reading_continuations_needs_no_grant() {
		let book = ContinuationBook::new();
		let identity = identity_with(&[]);
		bound(&book, &identity)
			.request(context(&identity), Str::new_static("omp.agents.continuations"), JsonMap::new())
			.await
			.expect("reading continuations needs no grant");
	}
}
