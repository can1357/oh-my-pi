use std::{
	collections::BTreeMap,
	ffi::CString,
	fmt::{self, Display},
	path::PathBuf,
	process,
	sync::{
		Arc, OnceLock,
		atomic::{AtomicU64, Ordering},
	},
	time::Duration,
};

use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt as _;
use im::OrdSet;
use omp_core::{ExposeSecret as _, IntoStr, SecretString, Str, Ulid, sf};
use omp_proto::toolhost::v1::PreludeParamKind;
use omp_tool::{
	CapsBase, Diag, DiagEnvelope, ErasedEv, ErasedOutcome, IncomingParams, ModelClass, Part,
	PromptCaps, Registry, ToolIdentity, ToolRoute,
};
use omp_tools::eval::{RuntimeSnapshot, idle_timeout::TimeoutHandle, kernel::NamespaceInstaller};
use parking_lot::Mutex;
use pyo3::{
	exceptions::PyRuntimeError,
	prelude::*,
	types::{PyAny, PyDict, PyModule},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::{runtime::Handle, time};
use tokio_util::sync::CancellationToken;

use super::PYTHON_PRELUDE;

const COMPLETION: &str = "__completion__";
const AGENT: &str = "__agent__";
const WORKPOOL: &str = "__workpool__";
const CONCURRENCY: &str = "__concurrency__";
const BUDGET: &str = "__budget__";
/// Wire prefix reserved for extension-provided eval prelude helpers.
pub const PRELUDE_PREFIX: &str = "__prelude__:";

/// Names installed by the built-in Python prelude and unavailable to
/// extensions.
pub const PRELUDE_RESERVED_NAMES: &[&str] = &[
	"display",
	"read",
	"write",
	"env",
	"output",
	"tool",
	"completion",
	"agent",
	"workpool",
	"WorkPool",
	"parallel",
	"pipeline",
	"log",
	"phase",
	"budget",
	"Path",
	"os",
	"json",
	"math",
	"re",
	"unquote",
];
/// Hard Python keywords that cannot be called as Python helper names.
pub const PRELUDE_PYTHON_KEYWORDS: &[&str] = &[
	"and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
	"else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda",
	"nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "False", "None",
	"True", "yield",
];

/// One structured parameter in an extension-provided prelude helper.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreludeParamStub {
	/// Parameter name.
	pub name:         Str,
	/// Supported Python parameter kind.
	pub kind:         PreludeParamKind,
	/// JSON-encoded default, or `None` when the parameter is required.
	pub default_json: Option<Str>,
	/// Display-only annotation text.
	pub annotation:   Option<Str>,
}

/// An extension-provided helper projected into the Python eval namespace.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreludeHelper {
	/// Eval-namespace helper name.
	pub name:      Str,
	/// Worker revision string in the `prelude.<n>` family.
	pub rev:       Str,
	/// Complete Python docstring.
	pub doc:       Str,
	/// One-line prompt description.
	pub summary:   Str,
	/// Structured Python parameters.
	pub params:    Vec<PreludeParamStub>,
	/// Pre-rendered prompt signature.
	pub signature: Str,
}

impl PreludeHelper {
	/// Creates a helper and renders its stable prompt signature.
	pub fn new(name: Str, rev: Str, doc: Str, summary: Str, params: Vec<PreludeParamStub>) -> Self {
		let mut signature = String::with_capacity(
			name.len()
				+ params
					.iter()
					.map(|param| param.name.len() + 4)
					.sum::<usize>()
				+ 2,
		);
		signature.push_str(name.as_str());
		signature.push('(');
		let mut first = true;
		let mut keyword_only = false;
		for param in &params {
			if matches!(param.kind, PreludeParamKind::KeywordOnly) && !keyword_only {
				if !first {
					signature.push_str(", ");
				}
				signature.push('*');
				first = false;
				keyword_only = true;
			}
			if !first {
				signature.push_str(", ");
			}
			signature.push_str(param.name.as_str());
			if let Some(annotation) = &param.annotation {
				signature.push_str(": ");
				signature.push_str(annotation.as_str());
			}
			if let Some(default_json) = &param.default_json {
				signature.push('=');
				let value = serde_json::from_str(default_json.as_str())
					.expect("prelude defaults are validated before helper construction");
				push_python_literal(&mut signature, &value);
			}
			first = false;
		}
		signature.push(')');
		Self { name, rev, doc, summary, params, signature: Str::from(signature) }
	}
}
fn push_python_literal(output: &mut String, value: &Value) {
	match value {
		Value::Null => output.push_str("None"),
		Value::Bool(true) => output.push_str("True"),
		Value::Bool(false) => output.push_str("False"),
		Value::Number(number) => fmt::Write::write_fmt(output, format_args!("{number}"))
			.expect("writing to a String cannot fail"),
		Value::String(text) => {
			output.push_str(
				serde_json::to_string(text)
					.expect("JSON strings always serialize")
					.as_str(),
			);
		},
		Value::Array(items) => {
			output.push('[');
			for (index, item) in items.iter().enumerate() {
				if index > 0 {
					output.push_str(", ");
				}
				push_python_literal(output, item);
			}
			output.push(']');
		},
		Value::Object(fields) => {
			output.push('{');
			for (index, (name, field)) in fields.iter().enumerate() {
				if index > 0 {
					output.push_str(", ");
				}
				output.push_str(
					serde_json::to_string(name)
						.expect("JSON object keys always serialize")
						.as_str(),
				);
				output.push_str(": ");
				push_python_literal(output, field);
			}
			output.push('}');
		},
	}
}

/// Immutable-at-bind table of extension-provided prelude helpers.
#[derive(Debug, Default)]
pub struct PreludeTable {
	helpers: BTreeMap<Str, Arc<PreludeHelper>>,
}

impl PreludeTable {
	/// Creates an empty helper table.
	pub const fn new() -> Self {
		Self { helpers: BTreeMap::new() }
	}

	/// Inserts a helper, returning the previous declaration for the same name.
	pub fn insert(&mut self, helper: PreludeHelper) -> Option<Arc<PreludeHelper>> {
		self.helpers.insert(helper.name.clone(), Arc::new(helper))
	}

	/// Looks up a helper without allocating a query key.
	pub fn get(&self, name: &str) -> Option<&Arc<PreludeHelper>> {
		self.helpers.get(name)
	}

	/// Iterates helpers in deterministic name order.
	pub fn helpers(&self) -> impl DoubleEndedIterator<Item = &PreludeHelper> + ExactSizeIterator {
		self.helpers.values().map(Arc::as_ref)
	}
}

/// Serializable helper metadata sent once when an eval child starts.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PreludeStubWire {
	pub(crate) name:   Str,
	pub(crate) doc:    Str,
	pub(crate) params: Vec<PreludeParamWire>,
}

/// Serializable helper parameter metadata sent to the eval child.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PreludeParamWire {
	pub(crate) name:         Str,
	pub(crate) keyword_only: bool,
	pub(crate) default_json: Option<Str>,
	pub(crate) annotation:   Option<Str>,
}

impl From<&PreludeHelper> for PreludeStubWire {
	fn from(helper: &PreludeHelper) -> Self {
		Self {
			name:   helper.name.clone(),
			doc:    helper.doc.clone(),
			params: helper
				.params
				.iter()
				.map(|param| PreludeParamWire {
					name:         param.name.clone(),
					keyword_only: matches!(param.kind, PreludeParamKind::KeywordOnly),
					default_json: param.default_json.clone(),
					annotation:   param.annotation.clone(),
				})
				.collect(),
		}
	}
}

/// Capabilities granted to one eval cell. Tool names are explicit: possessing a
/// bridge grant never implies access to every tool registered in the session.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct BridgeCapabilities {
	tools:       OrdSet<Str>,
	prelude:     OrdSet<Str>,
	completion:  bool,
	agent:       bool,
	workpool:    bool,
	concurrency: bool,
	budget:      bool,
}

impl BridgeCapabilities {
	pub(crate) fn new(tools: impl IntoIterator<Item = Str>) -> Self {
		Self { tools: tools.into_iter().collect(), ..Self::default() }
	}

	pub(crate) const fn with_completion(mut self) -> Self {
		self.completion = true;
		self
	}

	pub(crate) const fn with_agent(mut self) -> Self {
		self.agent = true;
		self
	}

	pub(crate) const fn with_workpool(mut self) -> Self {
		self.workpool = true;
		self
	}

	pub(crate) const fn with_concurrency(mut self) -> Self {
		self.concurrency = true;
		self
	}

