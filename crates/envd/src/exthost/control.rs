//! Extension-host CONTROL request correlation and argument-stream fencing.

use std::{
	collections::{BTreeMap, BTreeSet},
	path::PathBuf,
	str::FromStr as _,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
};

/// Maximum raw terminal-input frame admitted from the interactive terminal.
pub const MAX_RAW_TERMINAL_FRAME_BYTES: usize = 4096;
/// Maximum payload admitted through the trusted direct-filesystem escape.
pub const MAX_DIRECT_FILESYSTEM_BYTES: usize = 1024 * 1024;

/// Focus-owned raw-input admission failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum RawInputError {
	/// The admitted static manifest omitted `ui.raw-input`.
	#[error("raw terminal input was not declared by the extension manifest")]
	Undeclared,
	/// No exact durable capability grant covers the active manifest.
	#[error("raw terminal input is not durably granted")]
	Ungranted,
	/// Raw terminal input is unavailable without an interactive terminal.
	#[error("raw terminal input is unavailable in headless mode")]
	Headless,
	/// A request or frame belongs to a stale worker generation.
	#[error("raw terminal input generation is stale")]
	StaleGeneration,
	/// Another extension owns the terminal focus lease.
	#[error("terminal focus is owned by another extension")]
	FocusOwned,
	/// The frame exceeded the protocol ceiling.
	#[error("raw terminal input frame exceeds {MAX_RAW_TERMINAL_FRAME_BYTES} bytes")]
	FrameTooLarge,
}

/// Generation-fenced raw-input focus authority.
#[derive(Debug)]
pub struct RawInputAuthority {
	extension_id: Str,
	generation:   u64,
	declared:     bool,
	granted:      bool,
	interactive:  bool,
	focus_token:  Option<Str>,
	sequence:     u64,
}

impl RawInputAuthority {
	/// Builds the gate from Core-authenticated manifest and durable-grant facts.
	pub fn new(
		extension_id: impl Into<Str>,
		generation: u64,
		declared: bool,
		granted: bool,
		interactive: bool,
	) -> Self {
		Self {
			extension_id: extension_id.into(),
			generation,
			declared,
			granted,
			interactive,
			focus_token: None,
			sequence: 0,
		}
	}

	/// Acquires the sole raw-input focus lease.
	pub fn subscribe(
		&mut self,
		generation: u64,
		focus_token: impl Into<Str>,
	) -> Result<(), RawInputError> {
		if !self.declared {
			return Err(RawInputError::Undeclared);
		}
		if !self.granted {
			return Err(RawInputError::Ungranted);
		}
		if !self.interactive {
			return Err(RawInputError::Headless);
		}
		if generation != self.generation {
			return Err(RawInputError::StaleGeneration);
		}
		if self.focus_token.is_some() {
			return Err(RawInputError::FocusOwned);
		}
		self.focus_token = Some(focus_token.into());
		Ok(())
	}

	/// Validates and returns a bounded frame for the owning extension.
	pub fn frame(
		&mut self,
		generation: u64,
		focus_token: &str,
		data: &[u8],
	) -> Result<v1::RawTerminalInputFrame, RawInputError> {
		if generation != self.generation {
			return Err(RawInputError::StaleGeneration);
		}
		if self.focus_token.as_deref() != Some(focus_token) {
			return Err(RawInputError::FocusOwned);
		}
		if data.len() > MAX_RAW_TERMINAL_FRAME_BYTES {
			return Err(RawInputError::FrameTooLarge);
		}
		self.sequence = self.sequence.saturating_add(1);
		Ok(v1::RawTerminalInputFrame {
			sequence:    self.sequence,
			data:        bytes::Bytes::copy_from_slice(data),
			focus_token: focus_token.to_owned(),
		})
	}

	/// Releases the focus lease. Cancellation is idempotent only for the exact
	/// owner token.
	pub fn cancel(&mut self, generation: u64, focus_token: &str) -> Result<(), RawInputError> {
		if generation != self.generation {
			return Err(RawInputError::StaleGeneration);
		}
		if self.focus_token.as_deref() != Some(focus_token) {
			return Err(RawInputError::FocusOwned);
		}
		self.focus_token = None;
		Ok(())
	}

	/// Extension identity stamped on focus and cancellation diagnostics.
	pub const fn extension_id(&self) -> &Str {
		&self.extension_id
	}
}

/// Durable grant identity for the trusted direct-filesystem escape.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectFilesystemGrant {
	/// Extension identity.
	pub extension_id:      Str,
	/// TOFU-pinned publisher key.
	pub publisher:         Str,
	/// Exact manifest capability digest.
	pub capability_digest: Str,
	/// Durable grant record identity.
	pub grant_id:          Str,
	/// Worker generation covered by the activation receipt.
	pub generation:        u64,
}

/// Validated direct-filesystem request carrying immutable audit provenance.
#[derive(Clone, Debug)]
pub struct AuditedDirectFilesystemRequest {
	/// Requested operation from the closed vocabulary.
	pub operation: Str,
	/// Absolute local host path.
	pub path:      PathBuf,
	/// Optional bounded request bytes.
	pub data:      bytes::Bytes,
	/// Durable grant facts appended to the audit journal before execution.
	pub grant:     DirectFilesystemGrant,
}

/// Trusted direct-filesystem escape rejection.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum DirectFilesystemError {
	/// Static manifest omitted the exceptional capability.
	#[error("trusted direct-filesystem capability was not declared")]
	Undeclared,
	/// Durable grant facts do not cover this generation and capability digest.
	#[error("trusted direct-filesystem grant is absent or stale")]
	Ungranted,
	/// Operation is outside the closed escape vocabulary.
	#[error("unsupported direct-filesystem operation")]
	Operation,
	/// Escape requests must carry an absolute local path.
	#[error("direct-filesystem path must be absolute")]
	RelativePath,
	/// Payload exceeded the escape ceiling.
	#[error("direct-filesystem payload exceeds {MAX_DIRECT_FILESYSTEM_BYTES} bytes")]
	PayloadTooLarge,
}

/// Validates the exceptional filesystem protocol arm without translating it
/// into an Environment operation.
pub fn admit_direct_filesystem(
	request: v1::DirectFilesystemRequest,
	declared: bool,
	grant: Option<&DirectFilesystemGrant>,
) -> Result<AuditedDirectFilesystemRequest, DirectFilesystemError> {
	if !declared {
		return Err(DirectFilesystemError::Undeclared);
	}
	let grant = grant
		.filter(|grant| {
			grant.grant_id == request.grant_id
				&& grant.generation == request.generation
				&& grant.capability_digest.as_bytes() == request.capability_digest.as_ref()
		})
		.ok_or(DirectFilesystemError::Ungranted)?;
	if !matches!(request.operation.as_str(), "read" | "write" | "stat" | "list" | "mkdir" | "remove")
	{
		return Err(DirectFilesystemError::Operation);
	}
	if request.data.len() > MAX_DIRECT_FILESYSTEM_BYTES {
		return Err(DirectFilesystemError::PayloadTooLarge);
	}
	let path = PathBuf::from(request.absolute_path);
	if !path.is_absolute() {
		return Err(DirectFilesystemError::RelativePath);
	}
	Ok(AuditedDirectFilesystemRequest {
		operation: Str::new(request.operation),
		path,
		data: request.data,
		grant: grant.clone(),
	})
}

use std::{env, io, iter, mem};

use async_trait::async_trait;
use omp_con::{Ctx, DynamicVarSpec, TypeSpec, Value as ConValue, ValueKind, VarFlags};
use omp_core::{
	Hash32, InvocationPhase, LifecyclePhase, Principal, Provenance, Str, encoding::hex, sf,
};
use omp_ext::config::{ContributedCliValue, ContributedValue};
use omp_proto::{
	bounds::{
		PULL_ALIAS_MAX_COUNT, PULL_CHUNK_MAX_BYTES, PULL_EXPECTED_MAX_BYTES, PULL_NAME_MAX_BYTES,
		PULL_PATH_MAX_SEGMENTS,
	},
	env::v1::{ArgText, ArgsCommitted, Interrupt},
	thread::v1::{Blob, Item, Message, Part, Role, item, part},
	toolhost::{
		v1,
		v1::{
			ArtifactRow, DeclareSecretRules, JournalHostEnvelope, JournalWorkerEnvelope,
			ListArtifacts, ListSessions, PullReply, PullRequest, QueryUsage, SecretRuleDeclaration,
			SessionRow, SessionTransitionDenied, SessionTransitionRefusalCode, StatArtifact,
			UsageReport, journal_host_envelope, journal_worker_envelope,
		},
	},
};
use omp_secrets::rule::{SecretKind, SecretMode, SecretRule, SecretRuleError};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::{
	io::{AsyncReadExt, AsyncWriteExt},
	net::{
		UnixStream,
		unix::{OwnedReadHalf, OwnedWriteHalf},
	},
	runtime,
	sync::{Mutex as AsyncMutex, broadcast},
	task::AbortHandle,
};

use super::{
	dispatch::{CallbackConcurrency, DispatchError, DispatchRequest, DispatchRouter, EventDeadline},
	quota::{ChargeOutcome, ControlQuotaRuntime, QuotaError, ResourceReceipt, names, request_quota},
};
use crate::worker::HostKey;

/// Maximum number of unresolved cursor pulls accepted for one invocation.
pub const MAX_PENDING_PULLS: usize = 1;
/// Maximum declarations accepted from one extension activation.
pub const MAX_EXTENSION_SECRET_RULES: usize = 64;
const MAX_SECRET_CONTENT_BYTES: usize = 16 * 1024;
const MAX_SECRET_METADATA_BYTES: usize = 256;

/// A generation-fenced, activation-sealed extension secret declaration set.
#[derive(Debug, Default)]
pub struct ExtensionSecretDeclarations {
	extension_id: Option<Str>,
	generation:   u64,
	sealed:       bool,
	rules:        Vec<SecretRule>,
}

impl ExtensionSecretDeclarations {
	/// Validates and appends one bounded declaration frame before activation is
	/// sealed.
	pub fn declare(&mut self, frame: DeclareSecretRules) -> Result<(), SecretDeclarationError> {
		if self.sealed {
			return Err(SecretDeclarationError::Sealed);
		}
		if frame.extension_id.is_empty() {
			return Err(SecretDeclarationError::MissingExtension);
		}
		if self
			.extension_id
			.as_deref()
			.is_some_and(|id| id != frame.extension_id)
		{
			return Err(SecretDeclarationError::ExtensionMismatch);
		}
		if self.generation != 0 && self.generation != frame.activation_generation {
			return Err(SecretDeclarationError::GenerationMismatch {
				expected: self.generation,
				actual:   frame.activation_generation,
			});
		}
		if self.rules.len().saturating_add(frame.rules.len()) > MAX_EXTENSION_SECRET_RULES {
			return Err(SecretDeclarationError::TooManyRules);
		}
		let mut validated = Vec::with_capacity(frame.rules.len());
		for declaration in frame.rules {
			validated.push(validate_secret_declaration(declaration)?);
		}
		self
			.extension_id
			.get_or_insert_with(|| Str::new(frame.extension_id));
		self.generation = frame.activation_generation;
		self.rules.extend(validated);
		Ok(())
	}

	/// Seals declarations at the matching activation boundary and returns the
	/// immutable rules.
	pub fn seal(
		&mut self,
		activation_generation: u64,
	) -> Result<&[SecretRule], SecretDeclarationError> {
		if self.generation != 0 && self.generation != activation_generation {
			return Err(SecretDeclarationError::GenerationMismatch {
				expected: self.generation,
				actual:   activation_generation,
			});
		}
		self.sealed = true;
		Ok(&self.rules)
	}

	/// Returns the sealed declarations, or no value before activation.
	pub fn sealed_rules(&self) -> Option<&[SecretRule]> {
		self.sealed.then_some(&self.rules)
	}
}

/// Fail-closed extension secret declaration validation error.
#[derive(Debug, Error)]
pub enum SecretDeclarationError {
	/// Declarations were sent after activation sealing.
	#[error("secret declarations are sealed for this activation")]
	Sealed,
	/// The frame omitted its owning extension identity.
	#[error("secret declaration frame has no extension identity")]
	MissingExtension,
	/// A frame attempted to change extension identity.
	#[error("secret declaration frame extension identity does not match its connection")]
	ExtensionMismatch,
	/// A stale or future activation generation was supplied.
	#[error("secret declaration generation {actual} does not match {expected}")]
	GenerationMismatch {
		/// Activation generation retained by the declaration gate.
		expected: u64,
		/// Generation supplied by the extension-host frame.
		actual:   u64,
	},
	/// The extension exceeded its declaration bound.
	#[error("extension secret declaration limit exceeded")]
	TooManyRules,
	/// A declaration field exceeded the wire bound.
	#[error("extension secret declaration field exceeds its byte bound")]
	FieldTooLong,
	/// A declaration used an unknown kind.
	#[error("extension secret declaration kind is invalid")]
	InvalidKind,
	/// A declared environment variable is absent or non-Unicode.
	#[error("extension secret environment declaration cannot be resolved")]
	Environment(#[source] env::VarError),
	/// A declaration used an unknown mode.
	#[error("extension secret declaration mode is invalid")]
	InvalidMode,
	/// Core rule validation failed.
	#[error("extension secret declaration is invalid")]
	InvalidRule(#[from] SecretRuleError),
}

fn validate_secret_declaration(
	declaration: SecretRuleDeclaration,
) -> Result<SecretRule, SecretDeclarationError> {
	if declaration.content.len() > MAX_SECRET_CONTENT_BYTES
		|| declaration.kind.len() > MAX_SECRET_METADATA_BYTES
		|| declaration.mode.len() > MAX_SECRET_METADATA_BYTES
		|| declaration
			.replacement
			.as_ref()
			.is_some_and(|value| value.len() > MAX_SECRET_CONTENT_BYTES)
		|| declaration
			.flags
			.as_ref()
			.is_some_and(|value| value.len() > MAX_SECRET_METADATA_BYTES)
		|| declaration
			.friendly_name
			.as_ref()
			.is_some_and(|value| value.len() > MAX_SECRET_METADATA_BYTES)
	{
		return Err(SecretDeclarationError::FieldTooLong);
	}
	let (kind, content) = if declaration.kind.eq_ignore_ascii_case("env") {
		let value = env::var(&declaration.content).map_err(SecretDeclarationError::Environment)?;
		(SecretKind::Plain, value)
	} else {
		(
			SecretKind::from_str(&declaration.kind)
				.map_err(|_| SecretDeclarationError::InvalidKind)?,
			declaration.content,
		)
	};
	let mode =
		SecretMode::from_str(&declaration.mode).map_err(|_| SecretDeclarationError::InvalidMode)?;
	SecretRule::new(
		kind,
		mode,
		content,
		declaration.replacement.map(Str::new),
		declaration.flags.as_deref(),
		declaration.friendly_name.map(Str::new),
	)
	.map_err(Into::into)
}

/// Generation-fenced CLI values delivered once at activation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivationCliValue {
	/// Declaration sink key owned by this extension.
	pub sink:  Str,
	/// Typed contributed value.
	pub value: ContributedValue,
}

/// Per-extension activation value gate.
#[derive(Debug)]
pub struct ContributedValueDelivery {
	extension:  Str,
	generation: u64,
	delivered:  bool,
	values:     Vec<ActivationCliValue>,
}

/// Contributed-value delivery rejection.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ContributedValueError {
	/// A parsed value has no matching static owner/sink declaration.
	#[error("extension CLI value `{0}` is not declared by its owning manifest")]
	Undeclared(Str),
	/// Activation belongs to a different child generation.
	#[error("extension CLI activation generation {actual} does not match {expected}")]
	StaleGeneration {
		/// Child generation retained by the activation delivery gate.
		expected: u64,
		/// Generation presented by the requesting extension host.
		actual:   u64,
	},
	/// Values were requested twice for one activation.
	#[error("extension CLI values were already delivered for this activation")]
	AlreadyDelivered,
}

impl ContributedValueDelivery {
	/// Builds one declaration-checked delivery gate. Values belonging to other
	/// extensions are not copied into this owner.
	pub fn new(
		extension: impl Into<Str>,
		generation: u64,
		declarations: &omp_ext::config::CliContributionSet,
		values: &[ContributedCliValue],
	) -> Result<Self, ContributedValueError> {
		let extension = extension.into();
		let prefix = format!("{extension}:--");
		let declared = declarations
			.iter()
			.map(|(_, declaration)| (declaration.qualified_name(), declaration.sink.key.clone()))
			.collect::<BTreeSet<_>>();
		let mut owned = Vec::new();
		for value in values
			.iter()
			.filter(|value| value.owner.starts_with(&prefix))
		{
			if !declared.contains(&(value.owner.clone(), value.sink.clone())) {
				return Err(ContributedValueError::Undeclared(value.owner.clone()));
			}
			owned.push(ActivationCliValue { sink: value.sink.clone(), value: value.value.clone() });
		}
		Ok(Self { extension, generation, delivered: false, values: owned })
	}

	/// Takes the typed values exactly once for the matching live generation.
	pub fn deliver(
		&mut self,
		extension: &str,
		generation: u64,
	) -> Result<Vec<ActivationCliValue>, ContributedValueError> {
		if extension != self.extension || generation != self.generation {
			return Err(ContributedValueError::StaleGeneration {
				expected: self.generation,
				actual:   generation,
			});
		}
		if self.delivered {
			return Err(ContributedValueError::AlreadyDelivered);
		}
		self.delivered = true;
		Ok(mem::take(&mut self.values))
	}
}

/// Correlation established by the host between environment and worker identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvocationCorrelation {
	/// Nonzero tool-host envelope request identifier.
	pub request_id:    u64,
	/// Environment-plane invocation identifier.
	pub invocation_id: Str,
	/// Worker-plane call identifier.
	pub call_id:       Str,
	/// Whether the registered declaration selected streaming arguments.
	pub streams_args:  bool,
}

#[derive(Debug)]
struct InvocationState {
	correlation: InvocationCorrelation,
	pull_open:   bool,
}

/// Typed protocol failures produced before a CONTROL frame is staged.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum ControlError {
	/// Request id zero is reserved for registration, events, and health traffic.
	#[error("request id zero cannot identify an invocation")]
	ZeroRequestId,
	/// The environment invocation id is already live.
	#[error("invocation {0} is already mapped")]
	DuplicateInvocation(Str),
	/// A frame names no live invocation.
	#[error("invocation {0} is not live")]
	UnknownInvocation(Str),
	/// A frame's request id is stale or unknown.
	#[error("request id {0} is stale or unknown")]
	StaleRequest(u64),
	/// A worker call id does not match the request envelope.
	#[error("call id does not match request id {request_id}")]
	CallMismatch {
		/// Request envelope identifier.
		request_id: u64,
	},
	/// The declaration did not opt into speculative argument streaming.
	#[error("tool declaration did not enable streams_args")]
	StreamingNotDeclared,
	/// A second pull was attempted before the first pull completed.
	#[error("only one argument pull may be outstanding")]
	PullBusy,
	/// A pull or reply violated its declared allocation bound.
	#[error("argument pull violates the {field} bound")]
	PullBound {
		/// Name of the bounded field.
		field: &'static str,
	},
	/// A pull reply tried to complete when no pull was outstanding.
	#[error("pull reply has no outstanding pull")]
	NoOutstandingPull,
	/// The received CONTROL body is known but unsupported in this state.
	#[error("unsupported CONTROL frame: {0}")]
	Unsupported(&'static str),
}

/// Single-actor invocation map for multiplexed extension-host CONTROL traffic.
///
/// All mutation happens on the owning actor. The type deliberately contains no
/// lock: this preserves serialized callback entry unless an extension opts into
/// a separate concurrent host actor.
#[derive(Debug)]
pub struct HostRequestMap {
	next_request_id: u64,
	by_invocation:   BTreeMap<Str, u64>,
	by_request:      BTreeMap<u64, InvocationState>,
}

impl Default for HostRequestMap {
	fn default() -> Self {
		Self::new()
	}
}

impl HostRequestMap {
	/// Creates an empty map whose first invocation receives request id one.
	pub const fn new() -> Self {
		Self {
			next_request_id: 1,
			by_invocation:   BTreeMap::new(),
			by_request:      BTreeMap::new(),
		}
	}

	/// Establishes a live invocation mapping.
	///
	/// # Errors
	/// Returns [`ControlError::DuplicateInvocation`] if `invocation_id` is live.
	pub fn open(
		&mut self,
		invocation_id: Str,
		call_id: Str,
		streams_args: bool,
	) -> Result<InvocationCorrelation, ControlError> {
		if self.by_invocation.contains_key(&invocation_id) {
			return Err(ControlError::DuplicateInvocation(invocation_id));
		}
		let request_id = self.allocate_request_id();
		let correlation = InvocationCorrelation {
			request_id,
			invocation_id: invocation_id.clone(),
			call_id,
			streams_args,
		};
		self.by_invocation.insert(invocation_id, request_id);
		self.by_request.insert(request_id, InvocationState {
			correlation: correlation.clone(),
			pull_open:   false,
		});
		Ok(correlation)
	}

	/// Resolves and validates a forwarded `ArgText` frame.
	///
	/// # Errors
	/// Returns a typed stale or declaration error before the frame is staged.
	pub fn arg_text(&self, frame: &ArgText) -> Result<&InvocationCorrelation, ControlError> {
		let state = self.by_environment_id(frame.invocation_id.as_str())?;
		if !state.correlation.streams_args {
			return Err(ControlError::StreamingNotDeclared);
		}
		Ok(&state.correlation)
	}

	/// Resolves and validates a forwarded `ArgsCommitted` frame.
	///
	/// # Errors
	/// Returns a typed stale error before the frame is staged.
	pub fn args_committed(
		&self,
		frame: &ArgsCommitted,
	) -> Result<&InvocationCorrelation, ControlError> {
		self
			.by_environment_id(frame.invocation_id.as_str())
			.map(|state| &state.correlation)
	}

	/// Resolves and validates a forwarded `Interrupt` frame.
	///
	/// # Errors
	/// Returns a typed stale error before the frame is staged.
	pub fn interrupt(&self, frame: &Interrupt) -> Result<&InvocationCorrelation, ControlError> {
		self
			.by_environment_id(frame.invocation_id.as_str())
			.map(|state| &state.correlation)
	}

	/// Takes the sole outstanding pull slot after validating its request
	/// quartet.
	///
	/// # Errors
	/// Returns a stale, correlation, declaration, busy, or allocation-bound
	/// error.
	pub fn begin_pull(
		&mut self,
		request_id: u64,
		pull: &PullRequest,
	) -> Result<&InvocationCorrelation, ControlError> {
		if request_id == 0 {
			return Err(ControlError::ZeroRequestId);
		}
		validate_pull_bounds(pull)?;
		let state = self
			.by_request
			.get_mut(&request_id)
			.ok_or(ControlError::StaleRequest(request_id))?;
		if pull.call_id != state.correlation.call_id.as_str() {
			return Err(ControlError::CallMismatch { request_id });
		}
		if !state.correlation.streams_args {
			return Err(ControlError::StreamingNotDeclared);
		}
		if state.pull_open {
			return Err(ControlError::PullBusy);
		}
		state.pull_open = true;
		Ok(&state.correlation)
	}

	/// Validates one streamed reply and releases the pull slot on its terminal
	/// fragment.
	///
	/// A reply carrying an issue is terminal even if an untrusted peer omitted
	/// `complete`; the host never leaves the linear cursor borrowed after
	/// failure.
	///
	/// # Errors
	/// Returns a stale, correlation, state, or allocation-bound error.
	pub fn accept_pull_reply(
		&mut self,
		request_id: u64,
		reply: &PullReply,
	) -> Result<bool, ControlError> {
		if reply.chunk.len() > PULL_CHUNK_MAX_BYTES {
			return Err(ControlError::PullBound { field: "PullReply.chunk" });
		}
		let state = self
			.by_request
			.get_mut(&request_id)
			.ok_or(ControlError::StaleRequest(request_id))?;
		if reply.call_id != state.correlation.call_id.as_str() {
			return Err(ControlError::CallMismatch { request_id });
		}
		if !state.pull_open {
			return Err(ControlError::NoOutstandingPull);
		}
		let terminal = reply.complete || reply.issue.is_some();
		if terminal {
			state.pull_open = false;
		}
		Ok(terminal)
	}

	/// Fuses and removes a terminal invocation mapping.
	///
	/// # Errors
	/// Returns a stale or correlation error if the terminal frame does not name
	/// the live request.
	pub fn fuse(
		&mut self,
		request_id: u64,
		call_id: &str,
	) -> Result<InvocationCorrelation, ControlError> {
		let state = self
			.by_request
			.get(&request_id)
			.ok_or(ControlError::StaleRequest(request_id))?;
		if state.correlation.call_id.as_str() != call_id {
			return Err(ControlError::CallMismatch { request_id });
		}
		let state = self
			.by_request
			.remove(&request_id)
			.expect("validated request remains in the single-owner map");
		self.by_invocation.remove(&state.correlation.invocation_id);
		Ok(state.correlation)
	}

	/// Returns the live correlation for an envelope request id.
	///
	/// # Errors
	/// Returns [`ControlError::StaleRequest`] for an unknown request.
	pub fn request(&self, request_id: u64) -> Result<&InvocationCorrelation, ControlError> {
		self
			.by_request
			.get(&request_id)
			.map(|state| &state.correlation)
			.ok_or(ControlError::StaleRequest(request_id))
	}

	fn by_environment_id(&self, invocation_id: &str) -> Result<&InvocationState, ControlError> {
		let request_id = self
			.by_invocation
			.get(invocation_id)
			.ok_or_else(|| ControlError::UnknownInvocation(Str::from(invocation_id)))?;
		self
			.by_request
			.get(request_id)
			.ok_or(ControlError::StaleRequest(*request_id))
	}

	fn allocate_request_id(&mut self) -> u64 {
		loop {
			let candidate = self.next_request_id;
			self.next_request_id = self.next_request_id.wrapping_add(1).max(1);
			if candidate != 0 && !self.by_request.contains_key(&candidate) {
				return candidate;
			}
		}
	}
}

fn validate_pull_bounds(pull: &PullRequest) -> Result<(), ControlError> {
	if pull.path.len() > PULL_PATH_MAX_SEGMENTS {
		return Err(ControlError::PullBound { field: "PullRequest.path" });
	}
	if pull
		.path
		.iter()
		.any(|segment| segment.len() > PULL_NAME_MAX_BYTES)
	{
		return Err(ControlError::PullBound { field: "PullRequest.path segment" });
	}
	if pull
		.key
		.as_ref()
		.is_some_and(|key| key.len() > PULL_NAME_MAX_BYTES)
	{
		return Err(ControlError::PullBound { field: "PullRequest.key" });
	}
	if pull.aliases.len() > PULL_ALIAS_MAX_COUNT
		|| pull
			.aliases
			.iter()
			.any(|alias| alias.len() > PULL_NAME_MAX_BYTES)
	{
		return Err(ControlError::PullBound { field: "PullRequest.aliases" });
	}
	if pull
		.expected
		.as_ref()
		.is_some_and(|expected| expected.len() > PULL_EXPECTED_MAX_BYTES)
	{
		return Err(ControlError::PullBound { field: "PullRequest.expected" });
	}
	if usize::try_from(pull.chunk_bytes).map_or(true, |size| size > PULL_CHUNK_MAX_BYTES) {
		return Err(ControlError::PullBound { field: "PullRequest.chunk_bytes" });
	}
	Ok(())
}

/// Core-authenticated identity attached to a read-only journal CONTROL
/// connection.
///
/// Neither principal nor provenance is decoded from worker frames.
#[derive(Clone, Debug)]
pub struct JournalConnectionIdentity {
	/// Authenticated principal.
	pub principal:          Principal,
	/// Authenticated extension provenance.
	pub provenance:         Provenance,
	/// Live extension-host generation.
	pub host_generation:    u64,
	/// Live session generation.
	pub session_generation: u64,
}

/// A read-only session or artifact request served by its authoritative backend.
#[derive(Debug)]
pub enum ExternalJournalRequest {
	/// Authoritative sessions-index page.
	ListSessions {
		/// Envelope correlation.
		request_id: u64,
		/// Worker query payload.
		query:      ListSessions,
	},
	/// Authoritative sessions-index usage aggregation.
	QueryUsage {
		/// Envelope correlation.
		request_id: u64,
		/// Worker query payload.
		query:      QueryUsage,
	},
	/// Authoritative artifact metadata lookup.
	StatArtifact {
		/// Envelope correlation.
		request_id: u64,
		/// Worker query payload.
		request:    StatArtifact,
	},
	/// Authoritative artifact catalog page.
	ListArtifacts {
		/// Envelope correlation.
		request_id: u64,
		/// Worker query payload.
		request:    ListArtifacts,
	},
}

/// Result of dispatching one read-only journal-domain worker envelope.
#[derive(Debug)]
pub enum JournalDispatch {
	/// Immediate host reply.
	Reply(JournalHostEnvelope),
	/// Authenticated request for the authoritative read backend.
	External(ExternalJournalRequest),
}

/// Typed rejection of a journal-domain CONTROL frame.
#[derive(Debug, Error)]
pub enum JournalControlError {
	/// Request id zero cannot correlate a journal command.
	#[error("journal CONTROL request id must be nonzero")]
	ZeroRequestId,
	/// Journal envelope omitted its body.
	#[error("journal CONTROL envelope has no body")]
	MissingBody,
	/// Extensions may not declare journal kinds, append custom entries, or own
	/// an independent state log.
	#[error("extension journal mutation is unsupported; register a DOM Component")]
	UnsupportedMutation,
}

/// Read-only journal-domain CONTROL dispatcher.
///
/// Extension state is reduced into `<meta>` by registered Components. There is
/// deliberately no declaration, append, or scoped-state mutation path here.
#[derive(Default)]
pub struct JournalControl;

impl JournalControl {
	/// Creates a read-only dispatcher.
	#[must_use]
	pub const fn new() -> Self {
		Self
	}

	/// Dispatches one worker journal envelope.
	pub fn dispatch(
		&self,
		request_id: u64,
		envelope: JournalWorkerEnvelope,
		_ts: u64,
	) -> Result<JournalDispatch, JournalControlError> {
		if request_id == 0 {
			return Err(JournalControlError::ZeroRequestId);
		}
		let body = envelope.body.ok_or(JournalControlError::MissingBody)?;
		match body {
			journal_worker_envelope::Body::ListSessions(query) => {
				Ok(JournalDispatch::External(ExternalJournalRequest::ListSessions {
					request_id,
					query,
				}))
			},
			journal_worker_envelope::Body::QueryUsage(query) => {
				Ok(JournalDispatch::External(ExternalJournalRequest::QueryUsage { request_id, query }))
			},
			journal_worker_envelope::Body::StatArtifact(request) => {
				Ok(JournalDispatch::External(ExternalJournalRequest::StatArtifact {
					request_id,
					request,
				}))
			},
			journal_worker_envelope::Body::ListArtifacts(request) => {
				Ok(JournalDispatch::External(ExternalJournalRequest::ListArtifacts {
					request_id,
					request,
				}))
			},
			journal_worker_envelope::Body::CreateSession(_) => {
				Ok(JournalDispatch::Reply(journal_row_reply(
					journal_host_envelope::Body::SessionTransitionDenied(SessionTransitionDenied {
						code:    SessionTransitionRefusalCode::InvalidOrigin as i32,
						message: String::from(
							"session creation requires an interactive command CONTROL authority",
						),
						details: None,
					}),
				)))
			},
			journal_worker_envelope::Body::DeclareEntryKinds(_)
			| journal_worker_envelope::Body::AppendEntry(_)
			| journal_worker_envelope::Body::AppendEntriesAtomic(_)
			| journal_worker_envelope::Body::QueryJournal(_)
			| journal_worker_envelope::Body::AdoptArtifact(_)
			| journal_worker_envelope::Body::PinArtifact(_)
			| journal_worker_envelope::Body::StateGet(_)
			| journal_worker_envelope::Body::StateCas(_)
			| journal_worker_envelope::Body::StateWatch(_) => Err(JournalControlError::UnsupportedMutation),
		}
	}
}