	pub(crate) const fn with_budget(mut self) -> Self {
		self.budget = true;
		self
	}

	pub(crate) fn with_prelude(mut self, helpers: impl IntoIterator<Item = Str>) -> Self {
		self.prelude.extend(helpers);
		self
	}

	pub(super) fn allows(&self, name: &str) -> bool {
		if let Some(helper) = name.strip_prefix(PRELUDE_PREFIX) {
			return self
				.prelude
				.iter()
				.any(|allowed| allowed.as_str() == helper);
		}
		match name {
			COMPLETION => self.completion,
			AGENT => self.agent,
			WORKPOOL => self.workpool,
			CONCURRENCY => self.concurrency,
			BUDGET => self.budget,
			_ => self.tools.iter().any(|tool| tool.as_str() == name),
		}
	}

	pub(super) fn allowed_names(&self) -> Vec<Str> {
		let mut names = self.tools.iter().cloned().collect::<Vec<_>>();
		names.extend(
			self
				.prelude
				.iter()
				.map(|helper| sf!("{PRELUDE_PREFIX}{helper}")),
		);
		if self.completion {
			names.push(sf!(COMPLETION));
		}
		if self.agent {
			names.push(sf!(AGENT));
		}
		if self.workpool {
			names.push(sf!(WORKPOOL));
		}
		if self.concurrency {
			names.push(sf!(CONCURRENCY));
		}
		if self.budget {
			names.push(sf!(BUDGET));
		}
		names
	}

	pub(super) fn from_allowed_names(names: impl IntoIterator<Item = Str>) -> Self {
		let mut capabilities = Self::default();
		for name in names {
			if let Some(helper) = name.strip_prefix(PRELUDE_PREFIX) {
				capabilities.prelude.insert(Str::new(helper));
				continue;
			}
			match name.as_str() {
				COMPLETION => capabilities.completion = true,
				AGENT => capabilities.agent = true,
				WORKPOOL => capabilities.workpool = true,
				CONCURRENCY => capabilities.concurrency = true,
				BUDGET => capabilities.budget = true,
				_ => {
					capabilities.tools.insert(name);
				},
			}
		}
		capabilities
	}
}

#[derive(Clone)]
pub struct BridgeGrant {
	session:    Str,
	run:        Str,
	token:      SecretString,
	generation: Ulid,
}

impl fmt::Debug for BridgeGrant {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("BridgeGrant")
			.field("session", &self.session)
			.field("run", &self.run)
			.field("token", &"[REDACTED]")
			.field("generation", &self.generation)
			.finish()
	}
}

/// Failure returned by the authenticated host operation serving an eval bridge
/// call.
#[derive(Debug, Error)]
pub enum BridgeHostError {
	/// Model-facing failure message produced by the host-side operation.
	#[error("{0}")]
	Message(Str),
	/// Canonical policy denial produced before a child session exists.
	#[error("child session spawn was denied by policy")]
	PolicyDenied(Arc<omp_tool::PolicyDenied>),
}

impl BridgeHostError {
	/// Constructs a model-facing bridge failure with the provided message.
	pub fn message(message: impl IntoStr) -> Self {
		Self::Message(message.into_str())
	}
}

/// Correlated, ordered progress destination for one bridge request.
pub trait BridgeProgressSink: Send + Sync {
	/// Emits one bounded progress event before the terminal response.
	fn progress(&self, event: Value) -> Result<(), BridgeHostError>;
}

/// Progress sink used when a caller does not consume intermediate events.
pub struct NoopBridgeProgress;

impl BridgeProgressSink for NoopBridgeProgress {
	fn progress(&self, _event: Value) -> Result<(), BridgeHostError> {
		Ok(())
	}
}

/// Real host-side boundary used for ordinary tools and the privileged eval
/// completion/agent/workpool/budget operations. Implementations receive only
/// calls that passed grant authentication and capability checks.
#[async_trait]
pub trait BridgeHost: Send + Sync {
	/// Dispatches one authenticated, capability-checked eval request into the
	/// host.
	///
	/// Progress is emitted in request order before the returned terminal value.
	async fn call(
		&self,
		name: &str,
		args: Value,
		progress: &dyn BridgeProgressSink,
	) -> Result<Value, BridgeHostError>;
}
/// Cold worker-IPC boundary for extension-provided prelude helpers.
#[async_trait]
pub trait PreludeInvoker: Send + Sync {
	/// Invokes one revision-pinned helper with signature-bound arguments.
	async fn invoke(&self, name: &str, rev: &str, args: Value) -> Result<Value, BridgeHostError>;
}

#[async_trait]
pub(super) trait ChildBridgeTransport: Send + Sync {
	fn capabilities(&self) -> BridgeCapabilities;
	async fn call(
		&self,
		name: &str,
		args: Value,
		progress: &dyn BridgeProgressSink,
	) -> Result<Value, BridgeHostError>;
}

struct Registration {
	grant:        BridgeGrant,
	capabilities: BridgeCapabilities,
	host:         Arc<dyn BridgeHost>,
	timeout:      TimeoutHandle,
}

struct DispatcherInner {
	registrations: Mutex<BTreeMap<(Str, Str), Registration>>,
}

/// Cloneable dispatcher for generation-fenced eval bridge registrations.
///
/// Registrations remain live through their separate registration leases;
/// cloning this handle only shares access to the routing table and does not
/// extend a registration's lifetime.
#[derive(Clone)]
pub struct BridgeDispatcher {
	inner: Arc<DispatcherInner>,
}

impl BridgeDispatcher {
	pub(crate) fn new() -> Self {
		Self { inner: Arc::new(DispatcherInner { registrations: Mutex::new(BTreeMap::new()) }) }
	}

	pub(crate) fn register(
		&self,
		session: Str,
		run: Str,
		capabilities: BridgeCapabilities,
		host: Arc<dyn BridgeHost>,
		timeout: TimeoutHandle,
	) -> Result<BridgeRegistration, BridgeCallError> {
		if session.is_empty() || run.is_empty() {
			return Err(BridgeCallError::InvalidRegistration);
		}
		let key = (session.clone(), run.clone());
		let mut registrations = self.inner.registrations.lock();
		if registrations.contains_key(&key) {
			return Err(BridgeCallError::AlreadyRegistered { session, run });
		}
		let grant = BridgeGrant {
			session,
			run,
			token: SecretString::from(Ulid::generate().to_string()),
			generation: Ulid::generate(),
		};
		registrations.insert(key, Registration {
			grant: grant.clone(),
			capabilities: capabilities.clone(),
			host,
			timeout,
		});
		drop(registrations);
		Ok(BridgeRegistration {
			lease: Arc::new(RegistrationLease { dispatcher: self.clone(), grant, capabilities }),
		})
	}

	async fn dispatch(
		&self,
		grant: &BridgeGrant,
		name: &str,
		args: Value,
		progress: &dyn BridgeProgressSink,
	) -> Result<Value, BridgeCallError> {
		let (host, timeout) = {
			let registrations = self.inner.registrations.lock();
			let entry = registrations
				.get(&(grant.session.clone(), grant.run.clone()))
				.ok_or_else(|| BridgeCallError::NoActiveSession {
					session: grant.session.clone(),
					run:     grant.run.clone(),
				})?;
			if entry.grant.generation != grant.generation
				|| entry.grant.token.expose_secret() != grant.token.expose_secret()
			{
				return Err(BridgeCallError::AuthenticationFailed);
			}
			if !entry.capabilities.allows(name) {
				return Err(BridgeCallError::CapabilityDenied { name: Str::from(name) });
			}
			(Arc::clone(&entry.host), entry.timeout.clone())
		};

		timeout
			.host_wait(host.call(name, args, progress))
			.await
			.map_err(|error| BridgeCallError::Host { message: Str::from(error.to_string()) })
	}

	fn unregister(&self, grant: &BridgeGrant) {
		let key = (grant.session.clone(), grant.run.clone());
		let mut registrations = self.inner.registrations.lock();
		if registrations
			.get(&key)
			.is_some_and(|entry| entry.grant.generation == grant.generation)
		{
			registrations.remove(&key);
		}
	}
}

#[must_use]
struct RegistrationLease {
	dispatcher:   BridgeDispatcher,
	grant:        BridgeGrant,
	capabilities: BridgeCapabilities,
}

impl Drop for RegistrationLease {
	fn drop(&mut self) {
		self.dispatcher.unregister(&self.grant);
	}
}

pub struct BridgeRegistration {
	lease: Arc<RegistrationLease>,
}