/// Wraps one streamed journal row for a correlated host reply.
pub const fn journal_row_reply(body: journal_host_envelope::Body) -> JournalHostEnvelope {
	JournalHostEnvelope { body: Some(body), props: None }
}

/// Marks the last sessions-index row terminal, or emits one empty terminal
/// sentinel when the authoritative page is empty.
pub fn session_rows(
	rows: impl IntoIterator<Item = SessionRow>,
) -> impl Iterator<Item = JournalHostEnvelope> {
	fuse_rows(rows, |mut row, terminal| {
		row.terminal = terminal;
		journal_host_envelope::Body::SessionRow(row)
	})
}

/// Marks the last usage row terminal, or emits one empty terminal sentinel.
pub fn usage_rows(
	rows: impl IntoIterator<Item = UsageReport>,
) -> impl Iterator<Item = JournalHostEnvelope> {
	fuse_rows(rows, |mut row, terminal| {
		row.terminal = terminal;
		journal_host_envelope::Body::UsageReport(row)
	})
}

/// Marks the last artifact row terminal, or emits one empty terminal sentinel.
pub fn artifact_rows(
	rows: impl IntoIterator<Item = ArtifactRow>,
) -> impl Iterator<Item = JournalHostEnvelope> {
	fuse_rows(rows, |mut row, terminal| {
		row.terminal = terminal;
		journal_host_envelope::Body::ArtifactRow(row)
	})
}

fn fuse_rows<T: Default>(
	rows: impl IntoIterator<Item = T>,
	mut wrap: impl FnMut(T, bool) -> journal_host_envelope::Body,
) -> impl Iterator<Item = JournalHostEnvelope> {
	let mut rows = rows.into_iter().peekable();
	let mut emitted = false;
	iter::from_fn(move || {
		if let Some(row) = rows.next() {
			emitted = true;
			let terminal = rows.peek().is_none();
			return Some(journal_row_reply(wrap(row, terminal)));
		}
		if emitted {
			return None;
		}
		emitted = true;
		Some(journal_row_reply(wrap(T::default(), true)))
	})
}

/// Maximum length of one JSON CONTROL frame.
pub const MAX_CONTROL_FRAME_BYTES: usize = 64 * 1024 * 1024;
/// Maximum encoded size of one correlated dispatch progress frame.
pub const MAX_DISPATCH_PROGRESS_FRAME_BYTES: usize = 1024 * 1024;
/// Maximum progress events accepted from one invocation.
pub const MAX_DISPATCH_PROGRESS_EVENTS: usize = 1024;
/// Maximum aggregate bytes accepted across one invocation's progress frames.
pub const MAX_DISPATCH_PROGRESS_BYTES: usize = 16 * 1024 * 1024;
/// Maximum reassembled terminal dispatch body accepted before result spilling.
pub const MAX_DISPATCH_RESULT_BYTES: usize = 256 * 1024 * 1024;
/// Maximum decoded bytes accepted in one terminal-result chunk.
pub const MAX_DISPATCH_RESULT_CHUNK_BYTES: usize = 512 * 1024;

/// Core-authenticated identity for one extension-host CONTROL connection.
///
/// Every request context clones this value by `Arc`; principal, provenance,
/// generation, and capabilities are never decoded from child frames.
#[derive(Clone, Debug)]
pub struct ControlConnectionIdentity {
	/// Isolated extension owning the child.
	pub extension:          Str,
	/// Authenticated daemon principal.
	pub principal:          Principal,
	/// Verified extension artifact digest.
	pub artifact_digest:    Str,
	/// Winning deployment layer.
	pub layer:              Str,
	/// Admitted trust tier.
	pub tier:               Str,
	/// Python trust spelling (`sandboxed` or `trusted`).
	pub trust:              Str,
	/// Active child incarnation.
	pub host_generation:    u64,
	/// Active session incarnation.
	pub session_generation: u64,
	/// Durable manifest capability grants.
	pub capabilities:       Arc<BTreeSet<Str>>,
}

/// Host-issued invocation authority retained while one callback is live.
#[derive(Clone, Debug)]
pub struct ControlInvocationAuthority {
	/// Stable invocation identity used for nested requests and cancellation.
	pub invocation:        Str,
	/// Authoritative invocation phase; the child cannot advance it.
	pub phase:             InvocationPhase,
	/// Session owning the callback.
	pub session:           Str,
	/// Optional zero-based turn.
	pub turn:              Option<u64>,
	/// Optional hook or lifecycle event.
	pub event:             Option<Str>,
	/// Optional tool call identity.
	pub call:              Option<Str>,
	/// Optional resolved device identity.
	pub device:            Option<Str>,
	/// Authorized effect names.
	pub effects:           Box<[Str]>,
	/// Host or placement kind.
	pub place_kind:        Str,
	/// Current extension lifecycle phase.
	pub lifecycle:         LifecyclePhase,
	/// Typed workspace roots serialized for Python.
	pub roots:             Box<[Str]>,
	/// Whether the declaring workspace is remote.
	pub remote:            bool,
	/// Whether an interactive UI is attached.
	pub has_ui:            bool,
	/// Whether this session is headless.
	pub headless:          bool,
	/// Non-secret invocation settings.
	pub settings:          serde_json::Map<String, Value>,
	/// Setting names which must be redacted from structured logs.
	pub secret_settings:   Box<[Str]>,
	/// Optional invocation-scoped DATA binding grant.
	pub data:              Option<Value>,
	/// Optional durable direct-filesystem escape grant.
	pub direct_filesystem: Option<Value>,
}

/// Authenticated request context handed to an authoritative domain owner.
#[derive(Clone, Debug)]
pub struct ControlRequestContext {
	/// Connection identity stamped by Core.
	pub connection: Arc<ControlConnectionIdentity>,
	/// Child-local request correlation.
	pub request_id: u64,
	/// Host-issued callback authority, if the request was nested in a callback.
	pub invocation: Option<ControlInvocationAuthority>,
}

/// Typed protocol rejection returned to Python without stringifying success.
#[derive(Clone, Debug, Error)]
#[error("{code}: {message}")]
pub struct ControlProtocolError {
	/// Stable machine-readable error code or Python domain exception name.
	pub code:      Str,
	/// Human-readable diagnostic.
	pub message:   Str,
	/// Whether retrying after the documented condition changes may succeed.
	pub retryable: bool,
	/// Typed domain details used to construct Python exceptions.
	pub details:   Value,
}

impl ControlProtocolError {
	/// Builds a typed protocol rejection.
	pub fn new(code: impl Into<Str>, message: impl Into<Str>) -> Self {
		Self {
			code:      code.into(),
			message:   message.into(),
			retryable: false,
			details:   Value::Null,
		}
	}

	/// Marks a rejection retryable.
	pub const fn retryable(mut self, retryable: bool) -> Self {
		self.retryable = retryable;
		self
	}

	/// Attaches typed error details.
	pub fn with_details(mut self, details: Value) -> Self {
		self.details = details;
		self
	}

	fn wire(&self) -> Value {
		json!({
			"code": self.code.as_str(),
			"message": self.message.as_str(),
			"retryable": self.retryable,
			"details": &self.details,
		})
	}

	fn malformed(message: impl Into<Str>) -> Self {
		Self::new("malformed_frame", message)
	}

	fn stale_generation(expected: u64, actual: u64, field: &'static str) -> Self {
		Self::new("StaleGeneration", format!("stale {field}: expected {expected}, got {actual}"))
			.with_details(json!({"field": field, "expected": expected, "actual": actual}))
	}
}
/// Maximum visible prompt parts admitted into one new session.
pub const MAX_SESSION_PROMPT_PARTS: usize = 32;
/// Maximum aggregate visible prompt text admitted into one new session.
pub const MAX_SESSION_PROMPT_BYTES: usize = 256 * 1024;

/// Canonical, generation-fenced create/seed/switch request admitted from
/// Python.
#[derive(Debug)]
pub struct CanonicalSessionCreate {
	/// Optional user title.
	pub title:              Option<Str>,
	/// Optional accessible lineage parent.
	pub parent:             Option<Str>,
	/// Optional visible user item; it is not a turn input.
	pub initial_prompt:     Option<Item>,
	/// Stable logical identity shared by retries inside one command invocation.
	pub idempotency_key:    Str,
	/// Authenticated extension-host generation.
	pub host_generation:    u64,
	/// Authenticated session generation.
	pub session_generation: u64,
}

/// Canonically validates a declarative session setup before allocation.
pub fn canonical_session_create(
	context: &ControlRequestContext,
	arguments: &serde_json::Map<String, Value>,
) -> Result<CanonicalSessionCreate, ControlProtocolError> {
	let invocation = context.invocation.as_ref().ok_or_else(|| {
		session_transition_denied(
			"invalid_origin",
			"session creation requires an interactive command",
		)
	})?;
	if invocation.phase != InvocationPhase::EffectsAuthorized {
		return Err(session_transition_denied(
			"effects_not_authorized",
			"session creation requires EFFECTS_AUTHORIZED",
		));
	}
	if !invocation.has_ui
		|| invocation.headless
		|| invocation.turn.is_some()
		|| invocation.event.is_some()
		|| invocation.call.is_some()
		|| invocation.device.is_some()
	{
		return Err(session_transition_denied(
			"invalid_origin",
			"session creation is restricted to user-initiated interactive commands",
		));
	}
	let setup = arguments
		.get("setup")
		.and_then(Value::as_object)
		.ok_or_else(|| session_transition_denied("invalid_setup", "setup must be an object"))?;
	if setup.get("schema").and_then(Value::as_str) != Some("omp.sessions.setup.v1") {
		return Err(session_transition_denied(
			"invalid_setup",
			"setup schema must be omp.sessions.setup.v1",
		));
	}
	let title = bounded_setup_string(setup, "title", 512)?;
	let parent = bounded_setup_string(setup, "parent", 128)?;
	if setup
		.get("entries")
		.and_then(Value::as_array)
		.is_some_and(|entries| !entries.is_empty())
	{
		return Err(session_transition_denied(
			"invalid_setup",
			"extension session setup entries are prohibited; register a DOM Component",
		));
	}
	let initial_prompt = setup
		.get("initial_prompt")
		.filter(|value| !value.is_null())
		.map(canonical_session_prompt)
		.transpose()?;
	let setup_json = serde_json::to_vec(setup)
		.map_err(|_| session_transition_denied("invalid_setup", "setup cannot be encoded"))?;
	let setup_digest = Hash32::sum(&setup_json);
	let idempotency_key = Str::from(format!(
		"session-create:{}:{}:{}:{}:{}",
		context.connection.extension,
		context.connection.host_generation,
		context.connection.session_generation,
		invocation.invocation,
		setup_digest.to_hex()
	));
	Ok(CanonicalSessionCreate {
		title,
		parent,
		initial_prompt,
		idempotency_key,
		host_generation: context.connection.host_generation,
		session_generation: context.connection.session_generation,
	})
}
fn bounded_setup_string(
	object: &serde_json::Map<String, Value>,
	field: &'static str,
	limit: usize,
) -> Result<Option<Str>, ControlProtocolError> {
	match object.get(field) {
		None | Some(Value::Null) => Ok(None),
		Some(Value::String(value)) if !value.trim().is_empty() && value.len() <= limit => {
			Ok(Some(Str::new(value)))
		},
		Some(Value::String(_)) => Err(session_transition_denied(
			"invalid_setup",
			format!("setup.{field} must be non-empty and at most {limit} bytes"),
		)),
		Some(_) => Err(session_transition_denied(
			"invalid_setup",
			format!("setup.{field} must be a string or null"),
		)),
	}
}

fn canonical_session_prompt(value: &Value) -> Result<Item, ControlProtocolError> {
	let values = value.as_array().ok_or_else(|| {
		session_transition_denied("invalid_setup", "initial_prompt must be an array of parts")
	})?;
	if values.is_empty() || values.len() > MAX_SESSION_PROMPT_PARTS {
		return Err(session_transition_denied(
			"quota_exceeded",
			"initial_prompt part count is outside the allowed range",
		));
	}
	let mut bytes = 0_usize;
	let mut parts = Vec::with_capacity(values.len());
	for value in values {
		let part = value.as_object().ok_or_else(|| {
			session_transition_denied("invalid_setup", "initial_prompt parts must be objects")
		})?;
		let kind = match part.get("kind").and_then(Value::as_str) {
			Some("text") => {
				let text = part.get("text").and_then(Value::as_str).ok_or_else(|| {
					session_transition_denied("invalid_setup", "text prompt part is missing text")
				})?;
				bytes = bytes.saturating_add(text.len());
				part::Kind::Text(text.to_owned())
			},
			Some("blob") => {
				let blob = part.get("blob").and_then(Value::as_object).ok_or_else(|| {
					session_transition_denied("invalid_setup", "blob prompt part is missing blob")
				})?;
				let encoded = blob.get("hash").and_then(Value::as_str).ok_or_else(|| {
					session_transition_denied("invalid_setup", "blob prompt part is missing hash")
				})?;
				let hash = <[u8; 32]>::try_from(hex::decode(encoded.as_bytes())).map_err(|_| {
					session_transition_denied("invalid_setup", "blob prompt hash is invalid")
				})?;
				let size = blob.get("size").and_then(Value::as_u64).ok_or_else(|| {
					session_transition_denied("invalid_setup", "blob prompt part is missing size")
				})?;
				part::Kind::Blob(Blob { hash: hash.to_vec().into(), size, ..Default::default() })
			},
			_ => {
				return Err(session_transition_denied(
					"invalid_setup",
					"initial_prompt accepts only visible text and blob parts",
				));
			},
		};
		if bytes > MAX_SESSION_PROMPT_BYTES {
			return Err(session_transition_denied(
				"quota_exceeded",
				"initial_prompt bytes exceed the limit",
			));
		}
		parts.push(Part { kind: Some(kind) });
	}
	Ok(Item {
		seq:           0,
		created_at_ms: 0,
		kind:          Some(item::Kind::Message(Message {
			role: Role::User as i32,
			parts,
			..Default::default()
		})),
		props:         None,
	})
}

fn session_transition_denied(
	reason: &'static str,
	message: impl Into<Str>,
) -> ControlProtocolError {
	ControlProtocolError::new("SessionTransitionDenied", message)
		.with_details(json!({"reason": reason}))
}

/// One authoritative fire-and-forget child observation.
#[derive(Clone, Debug)]
pub enum ControlEffect {
	/// Session intent contribution requiring provider arbitration.
	Intent(Value),
	/// Retained UI effect data.
	Ui(Value),
	/// Structured or captured child log.
	Log(Value),
	/// Droppable telemetry instrument event.
	Instrument(Value),
}