impl BridgeRegistration {
	pub(crate) fn client(&self) -> BridgeClient {
		BridgeClient {
			dispatcher: self.lease.dispatcher.clone(),
			grant:      self.lease.grant.clone(),
			abort:      None,
			_lease:     Arc::clone(&self.lease),
		}
	}
}

#[derive(Default)]
struct CellAbort {
	active: Mutex<Option<(Bytes, CancellationToken)>>,
}

impl CellAbort {
	fn begin(&self, cell_id: &Bytes) {
		let stale = self
			.active
			.lock()
			.replace((cell_id.clone(), CancellationToken::new()));
		if let Some((_, stale)) = stale {
			stale.cancel();
		}
	}

	fn end(&self, cell_id: &Bytes) {
		let mut active = self.active.lock();
		if active
			.as_ref()
			.is_some_and(|(current, _)| current == cell_id)
			&& let Some((_, token)) = active.take()
		{
			token.cancel();
		}
	}

	fn cancel(&self, cell_id: &Bytes) {
		let token = self
			.active
			.lock()
			.as_ref()
			.filter(|(current, _)| current == cell_id)
			.map(|(_, token)| token.clone());
		if let Some(token) = token {
			token.cancel();
		}
	}

	fn cancel_active(&self) {
		let active = self.active.lock().take();
		if let Some((_, token)) = active {
			token.cancel();
		}
	}

	fn token(&self) -> Option<CancellationToken> {
		self.active.lock().as_ref().map(|(_, token)| token.clone())
	}
}

#[derive(Clone)]
pub struct BridgeClient {
	dispatcher: BridgeDispatcher,
	grant:      BridgeGrant,
	abort:      Option<Arc<CellAbort>>,
	_lease:     Arc<RegistrationLease>,
}

impl BridgeClient {
	pub(crate) async fn call_with_progress(
		&self,
		name: &str,
		args: Value,
		progress: &dyn BridgeProgressSink,
	) -> Result<Value, BridgeCallError> {
		let Some(abort) = &self.abort else {
			return self
				.dispatcher
				.dispatch(&self.grant, name, args, progress)
				.await;
		};
		let token = abort.token().ok_or(BridgeCallError::NoActiveCell)?;
		tokio::select! {
			result = self.dispatcher.dispatch(&self.grant, name, args, progress) => result,
			() = token.cancelled() => Err(BridgeCallError::CellCancelled),
		}
	}

	fn with_abort(mut self, abort: Arc<CellAbort>) -> Self {
		self.abort = Some(abort);
		self
	}

	fn session(&self) -> &str {
		self.grant.session.as_str()
	}

	fn allowed_names(&self) -> Vec<Str> {
		self._lease.capabilities.allowed_names()
	}

	fn revoke(&self) {
		self.dispatcher.unregister(&self.grant);
	}
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum BridgeCallError {
	#[error("eval bridge registration requires non-empty session and run ids")]
	InvalidRegistration,
	#[error("eval bridge session is already registered: {session}:{run}")]
	AlreadyRegistered { session: Str, run: Str },
	#[error("No active Python tool bridge session: {session}:{run}")]
	NoActiveSession { session: Str, run: Str },
	#[error("eval bridge authentication failed")]
	AuthenticationFailed,
	#[error("eval bridge call has no active cell")]
	NoActiveCell,
	#[error("eval bridge host call cancelled")]
	CellCancelled,
	#[error("bridge capability denied: {name}")]
	CapabilityDenied { name: Str },
	#[error("{message}")]
	Host { message: Str },
}

/// Adapter for the native tools in the exact environment registry. Privileged
/// names such as `__agent__` remain separate host capabilities and are never
/// silently translated into ordinary registry tools.
pub struct RegistryBridgeHost {
	registry: Arc<Registry>,
}

impl RegistryBridgeHost {
	pub(crate) const fn new(registry: Arc<Registry>) -> Self {
		Self { registry }
	}
}

#[async_trait]
impl BridgeHost for RegistryBridgeHost {
	async fn call(
		&self,
		name: &str,
		mut args: Value,
		progress: &dyn BridgeProgressSink,
	) -> Result<Value, BridgeHostError> {
		let Some((live_name, revision)) = self.registry.live_identity(name) else {
			return Err(BridgeHostError::message(format!("Unknown tool from py runtime: {name}")));
		};
		if !matches!(self.registry.route(name).map_err(registry_error)?, ToolRoute::Native) {
			return Err(BridgeHostError::message(format!(
				"Tool from py runtime is not available through the native eval bridge: {name}"
			)));
		}
		let identity = ToolIdentity { name: live_name.clone(), rev: revision.clone() };
		if let Some(object) = args.as_object_mut() {
			object.remove("i");
		}
		let raw = serde_json::to_string(&args).map_err(|error| {
			BridgeHostError::message(format!("bridge arguments are not JSON: {error}"))
		})?;
		let (feed, params) = IncomingParams::channel();
		feed
			.arg_text(Str::from(raw.as_str()))
			.map_err(|error| BridgeHostError::message(error.to_string()))?;
		feed
			.args_committed(Str::from(raw))
			.map_err(|error| BridgeHostError::message(error.to_string()))?;
		let mut events = self.registry.invoke(name, params).map_err(registry_error)?;
		let mut diags = Vec::<Diag>::new();
		while let Some(event) = events.next().await {
			match event.map_err(registry_error)? {
				ErasedEv::Update(update) => {
					if let Ok(envelope) = serde_json::from_slice::<DiagEnvelope>(&update) {
						diags.push(envelope.diag);
						continue;
					}
					let update: Value = serde_json::from_slice(&update).map_err(|error| {
						BridgeHostError::message(format!(
							"tool {name} returned invalid update JSON: {error}"
						))
					})?;
					progress.progress(json!({ "op": "tool", "name": name, "update": update }))?;
				},
				ErasedEv::Done(ErasedOutcome::Detached(job)) => {
					let value = serde_json::to_value(job)
						.map_err(|error| BridgeHostError::message(error.to_string()))?;
					return attach_diags(value, diags);
				},
				ErasedEv::Done(ErasedOutcome::Done { verdict, .. }) => {
					let projected = self
						.registry
						.project_verdict(
							&identity,
							&verdict,
							false,
							&PromptCaps::for_tool(
								CapsBase {
									maximum_parts:      u16::MAX,
									maximum_text_bytes: u32::MAX,
									media:              true,
									model_class:        ModelClass::Standard,
								},
								&identity.rev,
							),
						)
						.map_err(registry_error)?;
					let mut value = projected_parts(projected.parts.as_ref().to_vec())?;
					if projected.is_error {
						match &mut value {
							Value::Object(object) => {
								object.insert("hasError".to_owned(), Value::Bool(true));
							},
							_ => value = json!({ "text": value, "hasError": true }),
						}
					}
					return attach_diags(value, diags);
				},
			}
		}
		Err(BridgeHostError::message(format!("tool {name} ended without a terminal result")))
	}
}

fn attach_diags(mut value: Value, diags: Vec<Diag>) -> Result<Value, BridgeHostError> {
	if diags.is_empty() {
		return Ok(value);
	}
	let diags =
		serde_json::to_value(diags).map_err(|error| BridgeHostError::message(error.to_string()))?;
	match &mut value {
		Value::Object(object) => {
			object.insert("diags".to_owned(), diags);
		},
		_ => value = json!({ "result": value, "diags": diags }),
	}
	Ok(value)
}

/// Optional capabilities owned by the live parent agent session.
///
/// The environment never synthesizes these operations. A session composition
/// that can perform them supplies this authenticated callback; otherwise the
/// corresponding bridge names are omitted from the grant.
#[async_trait]
pub trait ParentSessionHost: Send + Sync {
	/// Freezes the filesystem and managed-environment authority of the current
	/// parent session.
	fn eval_session_config(&self) -> Result<EvalSessionConfig, BridgeHostError>;

	/// Releases process-local child schedulers when this authenticated parent
	/// binding is retired or replaced. Durable observations remain journaled.
	fn release_eval_owner(&self) {}

	/// Whether this parent owns a completion implementation.
	fn completion_available(&self) -> bool {
		true
	}

	/// Runs a parent-session model completion and forwards ordered progress to
	/// the eval caller.
	async fn completion(
		&self,
		args: Value,
		progress: &dyn BridgeProgressSink,
	) -> Result<Value, BridgeHostError>;
	/// Whether this parent owns a child-agent implementation.
	fn agent_available(&self) -> bool {
		true
	}

	/// Runs a parent-session child agent and forwards ordered progress to the
	/// eval caller.
	async fn agent(
		&self,
		args: Value,
		progress: &dyn BridgeProgressSink,
	) -> Result<Value, BridgeHostError>;
	/// Whether this parent owns a live workpool scheduler. Capability
	/// advertisement is withheld until this returns true.
	fn workpool_available(&self) -> bool {
		false
	}

	/// Creates or operates a parent-owned persistent subagent workpool.
	async fn workpool(
		&self,
		args: Value,
		progress: &dyn BridgeProgressSink,
	) -> Result<Value, BridgeHostError> {
		let _ = (args, progress);
		Err(BridgeHostError::message("eval workpool is unavailable for this parent session"))
	}
	/// Whether this parent owns concurrency controls.
	fn concurrency_available(&self) -> bool {
		true
	}

	/// Applies the parent session's concurrency operation to extension-supplied
	/// arguments.
	async fn concurrency(&self, args: Value) -> Result<Value, BridgeHostError>;
	/// Whether this parent owns budget controls.
	fn budget_available(&self) -> bool {
		true
	}

	/// Reads or updates parent-session budget state using extension-supplied
	/// arguments.
	async fn budget(&self, args: Value) -> Result<Value, BridgeHostError>;
}

/// Filesystem authority projected by a live parent session into one eval run.
///
/// Session and artifact access never enters the child environment: `output()`
/// uses the authenticated Read bridge against journal-derived agent/job views
/// and the session CAS.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvalSessionConfig {
	/// Environment-authorized working directory for each cell.
	pub cwd:              PathBuf,
	/// Serialized bounded `local://` root projection, or removal when absent.
	pub local_roots_json: Option<Str>,
}

impl EvalSessionConfig {
	fn runtime_snapshot(&self) -> RuntimeSnapshot {
		RuntimeSnapshot {
			cwd:         Some(self.cwd.clone()),
			managed_env: [(sf!("OMP_EVAL_LOCAL_ROOTS"), self.local_roots_json.clone())]
				.into_iter()
				.collect(),
		}
	}
}

/// Revocable parent binding for one embedded session owner.
#[must_use]
pub struct ParentBindingLease {
	parents:    Arc<Mutex<BTreeMap<Str, ParentBinding>>>,
	owner:      Str,
	generation: Ulid,
}

impl Drop for ParentBindingLease {
	fn drop(&mut self) {
		let parent = {
			let mut parents = self.parents.lock();
			if parents
				.get(&self.owner)
				.is_some_and(|binding| binding.generation == self.generation)
			{
				parents.remove(&self.owner).map(|binding| binding.parent)
			} else {
				None
			}
		};
		if let Some(parent) = parent {
			parent.release_eval_owner();
		}
	}
}

struct ParentBinding {
	generation: Ulid,
	parent:     Arc<dyn ParentSessionHost>,
}

#[derive(Clone)]
struct RuntimeLease {
	binding_owner: Str,
	generation:    Ulid,
	parent:        Arc<dyn ParentSessionHost>,
}

/// Late-bound host used to break the registry/eval construction cycle.
///
/// The registry is immutable, while parent routes are revocable and keyed by
/// authenticated owner. A frozen runtime holds the exact parent selected for
/// that owner until the eval session is released.
pub struct SessionBridgeHost {
	registry:          OnceLock<Arc<Registry>>,
	prelude:           OnceLock<(Arc<PreludeTable>, Arc<dyn PreludeInvoker>)>,
	parents:           Arc<Mutex<BTreeMap<Str, ParentBinding>>>,
	runtime_snapshots: Mutex<BTreeMap<(Str, Bytes), RuntimeLease>>,
}

impl SessionBridgeHost {
	pub(crate) fn new() -> Self {
		Self {
			registry:          OnceLock::new(),
			prelude:           OnceLock::new(),
			parents:           Arc::new(Mutex::new(BTreeMap::new())),
			runtime_snapshots: Mutex::new(BTreeMap::new()),
		}
	}

	pub(crate) fn bind_registry(&self, registry: Arc<Registry>) -> Result<(), BridgeHostError> {
		self
			.registry
			.set(registry)
			.map_err(|_| BridgeHostError::message("eval bridge registry is already bound"))
	}

	pub(crate) fn bind_prelude(
		&self,
		table: Arc<PreludeTable>,
		invoker: Arc<dyn PreludeInvoker>,
	) -> Result<(), BridgeHostError> {
		self
			.prelude
			.set((table, invoker))
			.map_err(|_| BridgeHostError::message("eval bridge prelude is already bound"))
	}

	/// Binds a parent session scoped to its exact SDK owner.
	///
	/// Eval runs presenting any other owner id are rejected, preventing
	/// sequential or concurrent embedders from routing cells through the wrong
	/// parent.
	pub(crate) fn bind_sdk_parent(
		&self,
		owner: Str,
		parent: Arc<dyn ParentSessionHost>,
	) -> Result<ParentBindingLease, BridgeHostError> {
		if owner.is_empty() {
			return Err(BridgeHostError::message("eval bridge parent owner is empty"));
		}
		let generation = Ulid::generate();
		let mut parents = self.parents.lock();
		if parents.contains_key(&owner) {
			return Err(BridgeHostError::message("eval bridge parent owner is already bound"));
		}
		parents.insert(owner.clone(), ParentBinding { generation, parent });
		drop(parents);
		Ok(ParentBindingLease { parents: Arc::clone(&self.parents), owner, generation })
	}

	fn parent_for(
		&self,
		owner: &str,
	) -> Result<(Str, Ulid, Arc<dyn ParentSessionHost>), BridgeHostError> {
		let parents = self.parents.lock();
		if let Some(binding) = parents.get(owner) {
			return Ok((Str::new(owner), binding.generation, Arc::clone(&binding.parent)));
		}
		let Ok((session, agent)) = serde_json::from_str::<(Str, Str)>(owner) else {
			return Err(BridgeHostError::message(
				"eval bridge parent session is not bound for this owner",
			));
		};
		if session.is_empty() || agent.is_empty() {
			return Err(BridgeHostError::message(
				"eval bridge parent session is not bound for this owner",
			));
		}
		let Some(binding) = parents.get(&session) else {
			return Err(BridgeHostError::message(
				"eval bridge parent session is not bound for this owner",
			));
		};
		Ok((session, binding.generation, Arc::clone(&binding.parent)))
	}

	pub(super) fn freeze_runtime(
		&self,
		owner: &str,
		session: &Bytes,
	) -> Result<RuntimeSnapshot, BridgeHostError> {
		let (binding_owner, generation, parent) = self.parent_for(owner)?;
		let config = parent.eval_session_config()?;
		self
			.runtime_snapshots
			.lock()
			.insert((Str::new(owner), session.clone()), RuntimeLease {
				binding_owner,
				generation,
				parent,
			});
		Ok(config.runtime_snapshot())
	}

	pub(super) fn release_runtime(&self, owner: &str, session: &Bytes) {
		self
			.runtime_snapshots
			.lock()
			.remove(&(Str::new(owner), session.clone()));
	}

	pub(super) fn clear_runtimes(&self) {
		self.runtime_snapshots.lock().clear();
	}

	pub(super) fn capabilities(&self) -> Result<BridgeCapabilities, BridgeHostError> {
		let registry = self
			.registry
			.get()
			.ok_or_else(|| BridgeHostError::message("eval bridge registry is not bound"))?;
		let tools = registry
			.live_identities()
			.filter(|&(name, _)| {
				name.as_str() != "eval"
					&& registry
						.route(name.as_str())
						.is_ok_and(|route| matches!(route, ToolRoute::Native))
			})
			.map(|(name, _)| name.clone());
		let capabilities = BridgeCapabilities::new(tools);
		let capabilities = if let Some((table, _)) = self.prelude.get() {
			capabilities.with_prelude(table.helpers().map(|helper| helper.name.clone()))
		} else {
			capabilities
		};
		let parents = self.parents.lock();
		if parents.is_empty() {
			return Ok(capabilities);
		}
		let has_completion = parents
			.values()
			.all(|binding| binding.parent.completion_available());
		let has_agent = parents
			.values()
			.all(|binding| binding.parent.agent_available());
		let has_concurrency = parents
			.values()
			.all(|binding| binding.parent.concurrency_available());
		let has_budget = parents
			.values()
			.all(|binding| binding.parent.budget_available());
		let has_workpool = parents
			.values()
			.all(|binding| binding.parent.workpool_available());
		let capabilities = if has_completion {
			capabilities.with_completion()
		} else {
			capabilities
		};
		let capabilities = if has_agent {
			capabilities.with_agent()
		} else {
			capabilities
		};
		let capabilities = if has_concurrency {
			capabilities.with_concurrency()
		} else {
			capabilities
		};
		let capabilities = if has_budget {
			capabilities.with_budget()
		} else {
			capabilities
		};
		Ok(if has_workpool {
			capabilities.with_workpool()
		} else {
			capabilities
		})
	}