/// App-side authority for every child-initiated `omp.*` CONTROL operation.
///
/// Implementations must route to the owning Core service. `handles` and
/// `authorize` are separate so unknown operations and phase/capability
/// violations cannot accidentally become successful null responses.
#[async_trait]
pub trait ControlAuthority: Send + Sync + 'static {
	/// Returns whether this authority owns the exact operation spelling.
	fn handles(&self, operation: &str) -> bool;

	/// Applies operation-spec phase, capability, principal, and policy gates.
	fn authorize(
		&self,
		context: &ControlRequestContext,
		operation: &str,
		arguments: &serde_json::Map<String, Value>,
	) -> Result<(), ControlProtocolError>;

	/// Executes one already-authorized operation against its authoritative
	/// service.
	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: serde_json::Map<String, Value>,
	) -> Result<Value, ControlProtocolError>;

	/// Publishes one generation-fenced UI/log/telemetry effect.
	async fn effect(
		&self,
		context: ControlRequestContext,
		effect: ControlEffect,
	) -> Result<(), ControlProtocolError>;
}

/// Construction failure for a connection-scoped CONTROL authority.
#[derive(Clone, Debug, Error)]
#[error("CONTROL authority {domain} is unavailable: {message}")]
pub struct ControlCompositionError {
	domain:  &'static str,
	message: Str,
}

impl ControlCompositionError {
	/// Reports that one required authority could not be bound for the
	/// connection.
	pub fn unavailable(domain: &'static str, message: impl Into<Str>) -> Self {
		Self { domain, message: message.into() }
	}

	/// Required domain which failed to bind.
	pub const fn domain(&self) -> &'static str {
		self.domain
	}

	/// Underlying construction diagnostic.
	pub const fn message(&self) -> &Str {
		&self.message
	}

	fn in_domain(mut self, domain: &'static str) -> Self {
		self.domain = domain;
		self
	}
}

/// Builds an authority from the authenticated identity of one live connection.
pub trait ControlAuthorityFactory: Send + Sync + 'static {
	/// Binds the owner before the CONTROL pump starts.
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError>;
}

impl<F> ControlAuthorityFactory for F
where
	F: Fn(
			Arc<ControlConnectionIdentity>,
		) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError>
		+ Send
		+ Sync
		+ 'static,
{
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		self(identity)
	}
}

/// Connection-independent authority factory.
pub struct FixedControlAuthorityFactory {
	authority: Arc<dyn ControlAuthority>,
}

impl FixedControlAuthorityFactory {
	/// Wraps an authority which reads connection facts from each request
	/// context.
	pub fn new(authority: Arc<dyn ControlAuthority>) -> Self {
		Self { authority }
	}
}

impl ControlAuthorityFactory for FixedControlAuthorityFactory {
	fn bind(
		&self,
		_identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		Ok(Arc::clone(&self.authority))
	}
}

#[derive(Clone, Debug)]
struct ConvarChange {
	sequence: u64,
	name:     Str,
	value:    ConValue,
}

struct ConvarBroker {
	sequence: AtomicU64,
	latest:   Mutex<omp_core::FastHashMap<Str, u64>>,
	changes:  broadcast::Sender<ConvarChange>,
}

/// Factory for the shared read-only convar query and observation surface.
///
/// Declarations are restricted to the authenticated extension's
/// `ext::<extension>::` namespace. The manifest remains authoritative; a
/// reconnect may repeat an identical declaration but cannot replace it.
pub struct ConvarControlFactory {
	ctx:    Arc<Ctx>,
	broker: Arc<ConvarBroker>,
}

impl ConvarControlFactory {
	/// Installs one observer on the authoritative control context.
	#[must_use]
	pub fn new(ctx: Arc<Ctx>) -> Self {
		let (changes, _) = broadcast::channel(256);
		let broker = Arc::new(ConvarBroker {
			sequence: AtomicU64::new(0),
			latest: Mutex::new(omp_core::FastHashMap::default()),
			changes,
		});
		let observer = Arc::clone(&broker);
		ctx.observe(move |name, _, value| {
			let sequence = observer.sequence.fetch_add(1, Ordering::AcqRel) + 1;
			let name = Str::new(name);
			observer.latest.lock().insert(name.clone(), sequence);
			let _ = observer
				.changes
				.send(ConvarChange { sequence, name, value: value.clone() });
		});
		Self { ctx, broker }
	}
}

impl ControlAuthorityFactory for ConvarControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		Ok(Arc::new(ConvarControlAuthority {
			ctx: Arc::clone(&self.ctx),
			broker: Arc::clone(&self.broker),
			identity,
		}))
	}
}

struct ConvarControlAuthority {
	ctx:      Arc<Ctx>,
	broker:   Arc<ConvarBroker>,
	identity: Arc<ControlConnectionIdentity>,
}

#[async_trait]
impl ControlAuthority for ConvarControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		matches!(operation, "omp.convars.declare" | "omp.convars.get" | "omp.convars.observe")
	}

	fn authorize(
		&self,
		_context: &ControlRequestContext,
		operation: &str,
		_arguments: &serde_json::Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		if self.handles(operation) {
			Ok(())
		} else {
			Err(ControlProtocolError::new(
				"InvalidOperation",
				"the convar authority does not own this operation",
			))
		}
	}

	async fn request(
		&self,
		_context: ControlRequestContext,
		operation: Str,
		arguments: serde_json::Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		match operation.as_str() {
			"omp.convars.declare" => self.declare(&arguments),
			"omp.convars.get" => {
				let name = required_convar_argument(&arguments, "name")?;
				self.snapshot(name)
			},
			"omp.convars.observe" => self.observe(&arguments).await,
			_ => {
				Err(ControlProtocolError::new("InvalidOperation", "unknown convar CONTROL operation"))
			},
		}
	}

	async fn effect(
		&self,
		_context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		Err(ControlProtocolError::new(
			"InvalidOperation",
			"the convar authority accepts requests only",
		))
	}
}

impl ConvarControlAuthority {
	fn declare(
		&self,
		arguments: &serde_json::Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		let key = required_convar_argument(arguments, "key")?;
		if key.trim() != key || key.contains("::") {
			return Err(ControlProtocolError::new(
				"InvalidConvarDeclaration",
				"extension convar keys must be trimmed and cannot contain '::'",
			));
		}
		let kind = required_convar_argument(arguments, "kind")?;
		let default = arguments.get("default").ok_or_else(|| {
			ControlProtocolError::new(
				"InvalidConvarDeclaration",
				"extension convar declarations require a default",
			)
		})?;
		let (ty, default) = declaration_value(kind, default, arguments.get("values"))?;
		let name = omp_ext::config::extension_setting_convar_name(&self.identity.extension, key);
		let spec = DynamicVarSpec {
			name: name.clone(),
			desc: arguments
				.get("description")
				.and_then(Value::as_str)
				.map_or_else(
					|| sf!("Setting {key} declared by extension {}", self.identity.extension),
					Str::new,
				),
			ty,
			flags: VarFlags::ARCHIVE
				.with(VarFlags::SESSION)
				.with(VarFlags::REPLICATED),
			default,
			meta: declaration_metadata(arguments, name.as_str(), ty)?,
		};
		if let Some(existing) = self.ctx.dynamic_var_spec(name.as_str()) {
			if existing != spec {
				return Err(ControlProtocolError::new(
					"ConvarDeclarationConflict",
					"extension convar declaration differs from the admitted declaration",
				));
			}
		} else {
			self
				.ctx
				.register_dynamic_var(spec)
				.map_err(control_convar_error)?;
		}
		self.snapshot(name.as_str())
	}

	fn snapshot(&self, name: &str) -> Result<Value, ControlProtocolError> {
		let value = self.ctx.value(name).map_err(control_convar_error)?;
		let sequence = self.broker.latest.lock().get(name).copied().unwrap_or(0);
		convar_snapshot(name, sequence, &value)
	}

	async fn observe(
		&self,
		arguments: &serde_json::Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		let name = required_convar_argument(arguments, "name")?;
		self.ctx.value(name).map_err(control_convar_error)?;
		let after = arguments.get("after").and_then(Value::as_u64);
		let mut receiver = self.broker.changes.subscribe();
		let latest = self.broker.latest.lock().get(name).copied().unwrap_or(0);
		if after.is_none_or(|after| latest > after) {
			return self.snapshot(name);
		}
		loop {
			match receiver.recv().await {
				Ok(change) if change.name == name => {
					return convar_snapshot(name, change.sequence, &change.value);
				},
				Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {},
				Err(broadcast::error::RecvError::Closed) => {
					return Err(
						ControlProtocolError::new(
							"ConvarObservationClosed",
							"the convar observation stream closed",
						)
						.retryable(true),
					);
				},
			}
		}
	}
}

fn required_convar_argument<'a>(
	arguments: &'a serde_json::Map<String, Value>,
	name: &str,
) -> Result<&'a str, ControlProtocolError> {
	arguments
		.get(name)
		.and_then(Value::as_str)
		.filter(|value| !value.is_empty())
		.ok_or_else(|| {
			ControlProtocolError::new(
				"InvalidConvarArgument",
				sf!("convar operation requires a non-empty {name}"),
			)
		})
}

fn declaration_metadata(
	arguments: &serde_json::Map<String, Value>,
	convar: &str,
	ty: &TypeSpec,
) -> Result<Arc<[(Str, Str)]>, ControlProtocolError> {
	let Some(value) = arguments.get("ui") else {
		return Ok(Arc::from([]));
	};
	let object = value.as_object().ok_or_else(|| {
		ControlProtocolError::new(
			"InvalidConvarDeclaration",
			"extension convar ui metadata must be an object",
		)
	})?;
	let tab = Str::new(required_convar_argument(object, "tab")?);
	let group = Str::new(required_convar_argument(object, "group")?);
	let label = Str::new(required_convar_argument(object, "label")?);
	let description = Str::new(required_convar_argument(object, "description")?);
	let warning = object.get("warning").and_then(Value::as_str).map(Str::new);
	let options = object.get("options").map_or(Ok(Vec::new()), |value| {
		value
			.as_array()
			.ok_or_else(|| {
				ControlProtocolError::new(
					"InvalidConvarDeclaration",
					"extension convar ui options must be an array",
				)
			})?
			.iter()
			.map(|value| {
				let option = value.as_object().ok_or_else(|| {
					ControlProtocolError::new(
						"InvalidConvarDeclaration",
						"extension convar ui option must be an object",
					)
				})?;
				Ok((
					Str::new(required_convar_argument(option, "value")?),
					Str::new(required_convar_argument(option, "label")?),
					option
						.get("description")
						.and_then(Value::as_str)
						.map_or_else(Str::default, Str::new),
				))
			})
			.collect::<Result<Vec<_>, ControlProtocolError>>()
	})?;
	if tab.trim().is_empty()
		|| group.trim().is_empty()
		|| label.trim().is_empty()
		|| label == convar
		|| label.contains("::")
		|| options.iter().enumerate().any(|(index, option)| {
			option.1.trim().is_empty()
				|| options[..index]
					.iter()
					.any(|previous| previous.0 == option.0)
		}) {
		return Err(ControlProtocolError::new(
			"InvalidConvarDeclaration",
			"extension convar ui metadata requires a non-technical label and unique option values",
		));
	}
	if options.is_empty() && ty.kind == ValueKind::List {
		return Err(ControlProtocolError::new(
			"InvalidConvarDeclaration",
			"list convar ui metadata requires finite options",
		));
	}

	let mut meta = vec![
		(Str::new("ui.tab"), tab),
		(Str::new("ui.group"), group),
		(Str::new("ui.label"), label),
		(Str::new("ui.description"), description),
	];
	if let Some(warning) = warning {
		meta.push((Str::new("ui.warning"), warning));
	}
	for (value, label, description) in options {
		meta.push((sf!("ui.option.{value}"), label));
		meta.push((sf!("ui.option.{value}.desc"), description));
	}
	if object.get("ordered").and_then(Value::as_bool) == Some(true) {
		meta.push((Str::new("ui.ordered"), Str::new("true")));
	}
	Ok(meta.into())
}

fn declaration_value(
	kind: &str,
	default: &Value,
	values: Option<&Value>,
) -> Result<(&'static TypeSpec, ConValue), ControlProtocolError> {
	let invalid = || {
		ControlProtocolError::new(
			"InvalidConvarDeclaration",
			"extension convar default does not match its declared kind",
		)
	};
	match kind {
		"boolean" => default
			.as_bool()
			.map(|value| (TypeSpec::BOOL, ConValue::Bool(value)))
			.ok_or_else(invalid),
		"number" => default
			.as_f64()
			.map(|value| (TypeSpec::FLOAT, ConValue::Float(value)))
			.ok_or_else(invalid),
		"string" => default
			.as_str()
			.map(|value| (TypeSpec::STR, ConValue::Str(Str::new(value))))
			.ok_or_else(invalid),
		"array" => {
			let values = default.as_array().ok_or_else(invalid)?;
			let values = values
				.iter()
				.map(|value| {
					value
						.as_str()
						.map(|value| ConValue::Str(Str::new(value)))
						.ok_or_else(invalid)
				})
				.collect::<Result<Vec<_>, _>>()?;
			Ok((<Vec<Str> as omp_con::ConType>::SPEC, ConValue::List(values)))
		},
		"enum" => {
			let default = default.as_str().ok_or_else(invalid)?;
			let values = values.and_then(Value::as_array).ok_or_else(|| {
				ControlProtocolError::new(
					"InvalidConvarDeclaration",
					"enum convar declarations require a values array",
				)
			})?;
			if !values.iter().any(|value| value.as_str() == Some(default)) {
				return Err(ControlProtocolError::new(
					"InvalidConvarDeclaration",
					"enum convar default is not in values",
				));
			}
			Ok((TypeSpec::STR, ConValue::Str(Str::new(default))))
		},
		_ => {
			Err(ControlProtocolError::new("InvalidConvarDeclaration", "unknown extension convar kind"))
		},
	}
}

fn convar_snapshot(
	name: &str,
	sequence: u64,
	value: &ConValue,
) -> Result<Value, ControlProtocolError> {
	Ok(json!({
		"name": name,
		"kind": value.kind().to_string(),
		"value": convar_json(value)?,
		"sequence": sequence,
	}))
}

fn convar_json(value: &ConValue) -> Result<Value, ControlProtocolError> {
	match value {
		ConValue::Bool(value) => Ok(Value::Bool(*value)),
		ConValue::Int(value) => Ok(Value::Number((*value).into())),
		ConValue::Float(value) => serde_json::Number::from_f64(*value)
			.map(Value::Number)
			.ok_or_else(|| {
				ControlProtocolError::new(
					"InvalidConvarValue",
					"non-finite convar values cannot cross CONTROL",
				)
			}),
		ConValue::Str(value) | ConValue::Enum(value) => Ok(Value::String(value.to_string())),
		ConValue::Duration(value) => Ok(Value::String(value.to_string())),
		ConValue::List(values) => values
			.iter()
			.map(convar_json)
			.collect::<Result<Vec<_>, _>>()
			.map(Value::Array),
		ConValue::Kv(values) => values
			.iter()
			.map(|(key, value)| Ok((key.to_string(), convar_json(value)?)))
			.collect::<Result<serde_json::Map<_, _>, _>>()
			.map(Value::Object),
	}
}

fn control_convar_error(source: omp_con::ConError) -> ControlProtocolError {
	match source {
		omp_con::ConError::Unknown { name } => {
			ControlProtocolError::new("UnknownConvar", "the requested convar is not declared")
				.with_details(json!({"name": name}))
		},
		omp_con::ConError::Duplicate { name } => {
			ControlProtocolError::new("ConvarAlreadyDeclared", "the convar is already declared")
				.with_details(json!({"name": name}))
		},
		omp_con::ConError::TypeMismatch { name, expected, got } => {
			ControlProtocolError::new("ConvarTypeMismatch", "the convar value has the wrong type")
				.with_details(json!({
					"name": name,
					"expected": expected.to_string(),
					"got": got,
				}))
		},
		_ => {
			ControlProtocolError::new("ConvarError", "the control plane rejected the convar operation")
		},
	}
}