	pub(super) fn prelude_stubs(&self) -> Vec<PreludeStubWire> {
		self
			.prelude
			.get()
			.map_or_else(Vec::new, |(table, _)| table.helpers().map(PreludeStubWire::from).collect())
	}

	pub(super) async fn call_for(
		&self,
		owner: &str,
		session: &Bytes,
		name: &str,
		args: Value,
		progress: &dyn BridgeProgressSink,
	) -> Result<Value, BridgeHostError> {
		if let Some(helper_name) = name.strip_prefix(PRELUDE_PREFIX) {
			let (table, invoker) = self.prelude.get().ok_or_else(|| {
				BridgeHostError::message(sf!("unknown prelude helper: {helper_name}"))
			})?;
			let helper = table.get(helper_name).ok_or_else(|| {
				BridgeHostError::message(sf!("unknown prelude helper: {helper_name}"))
			})?;
			return invoker.invoke(helper_name, helper.rev.as_str(), args).await;
		}
		let lease = self
			.runtime_snapshots
			.lock()
			.get(&(Str::new(owner), session.clone()))
			.map(|lease| (lease.binding_owner.clone(), lease.generation, Arc::clone(&lease.parent)));
		let Some((binding_owner, generation, parent)) = lease else {
			// Bare in-process sessions carry no parent lease: registry-backed
			// native tools stay available while parent-scoped helpers fail with
			// their typed absence below.
			if matches!(name, COMPLETION | AGENT | WORKPOOL | CONCURRENCY | BUDGET) {
				return Err(BridgeHostError::message(
					"eval bridge parent session is not bound for this owner",
				));
			}
			let registry = self
				.registry
				.get()
				.ok_or_else(|| BridgeHostError::message("eval bridge registry is not bound"))?;
			return RegistryBridgeHost::new(Arc::clone(registry))
				.call(name, args, progress)
				.await;
		};
		if !self
			.parents
			.lock()
			.get(&binding_owner)
			.is_some_and(|binding| binding.generation == generation)
		{
			return Err(BridgeHostError::message("eval bridge parent lease was revoked"));
		}
		self.call_with_parent(parent, name, args, progress).await
	}

	async fn call_with_parent(
		&self,
		parent: Arc<dyn ParentSessionHost>,
		name: &str,
		args: Value,
		progress: &dyn BridgeProgressSink,
	) -> Result<Value, BridgeHostError> {
		match name {
			COMPLETION => parent.completion(args, progress).await,
			AGENT => parent.agent(args, progress).await,
			WORKPOOL => parent.workpool(args, progress).await,
			CONCURRENCY => parent.concurrency(args).await,
			BUDGET => parent.budget(args).await,
			_ => {
				let registry = self
					.registry
					.get()
					.ok_or_else(|| BridgeHostError::message("eval bridge registry is not bound"))?;
				RegistryBridgeHost::new(Arc::clone(registry))
					.call(name, args, progress)
					.await
			},
		}
	}
}

#[async_trait]
impl BridgeHost for SessionBridgeHost {
	async fn call(
		&self,
		name: &str,
		args: Value,
		progress: &dyn BridgeProgressSink,
	) -> Result<Value, BridgeHostError> {
		let (_, _, parent) = self.parent_for("__unscoped_eval_bridge__")?;
		self.call_with_parent(parent, name, args, progress).await
	}
}

struct NamespaceBridge {
	abort:    Arc<CellAbort>,
	client:   BridgeClient,
	watchdog: TimeoutHandle,
}

struct NamespaceHost(Arc<dyn ChildBridgeTransport>);

impl NamespaceHost {
	fn capabilities(&self) -> BridgeCapabilities {
		self.0.capabilities()
	}
}

#[async_trait]
impl BridgeHost for NamespaceHost {
	async fn call(
		&self,
		name: &str,
		args: Value,
		progress: &dyn BridgeProgressSink,
	) -> Result<Value, BridgeHostError> {
		self.0.call(name, args, progress).await
	}
}

/// Installs namespace-local bridge grants and tracks cancellation per active
/// cell.
pub struct BridgeNamespaceInstaller {
	dispatcher: BridgeDispatcher,
	host:       Arc<NamespaceHost>,
	runtime:    Handle,
	stubs:      Vec<PreludeStubWire>,
	session:    Str,
	next_run:   AtomicU64,
	namespaces: Mutex<BTreeMap<usize, NamespaceBridge>>,
	cells:      Mutex<BTreeMap<Bytes, Arc<CellAbort>>>,
}

impl BridgeNamespaceInstaller {
	pub(super) fn new_child(
		host: Arc<dyn ChildBridgeTransport>,
		runtime: Handle,
		stubs: Vec<PreludeStubWire>,
	) -> Self {
		Self::with_host(Arc::new(NamespaceHost(host)), runtime, stubs)
	}

	fn with_host(host: Arc<NamespaceHost>, runtime: Handle, stubs: Vec<PreludeStubWire>) -> Self {
		Self {
			dispatcher: BridgeDispatcher::new(),
			host,
			runtime,
			stubs,
			session: Str::from(format!("envd-eval-{}", Ulid::generate())),
			next_run: AtomicU64::new(1),
			namespaces: Mutex::new(BTreeMap::new()),
			cells: Mutex::new(BTreeMap::new()),
		}
	}
}

impl NamespaceInstaller for BridgeNamespaceInstaller {
	fn install(&self, py: Python<'_>, globals: &Bound<'_, PyDict>) -> PyResult<()> {
		let run = Str::from(format!("namespace-{}", self.next_run.fetch_add(1, Ordering::Relaxed)));
		let capabilities = self.host.capabilities();
		let host: Arc<dyn BridgeHost> = self.host.clone();
		let watchdog = TimeoutHandle::new(None);
		let registration = self
			.dispatcher
			.register(self.session.clone(), run, capabilities, host, watchdog.clone())
			.map_err(|error| PyRuntimeError::new_err(error.to_string()))?;
		let abort = Arc::new(CellAbort::default());
		let client = registration.client().with_abort(Arc::clone(&abort));
		install_python_bridge(py, globals, client.clone(), self.runtime.clone())?;
		install_python_prelude(py, globals)?;
		if !self.stubs.is_empty() {
			let encoded = serde_json::to_string(&self.stubs)
				.map_err(|error| PyRuntimeError::new_err(error.to_string()))?;
			let specs = PyModule::import(py, "json")?.call_method1("loads", (encoded,))?;
			let installer = globals
				.get_item("__omp_install_prelude_helpers__")?
				.ok_or_else(|| PyRuntimeError::new_err("Python prelude helper installer is missing"))?;
			installer.call1((specs,))?;
		}
		self
			.namespaces
			.lock()
			.insert(globals.as_ptr() as usize, NamespaceBridge { abort, client, watchdog });
		Ok(())
	}

	fn uninstall(&self, _py: Python<'_>, globals: &Bound<'_, PyDict>) -> PyResult<()> {
		let Some(namespace) = self.namespaces.lock().remove(&(globals.as_ptr() as usize)) else {
			return Ok(());
		};
		namespace.abort.cancel_active();
		namespace.watchdog.dispose();
		self
			.cells
			.lock()
			.retain(|_, abort| !Arc::ptr_eq(abort, &namespace.abort));
		namespace.client.revoke();
		Ok(())
	}

	fn begin_cell(
		&self,
		_py: Python<'_>,
		globals: &Bound<'_, PyDict>,
		cell_id: &Bytes,
		timeout: Option<Duration>,
	) -> PyResult<TimeoutHandle> {
		let state = self.namespaces.lock();
		let namespace = state.get(&(globals.as_ptr() as usize)).ok_or_else(|| {
			PyRuntimeError::new_err("eval namespace has no bridge cancellation scope")
		})?;
		let abort = Arc::clone(&namespace.abort);
		let watchdog = namespace.watchdog.clone();
		drop(state);
		watchdog.restart(timeout);
		let generation = watchdog.generation();
		let expiry = watchdog.clone();
		self.runtime.spawn(async move {
			expiry.expired().await;
			time::sleep(Duration::from_millis(25)).await;
			if expiry.is_current(generation) {
				process::exit(124);
			}
		});
		abort.begin(cell_id);
		let stale = self
			.cells
			.lock()
			.insert(cell_id.clone(), Arc::clone(&abort));
		if let Some(stale) = stale {
			stale.cancel(cell_id);
		}
		Ok(watchdog)
	}