/// Device and hook authorities owned by envd.
pub struct RegistryControlAuthorities {
	devices: Arc<dyn ControlAuthorityFactory>,
	hooks:   Arc<dyn ControlAuthorityFactory>,
}

impl RegistryControlAuthorities {
	/// Installs device-routing and hook owners.
	pub fn new(
		devices: Arc<dyn ControlAuthorityFactory>,
		hooks: Arc<dyn ControlAuthorityFactory>,
	) -> Self {
		Self { devices, hooks }
	}
}

/// Session, artifact, and credential authorities.
pub struct PersistenceControlAuthorities {
	sessions:    Arc<dyn ControlAuthorityFactory>,
	artifacts:   Arc<dyn ControlAuthorityFactory>,
	credentials: Arc<dyn ControlAuthorityFactory>,
}

impl PersistenceControlAuthorities {
	/// Installs the remaining persistence owners.
	pub fn new(
		sessions: Arc<dyn ControlAuthorityFactory>,
		artifacts: Arc<dyn ControlAuthorityFactory>,
		credentials: Arc<dyn ControlAuthorityFactory>,
	) -> Self {
		Self { sessions, artifacts, credentials }
	}
}

/// Policy and prompt authorities.
pub struct PolicyControlAuthorities {
	policy:  Arc<dyn ControlAuthorityFactory>,
	prompts: Arc<dyn ControlAuthorityFactory>,
}

impl PolicyControlAuthorities {
	/// Installs policy admission and interactive prompt owners.
	pub fn new(
		policy: Arc<dyn ControlAuthorityFactory>,
		prompts: Arc<dyn ControlAuthorityFactory>,
	) -> Self {
		Self { policy, prompts }
	}
}

/// UI, telemetry, and job authorities.
pub struct PresentationControlAuthorities {
	ui:        Arc<dyn ControlAuthorityFactory>,
	telemetry: Arc<dyn ControlAuthorityFactory>,
	jobs:      Arc<dyn ControlAuthorityFactory>,
}

impl PresentationControlAuthorities {
	/// Installs presentation, observation, and job owners.
	pub fn new(
		ui: Arc<dyn ControlAuthorityFactory>,
		telemetry: Arc<dyn ControlAuthorityFactory>,
		jobs: Arc<dyn ControlAuthorityFactory>,
	) -> Self {
		Self { ui, telemetry, jobs }
	}
}

/// Provider and extension-service authorities.
pub struct ProviderControlAuthorities {
	provider: Arc<dyn ControlAuthorityFactory>,
	services: Arc<dyn ControlAuthorityFactory>,
}

impl ProviderControlAuthorities {
	/// Installs provider handoff and service-broker owners.
	pub fn new(
		provider: Arc<dyn ControlAuthorityFactory>,
		services: Arc<dyn ControlAuthorityFactory>,
	) -> Self {
		Self { provider, services }
	}
}

/// Envd-owned CONTROL authority composition.
pub struct EnvdControlAuthorities {
	registry:     RegistryControlAuthorities,
	persistence:  PersistenceControlAuthorities,
	policy:       PolicyControlAuthorities,
	presentation: PresentationControlAuthorities,
	provider:     ProviderControlAuthorities,
	auxiliary:    Arc<dyn ControlAuthorityFactory>,
	effects:      Arc<dyn ControlAuthorityFactory>,
}

impl EnvdControlAuthorities {
	/// Requires every envd-owned domain and the sole observation sink.
	pub fn new(
		registry: RegistryControlAuthorities,
		persistence: PersistenceControlAuthorities,
		policy: PolicyControlAuthorities,
		presentation: PresentationControlAuthorities,
		provider: ProviderControlAuthorities,
		auxiliary: Arc<dyn ControlAuthorityFactory>,
		effects: Arc<dyn ControlAuthorityFactory>,
	) -> Self {
		Self { registry, persistence, policy, presentation, provider, auxiliary, effects }
	}
}

/// Typed hooks implemented by the app/driver composition.
pub struct ExternalControlAuthorities {
	agents: Arc<dyn ControlAuthorityFactory>,
	mcp:    Arc<dyn ControlAuthorityFactory>,
}

impl ExternalControlAuthorities {
	/// Requires both cross-crate owners before a CONTROL connection can start.
	pub fn new(
		agents: Arc<dyn ControlAuthorityFactory>,
		mcp: Arc<dyn ControlAuthorityFactory>,
	) -> Self {
		Self { agents, mcp }
	}
}

/// Production factory for the complete host-side CONTROL router.
pub struct HostControlAuthorityFactory {
	envd:     EnvdControlAuthorities,
	external: ExternalControlAuthorities,
	quota:    Option<ControlQuotaRuntime>,
}

impl HostControlAuthorityFactory {
	/// Combines envd authorities with the required app/driver hooks.
	pub fn new(envd: EnvdControlAuthorities, external: ExternalControlAuthorities) -> Self {
		Self { envd, external, quota: None }
	}

	/// Installs the sole shared quota runtime around every authenticated domain.
	#[must_use]
	pub fn with_quota_runtime(mut self, quota: ControlQuotaRuntime) -> Self {
		self.quota = Some(quota);
		self
	}

	/// Binds every required owner and returns the live disjoint router.
	pub fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		self.bind_with_agents(identity, Arc::clone(&self.external.agents))
	}

	/// Binds the router with the current lifecycle-fenced chat authority while
	/// retaining the independently scoped MCP owner from this composition.
	pub(crate) fn bind_with_agents(
		&self,
		identity: Arc<ControlConnectionIdentity>,
		agents: Arc<dyn ControlAuthorityFactory>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		let factories = [
			(ControlDomain::Devices, "devices", &self.envd.registry.devices),
			(ControlDomain::Hooks, "hooks", &self.envd.registry.hooks),
			(ControlDomain::Sessions, "sessions", &self.envd.persistence.sessions),
			(ControlDomain::Artifacts, "artifacts", &self.envd.persistence.artifacts),
			(ControlDomain::Credentials, "credentials", &self.envd.persistence.credentials),
			(ControlDomain::Policy, "policy", &self.envd.policy.policy),
			(ControlDomain::Prompts, "prompts", &self.envd.policy.prompts),
			(ControlDomain::Ui, "ui", &self.envd.presentation.ui),
			(ControlDomain::Telemetry, "telemetry", &self.envd.presentation.telemetry),
			(ControlDomain::Jobs, "jobs", &self.envd.presentation.jobs),
			(ControlDomain::Provider, "provider", &self.envd.provider.provider),
			(ControlDomain::Services, "services", &self.envd.provider.services),
			(ControlDomain::Auxiliary, "auxiliary", &self.envd.auxiliary),
			(ControlDomain::Agents, "agents", &agents),
			(ControlDomain::Mcp, "mcp", &self.external.mcp),
		];
		let mut domains = Vec::<Arc<dyn ControlAuthority>>::with_capacity(factories.len());
		let mut ui_effect = None;
		let mut telemetry_effect = None;
		for (domain, name, factory) in factories {
			let authority = factory
				.bind(Arc::clone(&identity))
				.map_err(|error| error.in_domain(name))?;
			match domain {
				ControlDomain::Ui => ui_effect = Some(Arc::clone(&authority)),
				ControlDomain::Telemetry => telemetry_effect = Some(Arc::clone(&authority)),
				_ => {},
			}
			domains.push(Arc::new(RoutedControlAuthority { domain, authority }));
		}
		let effect_owner = self
			.envd
			.effects
			.bind(Arc::clone(&identity))
			.map_err(|error| error.in_domain("effects"))?;
		let effect_owner = Arc::new(DomainEffectAuthority {
			ui:        ui_effect.expect("UI domain was bound"),
			telemetry: telemetry_effect.expect("telemetry domain was bound"),
			fallback:  effect_owner,
		});
		let authority: Arc<dyn ControlAuthority> =
			Arc::new(CompositeControlAuthority::new(domains, effect_owner));
		Ok(if let Some(quota) = &self.quota {
			Arc::new(QuotaControlAuthority {
				inner: authority,
				owner: HostKey::new(
					identity.layer.clone(),
					identity.tier.clone(),
					identity.extension.clone(),
				),
				quota: quota.clone(),
			})
		} else {
			authority
		})
	}
}

struct QuotaControlAuthority {
	inner: Arc<dyn ControlAuthority>,
	owner: HostKey,
	quota: ControlQuotaRuntime,
}

impl QuotaControlAuthority {
	fn charge(
		&self,
		context: &ControlRequestContext,
		quota: &str,
	) -> Result<ChargeOutcome, ControlProtocolError> {
		let session = context
			.invocation
			.as_ref()
			.map(|authority| authority.session.as_str())
			.ok_or_else(|| {
				ControlProtocolError::new(
					"InvalidPhase",
					"quota-accounted CONTROL work requires live invocation authority",
				)
			})?;
		self
			.quota
			.charge(session, &self.owner, quota, 1)
			.map_err(quota_protocol_error)
	}
}

#[async_trait]
impl ControlAuthority for QuotaControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		self.inner.handles(operation)
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		operation: &str,
		arguments: &serde_json::Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		self.inner.authorize(context, operation, arguments)
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: serde_json::Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		if let Some(quota) = request_quota(operation.as_str())
			&& self.charge(&context, quota)? == ChargeOutcome::Dropped
		{
			return Ok(Value::Null);
		}
		self.inner.request(context, operation, arguments).await
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		let quota = match &effect {
			ControlEffect::Ui(_) => Some(names::UI_EFFECTS),
			ControlEffect::Instrument(_) => Some(names::TELEMETRY_CARDINALITY),
			ControlEffect::Intent(payload) => payload
				.get("operation")
				.and_then(Value::as_str)
				.and_then(request_quota),
			ControlEffect::Log(_) => None,
		};
		if let Some(quota) = quota
			&& self.charge(&context, quota)? == ChargeOutcome::Dropped
		{
			return Ok(());
		}
		self.inner.effect(context, effect).await
	}
}

fn quota_protocol_error(error: QuotaError) -> ControlProtocolError {
	match error {
		QuotaError::Exceeded(exceeded) => {
			ControlProtocolError::new("QuotaExceeded", "extension CONTROL resource quota was exceeded")
				.with_details(json!({
					"quota": exceeded.quota.as_str(),
					"scope": match exceeded.scope {
						super::quota::QuotaScope::Extension => "extension",
						super::quota::QuotaScope::Session => "session",
					},
					"receipt": resource_receipt_json(&exceeded.receipt),
				}))
		},
		_ => ControlProtocolError::new(
			"QuotaUnavailable",
			"extension CONTROL resource accounting is unavailable",
		),
	}
}

fn resource_receipt_json(receipt: &ResourceReceipt) -> Value {
	json!({
		"quotas": receipt.quotas.iter().map(|(name, status)| {
			(
				name.to_string(),
				json!({
					"limit": status.limit,
					"used": status.used,
					"window": status.window.map(|window| window.to_string()),
				}),
			)
		}).collect::<serde_json::Map<_, _>>(),
		"dropped": receipt.dropped.iter().map(|(name, count)| {
			(name.to_string(), Value::from(*count))
		}).collect::<serde_json::Map<_, _>>(),
	})
}

struct DomainEffectAuthority {
	ui:        Arc<dyn ControlAuthority>,
	telemetry: Arc<dyn ControlAuthority>,
	fallback:  Arc<dyn ControlAuthority>,
}

#[async_trait]
impl ControlAuthority for DomainEffectAuthority {
	fn handles(&self, _operation: &str) -> bool {
		false
	}

	fn authorize(
		&self,
		_context: &ControlRequestContext,
		_operation: &str,
		_arguments: &serde_json::Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		Err(ControlProtocolError::new(
			"InvalidOperation",
			"the CONTROL effect router accepts effects only",
		))
	}

	async fn request(
		&self,
		_context: ControlRequestContext,
		_operation: Str,
		_arguments: serde_json::Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		Err(ControlProtocolError::new(
			"InvalidOperation",
			"the CONTROL effect router accepts effects only",
		))
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		let owner = match &effect {
			ControlEffect::Ui(_) => &self.ui,
			ControlEffect::Instrument(_) => &self.telemetry,
			ControlEffect::Intent(_) => &self.fallback,
			ControlEffect::Log(_) => &self.fallback,
		};
		owner.effect(context, effect).await
	}
}

#[derive(Clone, Copy)]
enum ControlDomain {
	Devices,
	Hooks,
	Sessions,
	Artifacts,
	Credentials,
	Policy,
	Prompts,
	Ui,
	Telemetry,
	Jobs,
	Provider,
	Services,
	Auxiliary,
	Agents,
	Mcp,
}

impl ControlDomain {
	fn handles(self, operation: &str) -> bool {
		match self {
			Self::Devices => operation.starts_with("omp.devices."),
			Self::Hooks => operation.starts_with("omp.hooks."),
			Self::Sessions => operation.starts_with("omp.sessions."),
			Self::Artifacts => operation.starts_with("omp.artifacts."),
			Self::Credentials => {
				operation.starts_with("omp.creds.") || operation.starts_with("omp.secrets.")
			},
			Self::Policy => operation.starts_with("omp.policy."),
			Self::Prompts => operation.starts_with("omp.prompts."),
			Self::Ui => operation.starts_with("omp.ui."),
			Self::Telemetry => operation.starts_with("omp.telemetry."),
			Self::Jobs => operation == "omp.jobs.register",
			Self::Provider => {
				operation.starts_with("omp.provider.") || operation.starts_with("omp.intents.")
			},
			Self::Services => operation.starts_with("omp.services."),
			Self::Auxiliary => {
				operation.starts_with("omp.params.")
					|| operation.starts_with("omp.urls.")
					|| operation == "omp.state_dir"
					|| operation == "omp.direct_filesystem.request"
					|| operation.starts_with("omp.workers.")
					|| operation.starts_with("omp.direct_filesystem.")
					|| operation.starts_with("omp.convars.")
			},
			Self::Agents => operation.starts_with("omp.agents."),
			Self::Mcp => operation.starts_with("omp.mcp."),
		}
	}
}

struct RoutedControlAuthority {
	domain:    ControlDomain,
	authority: Arc<dyn ControlAuthority>,
}

#[async_trait]
impl ControlAuthority for RoutedControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		self.domain.handles(operation) && self.authority.handles(operation)
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		operation: &str,
		arguments: &serde_json::Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		self.authority.authorize(context, operation, arguments)
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: serde_json::Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		self.authority.request(context, operation, arguments).await
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		self.authority.effect(context, effect).await
	}
}

/// Disjoint composition of domain authorities with one observation sink.
///
/// Construction rejects no routes eagerly because some authorities resolve
/// dynamic exact operations. Every request still requires exactly one owner;
/// zero and ambiguous matches are typed protocol failures.
pub struct CompositeControlAuthority {
	domains:      Box<[Arc<dyn ControlAuthority>]>,
	effect_owner: Arc<dyn ControlAuthority>,
}

impl CompositeControlAuthority {
	/// Composes independently owned CONTROL namespaces.
	pub fn new(
		domains: impl IntoIterator<Item = Arc<dyn ControlAuthority>>,
		effect_owner: Arc<dyn ControlAuthority>,
	) -> Self {
		Self { domains: domains.into_iter().collect(), effect_owner }
	}

	fn owner(&self, operation: &str) -> Result<&Arc<dyn ControlAuthority>, ControlProtocolError> {
		let mut owners = self
			.domains
			.iter()
			.filter(|domain| domain.handles(operation));
		let owner = owners.next().ok_or_else(|| {
			ControlProtocolError::new(
				"unhandled_operation",
				format!("unhandled CONTROL operation: {operation}"),
			)
		})?;
		if owners.next().is_some() {
			return Err(ControlProtocolError::new(
				"ambiguous_operation",
				format!("multiple CONTROL authorities own {operation}"),
			));
		}
		Ok(owner)
	}
}

#[async_trait]
impl ControlAuthority for CompositeControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		self.domains.iter().any(|domain| domain.handles(operation))
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		operation: &str,
		arguments: &serde_json::Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		self
			.owner(operation)?
			.authorize(context, operation, arguments)
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: serde_json::Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		self
			.owner(operation.as_str())?
			.request(context, operation, arguments)
			.await
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		if let ControlEffect::Intent(payload) = &effect {
			let object = payload
				.as_object()
				.ok_or_else(|| ControlProtocolError::malformed("intent effect is not an object"))?;
			let operation = object
				.get("operation")
				.and_then(Value::as_str)
				.ok_or_else(|| ControlProtocolError::malformed("intent effect operation is missing"))?;
			if !matches!(operation, "omp.intents.set" | "omp.intents.clear") {
				return Err(ControlProtocolError::new(
					"invalid_operation",
					format!("unsupported intent effect operation: {operation}"),
				));
			}
			let arguments = object
				.get("arguments")
				.and_then(Value::as_object)
				.ok_or_else(|| {
					ControlProtocolError::malformed("intent effect arguments are not an object")
				})?;
			let owner = self.owner(operation)?;
			owner.authorize(&context, operation, arguments)?;
			return owner.effect(context, effect).await;
		}
		self.effect_owner.effect(context, effect).await
	}
}

#[derive(Debug, Deserialize, Serialize)]
struct JsonControlFrame {
	kind:        String,
	#[serde(skip_serializing_if = "Option::is_none")]
	correlation: Option<u64>,
	#[serde(default)]
	body:        serde_json::Map<String, Value>,
}

struct DispatchProgressState {
	invocation: Str,
	sender:     Option<flume::Sender<Value>>,
	events:     usize,
	bytes:      usize,
}

struct DispatchChunkState {
	invocation: Str,
	next_index: u64,
	body:       Vec<u8>,
}

fn dispatch_frame_invocation_for_identity<'a>(
	identity: &ControlConnectionIdentity,
	authority: &'a serde_json::Map<String, Value>,
) -> Result<&'a str, ControlProtocolError> {
	let host_generation = wire_u64(authority, "host_generation")?;
	if host_generation != identity.host_generation {
		return Err(ControlProtocolError::stale_generation(
			identity.host_generation,
			host_generation,
			"host_generation",
		));
	}
	let session_generation = wire_u64(authority, "session_generation")?;
	if session_generation != identity.session_generation {
		return Err(ControlProtocolError::stale_generation(
			identity.session_generation,
			session_generation,
			"session_generation",
		));
	}
	authority
		.get("invocation")
		.and_then(Value::as_str)
		.filter(|invocation| !invocation.is_empty())
		.ok_or_else(|| ControlProtocolError::malformed("dispatch frame invocation is missing"))
}

fn checked_progress_bytes(
	state: &DispatchProgressState,
	encoded: usize,
) -> Result<usize, ControlProtocolError> {
	if state.events >= MAX_DISPATCH_PROGRESS_EVENTS {
		return Err(ControlProtocolError::new(
			"progress_overflow",
			format!("dispatch progress exceeds {MAX_DISPATCH_PROGRESS_EVENTS} events"),
		));
	}
	let bytes = state.bytes.checked_add(encoded).ok_or_else(|| {
		ControlProtocolError::new("progress_overflow", "dispatch progress byte count overflow")
	})?;
	if bytes > MAX_DISPATCH_PROGRESS_BYTES {
		return Err(ControlProtocolError::new(
			"progress_overflow",
			format!("dispatch progress exceeds {MAX_DISPATCH_PROGRESS_BYTES} bytes"),
		));
	}
	Ok(bytes)
}

fn append_dispatch_result_chunk(
	state: &mut DispatchChunkState,
	invocation: &Str,
	index: u64,
	data: &[u8],
) -> Result<(), ControlProtocolError> {
	if state.invocation.as_str() != invocation.as_str() || state.next_index != index {
		return Err(ControlProtocolError::new(
			"result_chunk_order",
			format!(
				"dispatch result chunk index {index} does not follow {}",
				state.next_index
			),
		));
	}
	let length = state.body.len().checked_add(data.len()).ok_or_else(|| {
		ControlProtocolError::new("result_too_large", "dispatch result length overflow")
	})?;
	if length > MAX_DISPATCH_RESULT_BYTES {
		return Err(ControlProtocolError::new(
			"result_too_large",
			format!("dispatch result exceeds {MAX_DISPATCH_RESULT_BYTES} bytes"),
		));
	}
	state.body.extend_from_slice(data);
	state.next_index += 1;
	Ok(())
}

struct ControlShared {
	writer:            AsyncMutex<OwnedWriteHalf>,
	identity:          Arc<ControlConnectionIdentity>,
	authority:         Arc<dyn ControlAuthority>,
	router:            Mutex<DispatchRouter>,
	invocations:       Mutex<BTreeMap<Str, ControlInvocationAuthority>>,
	dispatch_by_id:    Mutex<BTreeMap<u64, Str>>,
	dispatch_progress: Mutex<BTreeMap<u64, DispatchProgressState>>,
	dispatch_chunks:   Mutex<BTreeMap<u64, DispatchChunkState>>,
	child_requests:    Mutex<BTreeMap<u64, AbortHandle>>,
	next_dispatch_id:  AtomicU64,
}

/// Parent-side pump for the dedicated, multiplexed CONTROL descriptor.
pub struct ControlRuntime {
	reader: OwnedReadHalf,
	shared: Arc<ControlShared>,
}

/// Cloneable host-to-child dispatch and cancellation handle.
#[derive(Clone)]
pub struct ControlHandle {
	shared: Arc<ControlShared>,
}
struct LiveDispatchGuard {
	shared:     Arc<ControlShared>,
	id:         u64,
	invocation: Str,
	armed:      bool,
}

impl LiveDispatchGuard {
	fn disarm(&mut self) {
		self.armed = false;
	}
}

impl Drop for LiveDispatchGuard {
	fn drop(&mut self) {
		if !self.armed {
			return;
		}
		let queued = self
			.shared
			.router
			.lock()
			.cancel_queued(self.shared.identity.extension.as_str(), self.id)
			.unwrap_or(false);
		if queued {
			self.shared.invocations.lock().remove(&self.invocation);
			self.shared.dispatch_by_id.lock().remove(&self.id);
			self.shared.dispatch_progress.lock().remove(&self.id);
			self.shared.dispatch_chunks.lock().remove(&self.id);
			return;
		}
		if let Ok(runtime) = runtime::Handle::try_current() {
			let shared = Arc::clone(&self.shared);
			let invocation = self.invocation.clone();
			runtime.spawn(async move {
				let _ = write_cancel_dispatch(&shared, invocation.as_str()).await;
			});
		}
	}
}

/// Exact logical call identity used by the synchronous tier snapshot.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ControlTierTarget {
	/// Built-in harness tool revision.
	Core {
		/// Tool name.
		name: Str,
		/// Tool dialect revision.
		rev:  Str,
	},
	/// Resolved extension or mounted device revision.
	Device {
		/// Device name.
		name:   Str,
		/// Compatibility family.
		family: Str,
		/// Device revision.
		rev:    Str,
	},
	/// Tool on one mounted MCP server.
	Mcp {
		/// Server declaration name.
		server: Str,
		/// Server tool name.
		tool:   Str,
	},
}

/// Generation-fenced synchronous authority facts installed before callbacks.
#[derive(Clone, Debug, Default)]
pub struct ControlAuthoritySnapshot {
	/// Exact logical-call tier projection owned by Core policy.
	pub tiers:           BTreeMap<ControlTierTarget, Str>,
	/// Immutable current-session row exposed by the synchronous sessions API.
	pub current_session: Option<Value>,
	/// Authenticated depth of this child in the agent tree.
	pub agent_depth:     u32,
}

/// One typed callback invocation sent from Core to Python.
#[derive(Clone, Debug)]
pub struct ControlDispatch {
	/// Exact documented callback operation.
	pub operation: Str,
	/// JSON-serializable callback arguments.
	pub arguments: serde_json::Map<String, Value>,
	/// Host-issued invocation authority.
	pub authority: ControlInvocationAuthority,
	/// Declaration-level callback overlap policy.
	pub policy:    CallbackConcurrency,
	/// Host-owned callback deadline.
	pub deadline:  EventDeadline,
}