	fn end_cell(
		&self,
		_py: Python<'_>,
		_globals: &Bound<'_, PyDict>,
		cell_id: &Bytes,
	) -> PyResult<()> {
		let abort = self.cells.lock().remove(cell_id);
		if let Some(abort) = abort {
			abort.end(cell_id);
		}
		Ok(())
	}

	fn cancel_cell(&self, cell_id: &Bytes) {
		let abort = self.cells.lock().get(cell_id).cloned();
		if let Some(abort) = abort {
			abort.cancel(cell_id);
		}
	}
}

fn registry_error(error: impl Display) -> BridgeHostError {
	BridgeHostError::message(error.to_string())
}

fn projected_parts(parts: Vec<Part>) -> Result<Value, BridgeHostError> {
	let mut text = String::new();
	let mut json_parts: Vec<Value> = Vec::new();
	let mut blobs: Vec<Value> = Vec::new();
	for part in parts {
		match part {
			Part::Text { text: value } => text.push_str(value.as_str()),
			Part::Json { json } => {
				json_parts.push(serde_json::from_slice(&json).map_err(|error| {
					BridgeHostError::message(format!("tool returned invalid JSON: {error}"))
				})?);
			},
			Part::Blob { blob, alt } => blobs.push(json!({ "blob": blob, "alt": alt })),
		}
	}
	if json_parts.is_empty() && blobs.is_empty() {
		return Ok(Value::String(text));
	}
	Ok(json!({ "text": text, "json": json_parts, "blobs": blobs }))
}

struct PythonProgressSink {
	globals: Py<PyDict>,
	name:    Str,
}

impl BridgeProgressSink for PythonProgressSink {
	fn progress(&self, event: Value) -> Result<(), BridgeHostError> {
		let encoded = serde_json::to_string(&event)
			.map_err(|error| BridgeHostError::message(error.to_string()))?;
		Python::attach(|py| {
			let globals = self.globals.bind(py);
			let consumer = globals
				.get_item("__omp_consume_bridge_progress__")
				.map_err(|error| BridgeHostError::message(error.to_string()))?
				.ok_or_else(|| {
					BridgeHostError::message("Python bridge progress consumer is missing")
				})?;
			let json_module = PyModule::import(py, "json")
				.map_err(|error| BridgeHostError::message(error.to_string()))?;
			let event = json_module
				.call_method1("loads", (encoded,))
				.map_err(|error| BridgeHostError::message(error.to_string()))?;
			consumer
				.call1((self.name.as_str(), event))
				.map_err(|error| BridgeHostError::message(error.to_string()))?;
			Ok(())
		})
	}
}

#[pyclass(frozen)]
struct PythonBridgeCallable {
	client:  BridgeClient,
	runtime: Handle,
	globals: Py<PyDict>,
}

#[pymethods]
impl PythonBridgeCallable {
	fn __call__<'py>(
		&self,
		py: Python<'py>,
		name: &str,
		args: &Bound<'py, PyAny>,
	) -> PyResult<Py<PyAny>> {
		let json_module = PyModule::import(py, "json")?;
		let encoded: String = json_module.call_method1("dumps", (args,))?.extract()?;
		let args = serde_json::from_str(&encoded).map_err(|error| {
			PyRuntimeError::new_err(format!("bridge arguments are not JSON: {error}"))
		})?;
		let progress =
			PythonProgressSink { globals: self.globals.clone_ref(py), name: Str::new(name) };
		let value = py
			.detach(|| {
				self
					.runtime
					.block_on(self.client.call_with_progress(name, args, &progress))
			})
			.map_err(|error| PyRuntimeError::new_err(error.to_string()))?;
		let encoded = serde_json::to_string(&value)
			.map_err(|error| PyRuntimeError::new_err(format!("bridge result is not JSON: {error}")))?;
		Ok(json_module.call_method1("loads", (encoded,))?.unbind())
	}
}

/// Installs the authenticated direct bridge callable in one persistent Python
/// namespace. The callable owns a single session/run grant; Python code cannot
/// supply or swap credentials.
pub fn install_python_bridge(
	py: Python<'_>,
	globals: &Bound<'_, PyDict>,
	client: BridgeClient,
	runtime: Handle,
) -> PyResult<()> {
	globals.set_item("__omp_bridge_session__", client.session())?;
	let allowed_names = client.allowed_names();
	globals.set_item(
		"__omp_bridge_capabilities__",
		allowed_names.iter().map(Str::as_str).collect::<Vec<_>>(),
	)?;
	globals.set_item(
		"__omp_bridge_call__",
		Py::new(py, PythonBridgeCallable { client, runtime, globals: globals.clone().unbind() })?,
	)
}

/// Loads the normative helper prelude once into a persistent namespace.
pub fn install_python_prelude(py: Python<'_>, globals: &Bound<'_, PyDict>) -> PyResult<()> {
	let source = CString::new(PYTHON_PRELUDE)
		.map_err(|_| PyRuntimeError::new_err("embedded Python prelude contains a NUL byte"))?;
	py.run(source.as_c_str(), Some(globals), Some(globals))
}