/// CONTROL transport or host-to-child callback failure.
#[derive(Debug, Error)]
pub enum ControlRuntimeError {
	/// The dedicated descriptor failed.
	#[error("CONTROL transport failed: {0}")]
	Io(#[from] io::Error),
	/// A frame was not valid JSON.
	#[error("CONTROL JSON frame failed: {0}")]
	Json(#[from] serde_json::Error),
	/// A child violated the typed protocol.
	#[error(transparent)]
	Protocol(#[from] ControlProtocolError),
	/// Host callback correlation failed.
	#[error(transparent)]
	Dispatch(#[from] DispatchError),
	/// Python returned a typed callback failure.
	#[error("Python callback failed: {0}")]
	Remote(ControlProtocolError),
}

impl ControlRuntime {
	/// Binds one authenticated child descriptor and returns its dispatch handle.
	pub fn new(
		stream: UnixStream,
		host: HostKey,
		identity: ControlConnectionIdentity,
		authority: Arc<dyn ControlAuthority>,
	) -> (Self, ControlHandle) {
		let generation = identity.host_generation;
		let (reader, writer) = stream.into_split();
		let shared = Arc::new(ControlShared {
			writer: AsyncMutex::new(writer),
			identity: Arc::new(identity),
			authority,
			router: Mutex::new(DispatchRouter::new(host, generation)),
			invocations: Mutex::new(BTreeMap::new()),
			dispatch_by_id: Mutex::new(BTreeMap::new()),
			dispatch_progress: Mutex::new(BTreeMap::new()),
			dispatch_chunks: Mutex::new(BTreeMap::new()),
			child_requests: Mutex::new(BTreeMap::new()),
			next_dispatch_id: AtomicU64::new(1),
		});
		(Self { reader, shared: Arc::clone(&shared) }, ControlHandle { shared })
	}

	/// Runs the sole reader until EOF or a connection-level protocol failure.
	pub async fn serve(mut self) -> Result<(), ControlRuntimeError> {
		loop {
			let Some(frame) = read_json_control_frame(&mut self.reader).await? else {
				self.shared.router.lock().disconnect();
				self.shared.invocations.lock().clear();
				self.shared.dispatch_by_id.lock().clear();
				self.shared.dispatch_progress.lock().clear();
				self.shared.dispatch_chunks.lock().clear();
				for (_, request) in mem::take(&mut *self.shared.child_requests.lock()) {
					request.abort();
				}
				return Ok(());
			};
			match frame.kind.as_str() {
				"Request" => self.accept_request(frame).await?,
				"CancelRequest" => self.accept_request_cancel(frame)?,
				"DispatchProgress" => self.accept_dispatch_progress(frame)?,
				"DispatchResultChunk" => self.accept_dispatch_result_chunk(frame)?,
				"DispatchResponse" => self.accept_dispatch_response(frame).await?,
				"IntentEffect" => {
					if let Err(error) = self.accept_effect(frame, ControlEffectKind::Intent).await {
						tracing::warn!(%error, "extension intent effect was rejected");
					}
				},
				"UiEffect" => self.accept_effect(frame, ControlEffectKind::Ui).await?,
				"Log" => self.accept_effect(frame, ControlEffectKind::Log).await?,
				"Instrument" => {
					self
						.accept_effect(frame, ControlEffectKind::Instrument)
						.await?
				},
				kind => {
					if let Some(correlation) = frame.correlation {
						let error = ControlProtocolError::new(
							"unsupported_frame",
							format!("unsupported CONTROL frame kind: {kind}"),
						);
						write_json_control_frame(&self.shared, JsonControlFrame {
							kind:        String::from("Response"),
							correlation: Some(correlation),
							body:        response_error(&error),
						})
						.await?;
					} else {
						return Err(
							ControlProtocolError::new(
								"unsupported_frame",
								format!("unsupported uncorrelated CONTROL frame: {kind}"),
							)
							.into(),
						);
					}
				},
			}
		}
	}

	async fn accept_request(&self, frame: JsonControlFrame) -> Result<(), ControlRuntimeError> {
		let Some(correlation) = frame.correlation.filter(|id| *id != 0) else {
			return Err(ControlProtocolError::malformed("CONTROL request has no correlation").into());
		};
		let shared = Arc::clone(&self.shared);
		let task = tokio::spawn(async move {
			let body = match serve_child_request(&shared, correlation, frame.body).await {
				Ok(result) => {
					let mut body = serde_json::Map::new();
					body.insert(String::from("result"), result);
					body
				},
				Err(error) => response_error(&error),
			};
			let _ = write_json_control_frame(&shared, JsonControlFrame {
				kind: String::from("Response"),
				correlation: Some(correlation),
				body,
			})
			.await;
			shared.child_requests.lock().remove(&correlation);
		});
		self
			.shared
			.child_requests
			.lock()
			.insert(correlation, task.abort_handle());
		Ok(())
	}

	fn accept_request_cancel(&self, frame: JsonControlFrame) -> Result<(), ControlRuntimeError> {
		let Some(correlation) = frame.correlation.filter(|id| *id != 0) else {
			return Err(
				ControlProtocolError::malformed("request cancellation has no correlation").into(),
			);
		};
		// The abort drops the authoritative service future and therefore its
		// resource-owned cancellation guard. There is deliberately no response:
		// the cancelling Python task has already retired this correlation.
		if let Some(request) = self.shared.child_requests.lock().remove(&correlation) {
			request.abort();
		}
		// Cancellation racing a just-settled response is an idempotent terminal
		// transition, not a stale-frame protocol violation.
		Ok(())
	}

	async fn accept_effect(
		&self,
		frame: JsonControlFrame,
		kind: ControlEffectKind,
	) -> Result<(), ControlRuntimeError> {
		if frame.correlation.is_some() {
			return Err(ControlProtocolError::malformed("effect frame must be uncorrelated").into());
		}
		let context = authenticated_context(&self.shared, 0, &frame.body)?;
		let field = kind.field();
		let payload =
			frame.body.get(field).cloned().ok_or_else(|| {
				ControlProtocolError::malformed(format!("{field} payload is missing"))
			})?;
		let effect = match kind {
			ControlEffectKind::Intent => ControlEffect::Intent(payload),
			ControlEffectKind::Ui => ControlEffect::Ui(payload),
			ControlEffectKind::Log => ControlEffect::Log(payload),
			ControlEffectKind::Instrument => ControlEffect::Instrument(payload),
		};
		self.shared.authority.effect(context, effect).await?;
		Ok(())
	}

	fn dispatch_frame_invocation(
		&self,
		correlation: u64,
		body: &serde_json::Map<String, Value>,
	) -> Result<Str, ControlProtocolError> {
		let authority = body
			.get("authority")
			.and_then(Value::as_object)
			.ok_or_else(|| ControlProtocolError::malformed("dispatch frame authority is missing"))?;
		let invocation =
			dispatch_frame_invocation_for_identity(&self.shared.identity, authority)?;
		let expected = self
			.shared
			.dispatch_by_id
			.lock()
			.get(&correlation)
			.cloned()
			.ok_or_else(|| {
				ControlProtocolError::new(
					"stale_correlation",
					format!("unknown dispatch frame correlation {correlation}"),
				)
			})?;
		if invocation != expected.as_str() {
			return Err(ControlProtocolError::new(
				"stale_invocation",
				format!(
					"dispatch frame invocation {invocation} does not own correlation {correlation}"
				),
			));
		}
		Ok(expected)
	}

	fn accept_dispatch_progress(&self, mut frame: JsonControlFrame) -> Result<(), ControlRuntimeError> {
		let Some(correlation) = frame.correlation.filter(|id| *id != 0) else {
			return Err(
				ControlProtocolError::malformed("dispatch progress has no correlation").into(),
			);
		};
		let encoded = serde_json::to_vec(&frame.body)?;
		if encoded.len() > MAX_DISPATCH_PROGRESS_FRAME_BYTES {
			return Err(
				ControlProtocolError::new(
					"progress_too_large",
					format!(
						"dispatch progress is {} bytes; limit is {MAX_DISPATCH_PROGRESS_FRAME_BYTES}",
						encoded.len()
					),
				)
				.into(),
			);
		}
		let invocation = self.dispatch_frame_invocation(correlation, &frame.body)?;
		let update = frame
			.body
			.remove("update")
			.ok_or_else(|| ControlProtocolError::malformed("dispatch progress update is missing"))?;
		if frame.body.len() != 1 || !frame.body.contains_key("authority") {
			return Err(
				ControlProtocolError::malformed("dispatch progress has unexpected fields").into(),
			);
		}
		let mut progress = self.shared.dispatch_progress.lock();
		let state = progress.get_mut(&correlation).ok_or_else(|| {
			ControlProtocolError::new(
				"progress_unhandled",
				format!("dispatch {correlation} has no progress owner"),
			)
		})?;
		if state.invocation != invocation {
			return Err(ControlProtocolError::new(
				"stale_invocation",
				"dispatch progress state belongs to another invocation",
			)
			.into());
		}
		let bytes = checked_progress_bytes(state, encoded.len())?;
		let sender = state.sender.as_ref().ok_or_else(|| {
			ControlProtocolError::new(
				"progress_unhandled",
				format!("dispatch {correlation} did not install a progress sink"),
			)
		})?;
		sender.try_send(update).map_err(|error| {
			ControlProtocolError::new(
				"progress_overflow",
				format!("dispatch progress owner rejected an update: {error}"),
			)
		})?;
		state.events += 1;
		state.bytes = bytes;
		Ok(())
	}

	fn accept_dispatch_result_chunk(
		&self,
		mut frame: JsonControlFrame,
	) -> Result<(), ControlRuntimeError> {
		let Some(correlation) = frame.correlation.filter(|id| *id != 0) else {
			return Err(
				ControlProtocolError::malformed("dispatch result chunk has no correlation").into(),
			);
		};
		let invocation = self.dispatch_frame_invocation(correlation, &frame.body)?;
		let index = frame
			.body
			.remove("index")
			.and_then(|value| value.as_u64())
			.ok_or_else(|| ControlProtocolError::malformed("dispatch chunk index is missing"))?;
		let encoded = frame
			.body
			.remove("data")
			.and_then(|value| value.as_object().cloned())
			.and_then(|mut value| {
				(value.len() == 1)
					.then(|| value.remove("$bytes"))
					.flatten()
					.and_then(|value| value.as_str().map(ToOwned::to_owned))
			})
			.ok_or_else(|| ControlProtocolError::malformed("dispatch chunk data is malformed"))?;
		if frame.body.len() != 1 || !frame.body.contains_key("authority") {
			return Err(
				ControlProtocolError::malformed("dispatch chunk has unexpected fields").into(),
			);
		}
		let maximum_encoded = MAX_DISPATCH_RESULT_CHUNK_BYTES
			.saturating_add(2)
			.saturating_div(3)
			.saturating_mul(4);
		if encoded.len() > maximum_encoded {
			return Err(
				ControlProtocolError::new(
					"result_chunk_too_large",
					"dispatch result chunk encoding exceeds its bound",
				)
				.into(),
			);
		}
		let data = omp_core::base64::decode(encoded.as_bytes())
			.into_vec()
			.map_err(|_| ControlProtocolError::malformed("dispatch chunk base64 is invalid"))?;
		if data.len() > MAX_DISPATCH_RESULT_CHUNK_BYTES {
			return Err(
				ControlProtocolError::new(
					"result_chunk_too_large",
					format!(
						"dispatch result chunk is {} bytes; limit is \
						 {MAX_DISPATCH_RESULT_CHUNK_BYTES}",
						data.len()
					),
				)
				.into(),
			);
		}
		let mut chunks = self.shared.dispatch_chunks.lock();
		let state = chunks.entry(correlation).or_insert_with(|| DispatchChunkState {
			invocation: invocation.clone(),
			next_index: 0,
			body: Vec::new(),
		});
		append_dispatch_result_chunk(state, &invocation, index, &data)?;
		Ok(())
	}

	async fn accept_dispatch_response(
		&self,
		mut frame: JsonControlFrame,
	) -> Result<(), ControlRuntimeError> {
		let Some(correlation) = frame.correlation.filter(|id| *id != 0) else {
			return Err(
				ControlProtocolError::malformed("dispatch response has no correlation").into(),
			);
		};
		let invocation = self
			.shared
			.dispatch_by_id
			.lock()
			.remove(&correlation)
			.ok_or_else(|| {
				ControlProtocolError::new(
					"stale_correlation",
					format!("unknown dispatch response correlation {correlation}"),
				)
			})?;
		let body = if let Some(chunked) = frame.body.remove("chunked") {
			if !frame.body.is_empty() {
				return Err(
					ControlProtocolError::malformed(
						"chunked dispatch response has unexpected fields",
					)
					.into(),
				);
			}
			let chunked = chunked.as_object().ok_or_else(|| {
				ControlProtocolError::malformed("chunked dispatch response metadata is malformed")
			})?;
			let expected_chunks = wire_u64(chunked, "chunks")?;
			let expected_bytes = wire_u64(chunked, "bytes")?;
			let state = self
				.shared
				.dispatch_chunks
				.lock()
				.remove(&correlation)
				.ok_or_else(|| {
					ControlProtocolError::malformed("chunked dispatch response has no chunks")
				})?;
			if state.invocation != invocation
				|| state.next_index != expected_chunks
				|| u64::try_from(state.body.len()).ok() != Some(expected_bytes)
			{
				return Err(
					ControlProtocolError::new(
						"result_chunk_mismatch",
						"chunked dispatch response metadata does not match received bytes",
					)
					.into(),
				);
			}
			serde_json::from_slice::<serde_json::Map<String, Value>>(&state.body)?
		} else {
			if self.shared.dispatch_chunks.lock().remove(&correlation).is_some() {
				return Err(
					ControlProtocolError::new(
						"result_chunk_incomplete",
						"dispatch response omitted chunk completion metadata",
					)
					.into(),
				);
			}
			frame.body
		};
		self.shared.dispatch_progress.lock().remove(&correlation);
		let payload = serde_json::to_vec(&Value::Object(body))?;
		let extension = self.shared.identity.extension.clone();
		let next = self.shared.router.lock().complete(
			extension.as_str(),
			correlation,
			self.shared.identity.host_generation,
			Ok(omp_core::CowBytes::from(payload)),
		)?;
		self.shared.invocations.lock().remove(&invocation);
		if let Some(next) = next {
			write_dispatch_request(&self.shared, next).await?;
		}
		// Keep authority until the waiting caller observes and decodes the reply.
		let _ = invocation;
		Ok(())
	}
}

#[derive(Clone, Copy)]
enum ControlEffectKind {
	Intent,
	Ui,
	Log,
	Instrument,
}

impl ControlEffectKind {
	const fn field(self) -> &'static str {
		match self {
			Self::Intent => "effect",
			Self::Ui => "effect",
			Self::Log => "log",
			Self::Instrument => "event",
		}
	}
}

impl ControlHandle {
	/// Installs a Core-issued synchronous authority snapshot in the child.
	///
	/// The child rejects any snapshot whose host or session generation differs
	/// from the descriptor's authenticated connection identity.
	pub async fn install_authority_snapshot(
		&self,
		snapshot: &ControlAuthoritySnapshot,
	) -> Result<(), ControlRuntimeError> {
		let mut body = serde_json::Map::new();
		body.insert(
			String::from("host_generation"),
			Value::from(self.shared.identity.host_generation),
		);
		body.insert(
			String::from("session_generation"),
			Value::from(self.shared.identity.session_generation),
		);
		body.insert(String::from("agent_depth"), Value::from(snapshot.agent_depth));
		body.insert(
			String::from("current_session"),
			snapshot.current_session.clone().unwrap_or(Value::Null),
		);
		body.insert(
			String::from("tiers"),
			Value::Array(
				snapshot
					.tiers
					.iter()
					.map(|(target, tier)| match target {
						ControlTierTarget::Core { name, rev } => json!({
							"kind": "core",
							"name": name.as_str(),
							"rev": rev.as_str(),
							"tier": tier.as_str(),
						}),
						ControlTierTarget::Device { name, family, rev } => json!({
							"kind": "device",
							"name": name.as_str(),
							"family": family.as_str(),
							"rev": rev.as_str(),
							"tier": tier.as_str(),
						}),
						ControlTierTarget::Mcp { server, tool } => json!({
							"kind": "mcp",
							"server": server.as_str(),
							"tool": tool.as_str(),
							"tier": tier.as_str(),
						}),
					})
					.collect(),
			),
		);
		write_json_control_frame(&self.shared, JsonControlFrame {
			kind: String::from("AuthoritySnapshot"),
			correlation: None,
			body,
		})
		.await
	}

	/// Pushes the current daemon-owned quota receipt into the child cache.
	pub async fn install_resource_receipt(
		&self,
		receipt: &ResourceReceipt,
	) -> Result<(), ControlRuntimeError> {
		let mut body = serde_json::Map::new();
		body.insert(
			String::from("host_generation"),
			Value::from(self.shared.identity.host_generation),
		);
		body.insert(
			String::from("session_generation"),
			Value::from(self.shared.identity.session_generation),
		);
		body.insert(String::from("receipt"), resource_receipt_json(receipt));
		write_json_control_frame(&self.shared, JsonControlFrame {
			kind: String::from("ResourceReceipt"),
			correlation: None,
			body,
		})
		.await
	}

	/// Dispatches one callback and waits for its exactly correlated Python
	/// reply.
	pub async fn dispatch(&self, dispatch: ControlDispatch) -> Result<Value, ControlRuntimeError> {
		self.dispatch_inner(dispatch, None).await
	}

	/// Dispatches one callback while forwarding bounded correlated progress to
	/// the invocation owner before returning its terminal reply.
	pub async fn dispatch_with_progress(
		&self,
		dispatch: ControlDispatch,
		progress: flume::Sender<Value>,
	) -> Result<Value, ControlRuntimeError> {
		self.dispatch_inner(dispatch, Some(progress)).await
	}

	async fn dispatch_inner(
		&self,
		dispatch: ControlDispatch,
		progress: Option<flume::Sender<Value>>,
	) -> Result<Value, ControlRuntimeError> {
		if !dispatch.operation.as_str().starts_with("omp.") {
			return Err(
				ControlProtocolError::new(
					"invalid_operation",
					"host dispatch operation must start with omp.",
				)
				.into(),
			);
		}
		let id = self.shared.next_dispatch_id.fetch_add(1, Ordering::Relaxed);
		if id == 0 {
			return Err(
				ControlProtocolError::new(
					"correlation_exhausted",
					"CONTROL dispatch correlation space exhausted",
				)
				.into(),
			);
		}
		let invocation = dispatch.authority.invocation.clone();
		{
			let mut invocations = self.shared.invocations.lock();
			if invocations.contains_key(&invocation) {
				return Err(
					ControlProtocolError::new(
						"duplicate_dispatch",
						format!("invocation is already live: {}", invocation.as_str()),
					)
					.into(),
				);
			}
			invocations.insert(invocation.clone(), dispatch.authority.clone());
		}
		let body = dispatch_body(
			&self.shared.identity,
			dispatch.operation,
			dispatch.arguments,
			&dispatch.authority,
		);
		let request = DispatchRequest {
			id,
			policy: dispatch.policy,
			deadline: dispatch.deadline,
			payload: omp_core::CowBytes::from(serde_json::to_vec(&body)?),
		};
		let routed = self
			.shared
			.router
			.lock()
			.dispatch(self.shared.identity.extension.clone(), request);
		let (ready, pending) = match routed {
			Ok(value) => value,
			Err(error) => {
				self.shared.invocations.lock().remove(&invocation);
				return Err(error.into());
			},
		};
		self
			.shared
			.dispatch_by_id
			.lock()
			.insert(id, invocation.clone());
		self.shared.dispatch_progress.lock().insert(id, DispatchProgressState {
			invocation: invocation.clone(),
			sender: progress,
			events: 0,
			bytes: 0,
		});
		let mut guard = LiveDispatchGuard {
			shared: Arc::clone(&self.shared),
			id,
			invocation: invocation.clone(),
			armed: true,
		};
		if let Some(ready) = ready {
			if let Err(error) = write_dispatch_request(&self.shared, ready).await {
				self.shared.invocations.lock().remove(&invocation);
				self.shared.dispatch_by_id.lock().remove(&id);
				self.shared.dispatch_progress.lock().remove(&id);
				self.shared.dispatch_chunks.lock().remove(&id);
				guard.disarm();
				let _ = self.shared.router.lock().complete(
					self.shared.identity.extension.as_str(),
					id,
					self.shared.identity.host_generation,
					Err(DispatchError::HostGone),
				);
				return Err(error);
			}
		}
		let response = pending.response().await;
		guard.disarm();
		let payload = match response {
			Ok(payload) => payload,
			Err(error) => {
				self.shared.invocations.lock().remove(&invocation);
				self.shared.dispatch_by_id.lock().remove(&id);
				self.shared.dispatch_progress.lock().remove(&id);
				self.shared.dispatch_chunks.lock().remove(&id);
				return Err(error.into());
			},
		};
		let body: Value = serde_json::from_slice(payload.as_ref())?;
		let object = body
			.as_object()
			.ok_or_else(|| ControlProtocolError::malformed("dispatch response is not an object"))?;
		if let Some(error) = object.get("error") {
			return Err(ControlRuntimeError::Remote(protocol_error_from_wire(error)?));
		}
		object
			.get("result")
			.cloned()
			.ok_or_else(|| ControlProtocolError::malformed("dispatch response has no result").into())
	}

	/// Sends stage one of the documented cancellation ladder.
	pub async fn cancel(&self, invocation: &str) -> Result<(), ControlRuntimeError> {
		if !self.shared.invocations.lock().contains_key(invocation) {
			return Err(
				ControlProtocolError::new(
					"stale_invocation",
					format!("cannot cancel unknown invocation {invocation}"),
				)
				.into(),
			);
		}
		write_cancel_dispatch(&self.shared, invocation).await
	}

	/// Returns whether a callback still owns live child authority.
	pub fn is_live(&self, invocation: &str) -> bool {
		self.shared.invocations.lock().contains_key(invocation)
	}

	/// Returns the live frame correlation for cancellation journaling.
	pub fn last_frame(&self, invocation: &str) -> Option<u64> {
		self
			.shared
			.dispatch_by_id
			.lock()
			.iter()
			.find_map(|(id, live)| (live.as_str() == invocation).then_some(*id))
	}
}

async fn serve_child_request(
	shared: &Arc<ControlShared>,
	request_id: u64,
	mut body: serde_json::Map<String, Value>,
) -> Result<Value, ControlProtocolError> {
	let operation = body
		.remove("operation")
		.and_then(|value| value.as_str().map(ToOwned::to_owned))
		.ok_or_else(|| ControlProtocolError::malformed("CONTROL request operation is missing"))?;
	if !operation.starts_with("omp.") {
		return Err(ControlProtocolError::new(
			"invalid_operation",
			"CONTROL operation must start with omp.",
		));
	}
	let arguments = body
		.remove("arguments")
		.and_then(|value| value.as_object().cloned())
		.ok_or_else(|| {
			ControlProtocolError::malformed("CONTROL request arguments are not an object")
		})?;
	let context = authenticated_context(shared, request_id, &body)?;
	if !shared.authority.handles(&operation) {
		return Err(ControlProtocolError::new(
			"unhandled_operation",
			format!("unhandled CONTROL operation: {operation}"),
		));
	}
	shared
		.authority
		.authorize(&context, &operation, &arguments)?;
	shared
		.authority
		.request(context, Str::from(operation), arguments)
		.await
}

fn authenticated_context(
	shared: &Arc<ControlShared>,
	request_id: u64,
	body: &serde_json::Map<String, Value>,
) -> Result<ControlRequestContext, ControlProtocolError> {
	let authority = body
		.get("authority")
		.and_then(Value::as_object)
		.ok_or_else(|| ControlProtocolError::malformed("CONTROL authority is missing"))?;
	let host_generation = wire_u64(authority, "host_generation")?;
	if host_generation != shared.identity.host_generation {
		return Err(ControlProtocolError::stale_generation(
			shared.identity.host_generation,
			host_generation,
			"host_generation",
		));
	}
	let session_generation = wire_u64(authority, "session_generation")?;
	if session_generation != shared.identity.session_generation {
		return Err(ControlProtocolError::stale_generation(
			shared.identity.session_generation,
			session_generation,
			"session_generation",
		));
	}
	let invocation = match authority.get("invocation") {
		Some(Value::String(invocation)) => Some(
			shared
				.invocations
				.lock()
				.get(invocation.as_str())
				.cloned()
				.ok_or_else(|| {
					ControlProtocolError::new(
						"stale_invocation",
						format!("unknown invocation authority {invocation}"),
					)
				})?,
		),
		Some(Value::Null) | None => None,
		_ => {
			return Err(ControlProtocolError::malformed(
				"CONTROL invocation authority is not a string",
			));
		},
	};
	Ok(ControlRequestContext { connection: Arc::clone(&shared.identity), request_id, invocation })
}

fn wire_u64(
	object: &serde_json::Map<String, Value>,
	field: &'static str,
) -> Result<u64, ControlProtocolError> {
	object
		.get(field)
		.and_then(Value::as_u64)
		.ok_or_else(|| ControlProtocolError::malformed(format!("{field} is not an unsigned integer")))
}

fn response_error(error: &ControlProtocolError) -> serde_json::Map<String, Value> {
	let mut body = serde_json::Map::new();
	body.insert(String::from("error"), error.wire());
	body
}

fn protocol_error_from_wire(value: &Value) -> Result<ControlProtocolError, ControlProtocolError> {
	let object = value
		.as_object()
		.ok_or_else(|| ControlProtocolError::malformed("protocol error is not an object"))?;
	let code = object
		.get("code")
		.and_then(Value::as_str)
		.ok_or_else(|| ControlProtocolError::malformed("protocol error code is missing"))?;
	let message = object
		.get("message")
		.and_then(Value::as_str)
		.ok_or_else(|| ControlProtocolError::malformed("protocol error message is missing"))?;
	Ok(ControlProtocolError {
		code:      Str::from(code),
		message:   Str::from(message),
		retryable: object
			.get("retryable")
			.and_then(Value::as_bool)
			.unwrap_or(false),
		details:   object.get("details").cloned().unwrap_or(Value::Null),
	})
}

fn dispatch_body(
	identity: &ControlConnectionIdentity,
	operation: Str,
	arguments: serde_json::Map<String, Value>,
	authority: &ControlInvocationAuthority,
) -> serde_json::Map<String, Value> {
	let phase: &str = authority.phase.into();
	let lifecycle: &str = authority.lifecycle.into();
	let mut body = serde_json::Map::new();
	body.insert(String::from("operation"), Value::String(operation.to_string()));
	body.insert(String::from("arguments"), Value::Object(arguments));
	body.insert(
		String::from("authority"),
		json!({
			"invocation": authority.invocation.as_str(),
			"host_generation": identity.host_generation,
			"session_generation": identity.session_generation,
			"principal": {
				"id": identity.principal.id(),
				"display": identity.principal.display(),
			},
			"extension": identity.extension.as_str(),
			"artifact_digest": identity.artifact_digest.as_str(),
			"layer": identity.layer.as_str(),
			"tier": identity.tier.as_str(),
			"trust": identity.trust.as_str(),
			"capabilities": identity.capabilities.iter().map(Str::as_str).collect::<Vec<_>>(),
			"phase": phase,
			"session": authority.session.as_str(),
			"turn": authority.turn,
			"event": authority.event.as_deref(),
			"call": authority.call.as_deref(),
			"device": authority.device.as_deref(),
			"effects": authority.effects.iter().map(Str::as_str).collect::<Vec<_>>(),
			"place_kind": authority.place_kind.as_str(),
			"lifecycle": lifecycle,
			"roots": authority.roots.iter().map(Str::as_str).collect::<Vec<_>>(),
			"remote": authority.remote,
			"has_ui": authority.has_ui,
			"headless": authority.headless,
			"settings": &authority.settings,
			"secret_settings": authority.secret_settings.iter().map(Str::as_str).collect::<Vec<_>>(),
			"data": &authority.data,
			"direct_filesystem": &authority.direct_filesystem,
		}),
	);
	body
}

async fn write_dispatch_request(
	shared: &Arc<ControlShared>,
	request: DispatchRequest,
) -> Result<(), ControlRuntimeError> {
	let body: serde_json::Map<String, Value> = serde_json::from_slice(request.payload.as_ref())?;
	write_json_control_frame(shared, JsonControlFrame {
		kind: String::from("Dispatch"),
		correlation: Some(request.id),
		body,
	})
	.await
}

async fn read_json_control_frame(
	reader: &mut OwnedReadHalf,
) -> Result<Option<JsonControlFrame>, ControlRuntimeError> {
	let mut header = [0_u8; 4];
	match reader.read_exact(&mut header).await {
		Ok(_) => {},
		Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
		Err(error) => return Err(error.into()),
	}
	let size = u32::from_be_bytes(header) as usize;
	if size > MAX_CONTROL_FRAME_BYTES {
		return Err(
			ControlProtocolError::new(
				"frame_too_large",
				format!("CONTROL frame is {size} bytes; limit is {MAX_CONTROL_FRAME_BYTES}"),
			)
			.into(),
		);
	}
	let mut payload = vec![0; size];
	reader.read_exact(&mut payload).await?;
	Ok(Some(serde_json::from_slice(&payload)?))
}

async fn write_cancel_dispatch(
	shared: &Arc<ControlShared>,
	invocation: &str,
) -> Result<(), ControlRuntimeError> {
	let mut body = serde_json::Map::new();
	body.insert(String::from("invocation"), Value::String(invocation.to_owned()));
	write_json_control_frame(shared, JsonControlFrame {
		kind: String::from("CancelDispatch"),
		correlation: None,
		body,
	})
	.await
}

async fn write_json_control_frame(
	shared: &Arc<ControlShared>,
	frame: JsonControlFrame,
) -> Result<(), ControlRuntimeError> {
	let payload = serde_json::to_vec(&frame)?;
	if payload.len() > MAX_CONTROL_FRAME_BYTES {
		return Err(
			ControlProtocolError::new(
				"frame_too_large",
				format!("CONTROL frame is {} bytes; limit is {MAX_CONTROL_FRAME_BYTES}", payload.len()),
			)
			.into(),
		);
	}
	let size = u32::try_from(payload.len())
		.map_err(|_| ControlProtocolError::new("frame_too_large", "CONTROL frame length overflow"))?;
	let mut writer = shared.writer.lock().await;
	writer.write_all(&size.to_be_bytes()).await?;
	writer.write_all(&payload).await?;
	writer.flush().await?;
	Ok(())
}

#[cfg(test)]
mod convar_tests {
	use std::{
		collections::{BTreeMap, BTreeSet},
		sync::Arc,
	};

	use omp_con::{Ctx, Origin, Value as ConValue};
	use omp_core::{Principal, sf};
	use serde_json::json;

	use super::{
		CompositeControlAuthority, ControlAuthority, ControlAuthorityFactory,
		ControlConnectionIdentity, ControlRequestContext, ConvarControlFactory,
		DispatchChunkState, DispatchProgressState, MAX_DISPATCH_PROGRESS_BYTES,
		MAX_DISPATCH_PROGRESS_EVENTS, append_dispatch_result_chunk, checked_progress_bytes,
		dispatch_frame_invocation_for_identity, quota_protocol_error,
	};
	use crate::exthost::{
		QuotaError, QuotaExceeded, QuotaScope, QuotaStatus, ResourceReceipt,
	};

	fn identity() -> Arc<ControlConnectionIdentity> {
		Arc::new(ControlConnectionIdentity {
			extension:          sf!("dev.example.demo"),
			principal:          Principal::new(sf!("test"), sf!("Test")),
			artifact_digest:    sf!("sha256:test"),
			layer:              sf!("project"),
			tier:               sf!("trusted"),
			trust:              sf!("trusted"),
			host_generation:    1,
			session_generation: 1,
			capabilities:       Arc::new(BTreeSet::new()),
		})
	}

	fn context(identity: &Arc<ControlConnectionIdentity>, request_id: u64) -> ControlRequestContext {
		ControlRequestContext { connection: Arc::clone(identity), request_id, invocation: None }
	}

	fn routed_authority(
		factory: &ConvarControlFactory,
		identity: Arc<ControlConnectionIdentity>,
	) -> Arc<dyn ControlAuthority> {
		let convars = factory.bind(identity).expect("bind convar authority");
		Arc::new(CompositeControlAuthority::new([Arc::clone(&convars)], convars))
	}

	#[test]
	fn dispatch_progress_is_generation_fenced_and_bounded() {
		let identity = identity();
		let stale = json!({
			"host_generation": 2,
			"session_generation": 1,
			"invocation": "call",
		});
		let error = dispatch_frame_invocation_for_identity(
			&identity,
			stale.as_object().expect("authority"),
		)
		.expect_err("stale generation");
		assert_eq!(error.code.as_str(), "StaleGeneration");

		let state = DispatchProgressState {
			invocation: sf!("call"),
			sender: None,
			events: MAX_DISPATCH_PROGRESS_EVENTS,
			bytes: 0,
		};
		let error = checked_progress_bytes(&state, 1).expect_err("progress count overflow");
		assert_eq!(error.code.as_str(), "progress_overflow");
		let oversized = DispatchProgressState {
			invocation: sf!("call"),
			sender: None,
			events: 0,
			bytes: MAX_DISPATCH_PROGRESS_BYTES,
		};
		let error = checked_progress_bytes(&oversized, 1).expect_err("progress byte overflow");
		assert_eq!(error.code.as_str(), "progress_overflow");
	}

	#[test]
	fn dispatch_result_chunks_require_contiguous_order() {
		let invocation = sf!("call");
		let mut state = DispatchChunkState {
			invocation: invocation.clone(),
			next_index: 0,
			body: Vec::new(),
		};
		append_dispatch_result_chunk(&mut state, &invocation, 0, b"one")
			.expect("first result chunk");
		let error = append_dispatch_result_chunk(&mut state, &invocation, 2, b"three")
			.expect_err("out-of-order result chunk");
		assert_eq!(error.code.as_str(), "result_chunk_order");
		assert_eq!(state.body, b"one");
	}

	#[test]
	fn hard_quota_error_carries_the_current_receipt() {
		let receipt = ResourceReceipt {
			quotas: BTreeMap::from([(
				sf!("ui.updates"),
				QuotaStatus { limit: 3, used: 3, window: None },
			)]),
			dropped: BTreeMap::from([(sf!("ui.updates"), 1)]),
		};
		let error = quota_protocol_error(QuotaError::Exceeded(QuotaExceeded {
			quota: sf!("ui.updates"),
			scope: QuotaScope::Extension,
			receipt,
		}));
		assert_eq!(error.details["receipt"]["quotas"]["ui.updates"]["used"], 3);
		assert_eq!(error.details["receipt"]["dropped"]["ui.updates"], 1);
	}

	#[tokio::test]
	async fn extension_declarations_are_qualified_queryable_and_observable() {
		let ctx = Arc::new(Ctx::new());
		let factory = ConvarControlFactory::new(Arc::clone(&ctx));
		let identity = identity();
		let authority = routed_authority(&factory, Arc::clone(&identity));
		let declared = authority
			.request(
				context(&identity, 1),
				sf!("omp.convars.declare"),
				json!({
					"key": "enabled",
					"kind": "boolean",
					"default": false,
					"description": "Enable demo behavior",
					"ui": {
						"tab": "extension-tools",
						"group": "Extension Controls",
						"label": "Demo Behavior",
						"description": "Enable demo behavior",
						"warning": "Changes take effect immediately",
						"options": [
							{
								"value": "false",
								"label": "Disabled",
								"description": "Keep demo behavior disabled",
							},
							{"value": "true", "label": "Enabled"},
						],
						"ordered": true,
					},
				})
				.as_object()
				.cloned()
				.unwrap(),
			)
			.await
			.expect("declare convar");
		assert_eq!(declared["name"], "ext::dev.example.demo::enabled");
		assert_eq!(ctx.get("ext::dev.example.demo::enabled"), Some(ConValue::Bool(false)),);
		let spec = ctx
			.dynamic_var_spec("ext::dev.example.demo::enabled")
			.expect("dynamic declaration");
		assert_eq!(
			spec
				.meta
				.iter()
				.map(|(key, value)| (key.as_str(), value.as_str()))
				.collect::<Vec<_>>(),
			vec![
				("ui.tab", "extension-tools"),
				("ui.group", "Extension Controls"),
				("ui.label", "Demo Behavior"),
				("ui.description", "Enable demo behavior"),
				("ui.warning", "Changes take effect immediately"),
				("ui.option.false", "Disabled"),
				("ui.option.false.desc", "Keep demo behavior disabled"),
				("ui.option.true", "Enabled"),
				("ui.option.true.desc", ""),
				("ui.ordered", "true"),
			]
		);

		let observed = authority.request(
			context(&identity, 2),
			sf!("omp.convars.observe"),
			json!({"name": "ext::dev.example.demo::enabled", "after": 0})
				.as_object()
				.cloned()
				.unwrap(),
		);
		let update = async {
			tokio::task::yield_now().await;
			ctx.set("ext::dev.example.demo::enabled", ConValue::Bool(true), Origin::Session)
				.expect("change convar");
		};
		let (observed, ()) = tokio::join!(observed, update);
		let observed = observed.expect("observe convar");
		assert_eq!(observed["value"], true);
		assert_eq!(observed["sequence"], 1);

		let queried = authority
			.request(
				context(&identity, 3),
				sf!("omp.convars.get"),
				json!({"name": "ext::dev.example.demo::enabled"})
					.as_object()
					.cloned()
					.unwrap(),
			)
			.await
			.expect("query convar");
		assert_eq!(queried["value"], true);
	}

	#[tokio::test]
	async fn reconnect_accepts_only_an_identical_extension_declaration() {
		let ctx = Arc::new(Ctx::new());
		let factory = ConvarControlFactory::new(ctx);
		let identity = identity();
		let authority = routed_authority(&factory, Arc::clone(&identity));
		let declare = || {
			json!({
				"key": "mode",
				"kind": "enum",
				"default": "safe",
				"values": ["safe", "fast"],
			})
			.as_object()
			.cloned()
			.unwrap()
		};
		authority
			.request(context(&identity, 1), sf!("omp.convars.declare"), declare())
			.await
			.expect("first declaration");
		authority
			.request(context(&identity, 2), sf!("omp.convars.declare"), declare())
			.await
			.expect("identical reconnect declaration");
		let error = authority
			.request(
				context(&identity, 3),
				sf!("omp.convars.declare"),
				json!({
					"key": "mode",
					"kind": "enum",
					"default": "fast",
					"values": ["safe", "fast"],
				})
				.as_object()
				.cloned()
				.unwrap(),
			)
			.await
			.expect_err("conflicting declaration");
		assert_eq!(error.code, "ConvarDeclarationConflict");
	}
}