#[cfg(test)]
mod tests {
	use std::sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	};

	use async_stream::stream;
	use futures::Stream;
	use omp_tool::{
		Claims, Constraint, DiagKind, Effects, Ev, Precedence, Presentation, Rev, Tool, ToolSpec,
		ToolTerminal, Unit,
	};
	use serde::{Deserialize, Deserializer, Serialize, ser};

	use super::*;

	struct RecordingHost {
		calls: AtomicUsize,
		fail:  bool,
	}

	#[async_trait]
	impl BridgeHost for RecordingHost {
		async fn call(
			&self,
			name: &str,
			args: Value,
			_progress: &dyn BridgeProgressSink,
		) -> Result<Value, BridgeHostError> {
			self.calls.fetch_add(1, Ordering::Relaxed);
			if self.fail {
				return Err(BridgeHostError::message("host exploded"));
			}
			Ok(json!({ "name": name, "args": args }))
		}
	}
	struct RecordingPrelude {
		calls: Mutex<Vec<(Str, Str, Value)>>,
	}

	#[async_trait]
	impl PreludeInvoker for RecordingPrelude {
		async fn invoke(&self, name: &str, rev: &str, args: Value) -> Result<Value, BridgeHostError> {
			self
				.calls
				.lock()
				.push((Str::new(name), Str::new(rev), args.clone()));
			Ok(args)
		}
	}

	struct RecordingParent {
		calls:    AtomicUsize,
		releases: AtomicUsize,
	}

	impl RecordingParent {
		fn response(&self, operation: &str, args: Value) -> Value {
			self.calls.fetch_add(1, Ordering::Relaxed);
			json!({ "operation": operation, "args": args })
		}
	}

	#[async_trait]
	impl ParentSessionHost for RecordingParent {
		fn eval_session_config(&self) -> Result<EvalSessionConfig, BridgeHostError> {
			Ok(EvalSessionConfig {
				cwd:              PathBuf::from("/runtime"),
				local_roots_json: Some(Str::new_static(r#"{"local":"/runtime/local"}"#)),
			})
		}

		fn release_eval_owner(&self) {
			self.releases.fetch_add(1, Ordering::Relaxed);
		}

		async fn completion(
			&self,
			args: Value,
			_progress: &dyn BridgeProgressSink,
		) -> Result<Value, BridgeHostError> {
			Ok(self.response("completion", args))
		}

		async fn agent(
			&self,
			args: Value,
			_progress: &dyn BridgeProgressSink,
		) -> Result<Value, BridgeHostError> {
			Ok(self.response("agent", args))
		}

		fn workpool_available(&self) -> bool {
			true
		}

		async fn workpool(
			&self,
			args: Value,
			_progress: &dyn BridgeProgressSink,
		) -> Result<Value, BridgeHostError> {
			Ok(self.response("workpool", args))
		}

		async fn concurrency(&self, args: Value) -> Result<Value, BridgeHostError> {
			Ok(self.response("concurrency", args))
		}

		async fn budget(&self, args: Value) -> Result<Value, BridgeHostError> {
			Ok(self.response("budget", args))
		}
	}

	enum ProbeUpdate {
		Value(Value),
		Invalid,
	}

	impl Serialize for ProbeUpdate {
		fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
			match self {
				Self::Value(value) => value.serialize(serializer),
				Self::Invalid => Err(<S::Error as ser::Error>::custom("invalid probe update")),
			}
		}
	}

	impl<'de> Deserialize<'de> for ProbeUpdate {
		fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
			Value::deserialize(deserializer).map(Self::Value)
		}
	}

	struct StreamingProbe {
		spec:    ToolSpec,
		invalid: bool,
	}

	impl StreamingProbe {
		fn new(name: &'static str, invalid: bool) -> Self {
			Self {
				spec: ToolSpec {
					name:            sf!(name),
					rev:             Rev { family: Str::default(), n: 1 },
					description:     sf!("eval bridge update probe"),
					schema:          Bytes::from_static(
						br#"{"type":"object","additionalProperties":false}"#,
					),
					constraint:      Constraint::None,
					effects:         Effects::empty(),
					projection_code: [0; 32],
				},
				invalid,
			}
		}
	}

	impl Tool for StreamingProbe {
		type Fault = Value;
		type Params = Value;
		type Payload = Value;
		type Update = ProbeUpdate;

		fn spec(&self) -> &ToolSpec {
			&self.spec
		}

		fn call<'c>(
			&'c self,
			mut params: IncomingParams<'c>,
		) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
			stream! {
				params.whole::<Value>().await.expect("probe arguments");
				params.committed().await.expect("probe commitment");
				if self.invalid {
					yield Ev::Update(ProbeUpdate::Invalid);
				} else {
					yield Ev::Update(ProbeUpdate::Value(json!({"step": 1})));
					yield Ev::Diag(
						Diag::info(DiagKind::Pagination, "more results")
							.continuation("skip=2")
							.omitted(3, Unit::Items),
					);
					yield Ev::Update(ProbeUpdate::Value(json!({"step": 2})));
				}
				yield Ev::Done(ToolTerminal::Done {
					result: Ok(json!({"terminal": "done"})),
					useless: false,
				});
			}
		}

		fn prompt(
			&self,
			view: Result<&Self::Payload, &Self::Fault>,
			_caps: &PromptCaps,
		) -> Vec<Part> {
			let value = match view {
				Ok(value) => value["terminal"].as_str().unwrap_or("missing"),
				Err(_) => "fault",
			};
			vec![Part::Text { text: Str::from(value) }]
		}
	}

	fn dispatcher() -> BridgeDispatcher {
		BridgeDispatcher::new()
	}

	#[test]
	fn prelude_capabilities_round_trip_through_init_names() {
		let capabilities =
			BridgeCapabilities::new([sf!("read")]).with_prelude([sf!("merge_patches")]);
		assert_eq!(
			BridgeCapabilities::from_allowed_names(capabilities.allowed_names()),
			capabilities
		);
		assert!(capabilities.allows("__prelude__:merge_patches"));
		assert!(!capabilities.allows("__prelude__:denied_helper"));
	}
	#[tokio::test]
	async fn prelude_dispatch_does_not_require_a_parent_runtime_lease() {
		let mut table = PreludeTable::new();
		table.insert(PreludeHelper::new(
			sf!("merge_patches"),
			sf!("prelude.1"),
			Str::default(),
			Str::default(),
			Vec::new(),
		));
		let invoker = Arc::new(RecordingPrelude { calls: Mutex::new(Vec::new()) });
		let host = SessionBridgeHost::new();
		host
			.bind_prelude(Arc::new(table), invoker.clone())
			.expect("bind prelude");
		let args = json!({ "patches": ["a"] });
		assert_eq!(
			host
				.call_for(
					"unbound-owner",
					&Bytes::from_static(b"unbound-session"),
					"__prelude__:merge_patches",
					args.clone(),
					&NoopBridgeProgress,
				)
				.await
				.expect("invoke prelude without a parent"),
			args
		);
		assert_eq!(invoker.calls.lock().as_slice(), &[(
			sf!("merge_patches"),
			sf!("prelude.1"),
			json!({ "patches": ["a"] }),
		)]);
	}

	#[test]
	fn helper_signatures_render_json_defaults_as_python_literals() {
		let helper = PreludeHelper::new(
			sf!("merge_patches"),
			sf!("prelude.1"),
			Str::default(),
			Str::default(),
			vec![
				PreludeParamStub {
					name:         sf!("enabled"),
					kind:         PreludeParamKind::PositionalOrKeyword,
					default_json: Some(sf!("true")),
					annotation:   None,
				},
				PreludeParamStub {
					name:         sf!("options"),
					kind:         PreludeParamKind::KeywordOnly,
					default_json: Some(Str::from(r#"[null,{"ready":false}]"#)),
					annotation:   None,
				},
			],
		);
		assert_eq!(
			helper.signature,
			r#"merge_patches(enabled=True, *, options=[None, {"ready": False}])"#
		);
	}

	#[tokio::test]
	async fn authenticates_and_scopes_calls() {
		let dispatcher = dispatcher();
		let host = Arc::new(RecordingHost { calls: AtomicUsize::new(0), fail: false });
		let registration = dispatcher
			.register(
				sf!("session"),
				sf!("run"),
				BridgeCapabilities::new([sf!("read")]).with_budget(),
				host.clone(),
				TimeoutHandle::new(None),
			)
			.expect("register bridge");
		let client = registration.client();
		assert_eq!(
			client
				.call_with_progress("read", json!({ "path": "x" }), &NoopBridgeProgress)
				.await
				.expect("allowed call"),
			json!({ "name": "read", "args": { "path": "x" } })
		);
		assert_eq!(host.calls.load(Ordering::Relaxed), 1);
		assert_eq!(
			client
				.call_with_progress("write", json!({}), &NoopBridgeProgress)
				.await,
			Err(BridgeCallError::CapabilityDenied { name: sf!("write") })
		);
		assert_eq!(host.calls.load(Ordering::Relaxed), 1, "denied calls never reach host");
	}

	#[tokio::test]
	async fn rejects_tampered_grants_and_keeps_registration_alive_with_the_client() {
		let dispatcher = dispatcher();
		let host = Arc::new(RecordingHost { calls: AtomicUsize::new(0), fail: false });
		let registration = dispatcher
			.register(
				sf!("session"),
				sf!("run"),
				BridgeCapabilities::new([sf!("read")]),
				host,
				TimeoutHandle::new(None),
			)
			.expect("register bridge");
		let client = registration.client();
		let mut forged = client.clone();
		forged.grant.token = SecretString::from("wrong".to_owned());
		assert_eq!(
			forged
				.call_with_progress("read", json!({}), &NoopBridgeProgress)
				.await,
			Err(BridgeCallError::AuthenticationFailed)
		);
		drop(registration);
		assert!(
			client
				.call_with_progress("read", json!({}), &NoopBridgeProgress)
				.await
				.is_ok()
		);
		assert_eq!(dispatcher.inner.registrations.lock().len(), 1);
		drop(client);
		drop(forged);
		assert!(dispatcher.inner.registrations.lock().is_empty());
	}

	struct TestChildTransport;

	#[async_trait]
	impl ChildBridgeTransport for TestChildTransport {
		fn capabilities(&self) -> BridgeCapabilities {
			BridgeCapabilities::new([])
		}

		async fn call(
			&self,
			_name: &str,
			_args: Value,
			_progress: &dyn BridgeProgressSink,
		) -> Result<Value, BridgeHostError> {
			Ok(Value::Null)
		}
	}

	#[tokio::test]
	async fn cancelling_one_worker_cell_does_not_cancel_another_namespace() {
		let installer = BridgeNamespaceInstaller::new_child(
			Arc::new(TestChildTransport),
			Handle::current(),
			Vec::new(),
		);
		let first_id = Bytes::from_static(b"session-a:cell-1");
		let second_id = Bytes::from_static(b"session-b:cell-2");
		let first = Arc::new(CellAbort::default());
		let second = Arc::new(CellAbort::default());
		first.begin(&first_id);
		second.begin(&second_id);
		let first_token = first.token().expect("first token");
		let second_token = second.token().expect("second token");
		installer.cells.lock().insert(first_id.clone(), first);
		installer.cells.lock().insert(second_id.clone(), second);

		NamespaceInstaller::cancel_cell(&installer, &first_id);
		assert!(first_token.is_cancelled());
		assert!(!second_token.is_cancelled(), "another worker's host call remains active");
		NamespaceInstaller::cancel_cell(&installer, &second_id);
		assert!(second_token.is_cancelled());
	}

	#[tokio::test]
	async fn propagates_host_errors() {
		let dispatcher = dispatcher();
		let registration = dispatcher
			.register(
				sf!("session"),
				sf!("run"),
				BridgeCapabilities::new([sf!("read")]),
				Arc::new(RecordingHost { calls: AtomicUsize::new(0), fail: true }),
				TimeoutHandle::new(None),
			)
			.expect("register bridge");
		assert_eq!(
			registration
				.client()
				.call_with_progress("read", json!({}), &NoopBridgeProgress)
				.await,
			Err(BridgeCallError::Host { message: sf!("host exploded") })
		);
	}

	#[test]
	fn runtime_snapshots_are_keyed_by_owner_and_eval_session() {
		let parent =
			Arc::new(RecordingParent { calls: AtomicUsize::new(0), releases: AtomicUsize::new(0) });
		let host = SessionBridgeHost::new();
		let _binding = host
			.bind_sdk_parent(sf!("owner-a"), parent.clone())
			.expect("bind parent");
		let _other_binding = host
			.bind_sdk_parent(sf!("owner-b"), parent)
			.expect("bind parent");
		let first = Bytes::from_static(b"eval-a");
		let second = Bytes::from_static(b"eval-b");
		let snapshot = host
			.freeze_runtime("owner-a", &first)
			.expect("freeze first");
		host
			.freeze_runtime("owner-a", &second)
			.expect("freeze second");
		host
			.freeze_runtime("owner-b", &first)
			.expect("freeze other owner");
		assert_eq!(snapshot.cwd, Some(PathBuf::from("/runtime")));
		assert_eq!(host.runtime_snapshots.lock().len(), 3);
		host.release_runtime("owner-a", &first);
		assert_eq!(host.runtime_snapshots.lock().len(), 2);
	}
	#[test]
	fn runtime_snapshot_rejects_an_unbound_transport_owner() {
		let host = SessionBridgeHost::new();
		let error = host
			.freeze_runtime("env-connection-1", &Bytes::from_static(b"eval-a"))
			.expect_err("transport identity must not receive daemon runtime authority");
		assert!(matches!(
			error,
			BridgeHostError::Message(message)
				if message == "eval bridge parent session is not bound for this owner"
		));
	}
	#[tokio::test]
	async fn composite_principals_share_parent_authority_but_isolate_runtime_keys() {
		let parent =
			Arc::new(RecordingParent { calls: AtomicUsize::new(0), releases: AtomicUsize::new(0) });
		let host = SessionBridgeHost::new();
		host
			.bind_registry(Arc::new(Registry::new()))
			.expect("bind registry");
		let _binding = host
			.bind_sdk_parent(sf!("session"), parent)
			.expect("bind parent session");
		let parent_owner = r#"["session","session"]"#;
		let child_owner = r#"["session","child"]"#;
		let parent_eval = Bytes::from_static(b"parent-eval");
		let child_eval = Bytes::from_static(b"child-eval");
		host
			.freeze_runtime(parent_owner, &parent_eval)
			.expect("freeze parent runtime");
		host
			.freeze_runtime(child_owner, &child_eval)
			.expect("freeze child runtime");
		let snapshots = host.runtime_snapshots.lock();
		assert!(snapshots.contains_key(&(Str::new(parent_owner), parent_eval)));
		assert!(snapshots.contains_key(&(Str::new(child_owner), child_eval.clone())));
		assert_eq!(snapshots.len(), 2);
		drop(snapshots);
		assert_eq!(
			host
				.call_for(child_owner, &child_eval, BUDGET, json!({"op":"spent"}), &NoopBridgeProgress,)
				.await
				.expect("composite owner routes to bound parent"),
			json!({"operation":"budget","args":{"op":"spent"}})
		);
	}

	#[tokio::test]
	async fn dropping_parent_binding_revokes_frozen_runtime_routes() {
		let parent =
			Arc::new(RecordingParent { calls: AtomicUsize::new(0), releases: AtomicUsize::new(0) });
		let host = SessionBridgeHost::new();
		host
			.bind_registry(Arc::new(Registry::new()))
			.expect("bind registry");
		let binding = host
			.bind_sdk_parent(sf!("owner"), parent.clone())
			.expect("bind parent");
		let session = Bytes::from_static(b"eval-a");
		host
			.freeze_runtime("owner", &session)
			.expect("freeze runtime");
		drop(binding);
		assert_eq!(parent.releases.load(Ordering::Relaxed), 1);
		assert!(matches!(
			host.call_for("owner", &session, BUDGET, json!({}), &NoopBridgeProgress).await,
			Err(BridgeHostError::Message(message)) if message == "eval bridge parent lease was revoked"
		));
	}

	#[tokio::test]
	async fn parent_helpers_use_only_the_bound_session_host() {
		let parent =
			Arc::new(RecordingParent { calls: AtomicUsize::new(0), releases: AtomicUsize::new(0) });
		let host = Arc::new(SessionBridgeHost::new());
		host
			.bind_registry(Arc::new(Registry::new()))
			.expect("bind registry");
		let _binding = host
			.bind_sdk_parent(sf!("owner"), parent.clone())
			.expect("bind parent");
		let session = Bytes::from_static(b"eval");
		host
			.freeze_runtime("owner", &session)
			.expect("freeze owner runtime");
		assert!(
			host
				.capabilities()
				.expect("parent capabilities")
				.allows(WORKPOOL)
		);
		for (name, operation) in [
			(COMPLETION, "completion"),
			(AGENT, "agent"),
			(WORKPOOL, "workpool"),
			(CONCURRENCY, "concurrency"),
			(BUDGET, "budget"),
		] {
			assert_eq!(
				host
					.call_for(
						"owner",
						&session,
						name,
						json!({ "marker": operation }),
						&NoopBridgeProgress,
					)
					.await
					.expect("parent call"),
				json!({ "operation": operation, "args": { "marker": operation } })
			);
		}
		assert_eq!(parent.calls.load(Ordering::Relaxed), 5);
	}

	#[tokio::test]
	async fn absent_parent_capabilities_are_typed_denials() {
		let host = Arc::new(SessionBridgeHost::new());
		host
			.bind_registry(Arc::new(Registry::new()))
			.expect("bind registry");
		let capabilities = host.capabilities().expect("bound capabilities");
		assert!(!capabilities.allows(WORKPOOL));
		let registration = dispatcher()
			.register(sf!("owner"), sf!("cell"), capabilities, host, TimeoutHandle::new(None))
			.expect("register owner");
		assert_eq!(
			registration
				.client()
				.call_with_progress(COMPLETION, json!({}), &NoopBridgeProgress)
				.await,
			Err(BridgeCallError::CapabilityDenied { name: sf!(COMPLETION) })
		);
	}

	fn test_claims() -> Claims {
		Claims { precedence: Precedence::CORE, claimant: sf!("omp/core"), replaces: None }
	}

	struct RecordingProgress(Mutex<Vec<Value>>);

	impl BridgeProgressSink for RecordingProgress {
		fn progress(&self, event: Value) -> Result<(), BridgeHostError> {
			self.0.lock().push(event);
			Ok(())
		}
	}

	#[tokio::test]
	async fn registry_bridge_collects_diags_and_streams_ordered_updates_before_its_response() {
		let mut registry = Registry::new();
		registry
			.register(StreamingProbe::new("update_probe", false), Presentation::Slot, test_claims())
			.expect("register update probe");
		let host = RegistryBridgeHost::new(Arc::new(registry));
		let progress = RecordingProgress(Mutex::new(Vec::new()));
		assert_eq!(
			host
				.call("update_probe", json!({"i":"py prelude"}), &progress)
				.await
				.expect("bridge probe call"),
			json!({
				"result": "done",
				"diags": [{
					"severity": "info",
					"kind": "pagination",
					"text": "more results",
					"continuation": "skip=2",
					"omitted": {"count": 3, "unit": "items"},
				}],
			})
		);
		assert_eq!(*progress.0.lock(), vec![
			json!({"op":"tool","name":"update_probe","update":{"step":1}}),
			json!({"op":"tool","name":"update_probe","update":{"step":2}}),
		]);
	}

	#[tokio::test]
	async fn registry_bridge_surfaces_invalid_update_serialization_as_a_host_fault() {
		let mut registry = Registry::new();
		registry
			.register(
				StreamingProbe::new("invalid_update_probe", true),
				Presentation::Slot,
				test_claims(),
			)
			.expect("register invalid update probe");
		let host = RegistryBridgeHost::new(Arc::new(registry));
		let error = host
			.call("invalid_update_probe", json!({}), &NoopBridgeProgress)
			.await
			.expect_err("invalid update serialization unexpectedly succeeded");
		assert_eq!(error.to_string(), "tool value serialization failed: invalid probe update");
	}
}
