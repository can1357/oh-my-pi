//! Production adapters for envd-owned extension-host CONTROL authorities.

use std::{
	collections::BTreeMap,
	fmt::Display,
	fs, io,
	path::{Path, PathBuf},
	sync::Arc,
	time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use bytes::Bytes;
use omp_core::{Hash32, Str, Ulid};
use omp_sandbox::{Capability, CapabilitySet, backend_statuses};
use omp_tool::{ArgPath, IncomingCursor, IncomingParams, PullMode, PulledKind};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
	io::{AsyncReadExt as _, AsyncWriteExt as _},
	sync,
};
use tokio_util::sync::CancellationToken;

use super::{
	control::{
		AuditedDirectFilesystemRequest, ControlAuthority, ControlAuthorityFactory,
		ControlRequestContext, MAX_DIRECT_FILESYSTEM_BYTES,
	},
	params::{
		DirectFilesystemAuthorityError, DirectFilesystemControlOwner, DirectFilesystemEntry,
		DirectFilesystemExecutor, DirectFilesystemJournal, DirectFilesystemOutput,
		DirectFilesystemStat, ParameterAuthorityError, ParameterControlOwner, ParameterOperation,
		ParameterPathPart, ParameterPullRequest, ParameterPullResult, ParameterSource,
	},
};
use crate::{
	policy::{
		InstalledSandboxProfile, PolicyAuditSink, PolicyControlFailure, PolicyControlOwner,
		PolicyScope, SandboxCapabilities, SandboxEnforcement, SandboxMode, SandboxPolicyRuntime,
		SandboxProfile,
	},
	worker_pool,
	worker_pool::{WorkerControlOwner, WorkerProcessAuthority, WorkerSupervisor},
};

/// Returns only sandbox facilities proven by cached live backend probes.
pub fn detected_sandbox_capabilities() -> SandboxCapabilities {
	let mut backends = Vec::new();
	let mut enforced = CapabilitySet::empty();
	let mut degraded = Vec::new();
	for status in backend_statuses() {
		if status.is_available() {
			let backend = status.backend();
			let name: &'static str = backend.into();
			backends.push(Str::new_static(name));
			enforced = enforced.union(backend.capabilities());
		} else if let Some(failure) = status.failure() {
			if !matches!(failure, omp_sandbox::ProbeFailure::WrongHost { .. }) {
				degraded.push(Str::from(failure.to_string()));
			}
		}
	}
	SandboxCapabilities {
		backends,
		landlock_abi: None,
		filesystem: [
			Capability::FsReadHost,
			Capability::FsReadScope,
			Capability::FsReadDeny,
			Capability::FsWriteDeny,
			Capability::FsWriteScope,
			Capability::FsWriteEphemeral,
		]
		.into_iter()
		.any(|capability| enforced.contains(capability)),
		network: [Capability::NetDisable, Capability::NetEnable, Capability::NetOutbound]
			.into_iter()
			.any(|capability| enforced.contains(capability)),
		domain_filtering: false,
		resource_limits: [Capability::ResCpu, Capability::ResMemory, Capability::ResPids]
			.into_iter()
			.any(|capability| enforced.contains(capability)),
		degraded,
	}
}

mod admission {
	use parking_lot::Mutex;

	use super::*;

	#[derive(Clone)]
	struct SandboxContribution {
		handle:  Str,
		owner:   Str,
		profile: SandboxProfile,
		scope:   PolicyScope,
	}

	struct SandboxSession {
		baseline:      SandboxProfile,
		effective:     SandboxProfile,
		enforcement:   SandboxEnforcement,
		contributions: Vec<SandboxContribution>,
	}

	/// Authoritative admission state for sandbox processes activated by envd.
	///
	/// Activation publishes the real process receipt and baseline. Contributions
	/// are generation-independent opaque handles, strictly owner-fenced, and
	/// never allowed to widen the current effective profile.
	pub struct AdmissionSandboxRuntime {
		capabilities: SandboxCapabilities,
		sessions:     Mutex<BTreeMap<Str, SandboxSession>>,
		handles:      Mutex<BTreeMap<Str, Str>>,
	}

	impl AdmissionSandboxRuntime {
		/// Creates a runtime from facilities detected by the process launcher.
		pub fn new(capabilities: SandboxCapabilities) -> Self {
			Self {
				capabilities,
				sessions: Mutex::new(BTreeMap::new()),
				handles: Mutex::new(BTreeMap::new()),
			}
		}

		/// Publishes an already-installed native sandbox session.
		pub fn activate(
			&self,
			session: Str,
			profile: SandboxProfile,
			enforcement: SandboxEnforcement,
		) -> Result<(), PolicyControlFailure> {
			let mut sessions = self.sessions.lock();
			if sessions
				.get(&session)
				.is_some_and(|session| !session.contributions.is_empty())
			{
				return Err(PolicyControlFailure::ProfileWidened);
			}
			sessions.insert(session, SandboxSession {
				baseline: profile.clone(),
				effective: profile,
				enforcement,
				contributions: Vec::new(),
			});
			Ok(())
		}

		/// Drops admission state after the owning sandbox process terminates.
		pub fn deactivate(&self, session: &str) {
			let removed = self.sessions.lock().remove(session);
			if let Some(removed) = removed {
				let mut handles = self.handles.lock();
				for contribution in removed.contributions {
					handles.remove(&contribution.handle);
				}
			}
		}

		/// Expires contributions at the authoritative call/turn/session boundary.
		pub fn expire_scope(&self, session: &str, scope: PolicyScope) {
			let mut sessions = self.sessions.lock();
			let Some(session) = sessions.get_mut(session) else {
				return;
			};
			let removed = session
				.contributions
				.iter()
				.filter(|contribution| contribution.scope == scope)
				.map(|contribution| contribution.handle.clone())
				.collect::<Vec<_>>();
			session
				.contributions
				.retain(|contribution| contribution.scope != scope);
			session.effective = session
				.contributions
				.last()
				.map_or_else(|| session.baseline.clone(), |value| value.profile.clone());
			let mut handles = self.handles.lock();
			for handle in removed {
				handles.remove(&handle);
			}
		}

		fn supports(&self, profile: &SandboxProfile) -> Result<(), PolicyControlFailure> {
			if let Some(required) = profile.require.iter().find(|required| {
				!self
					.capabilities
					.backends
					.iter()
					.any(|backend| backend == *required)
			}) {
				return Err(PolicyControlFailure::EnforcementUnavailable(Str::from(format!(
					"required sandbox backend {required} is unavailable"
				))));
			}
			if profile.mode == SandboxMode::Enforce
				&& (!self.capabilities.filesystem
					|| (!self.capabilities.network && profile.network.mode != "open")
					|| (!self.capabilities.resource_limits && profile.resources != Default::default()))
			{
				return Err(PolicyControlFailure::EnforcementUnavailable(Str::new_static(
					"active sandbox facilities cannot enforce the requested profile",
				)));
			}
			Ok(())
		}
	}

	fn subset<T: PartialEq>(narrow: &[T], broad: &[T]) -> bool {
		narrow.iter().all(|value| broad.contains(value))
	}

	fn superset<T: PartialEq>(narrow: &[T], broad: &[T]) -> bool {
		subset(broad, narrow)
	}

	fn effect_narrows(narrow: &str, broad: &str) -> bool {
		narrow == broad || (narrow == "deny" && broad == "allow")
	}

	fn ceiling_narrows<T: PartialOrd>(narrow: Option<T>, broad: Option<T>) -> bool {
		match (narrow, broad) {
			(Some(narrow), Some(broad)) => narrow <= broad,
			(Some(_), None) | (None, None) => true,
			(None, Some(_)) => false,
		}
	}

	fn profile_narrows(narrow: &SandboxProfile, broad: &SandboxProfile) -> bool {
		let mode = |mode| match mode {
			SandboxMode::Off => 0_u8,
			SandboxMode::Observe => 1,
			SandboxMode::Enforce => 2,
		};
		let network = |mode: &str| match mode {
			"open" => 0_u8,
			"proxy" => 1,
			"deny" => 2,
			_ => return 0,
		};
		mode(narrow.mode) >= mode(broad.mode)
			&& effect_narrows(
				narrow.filesystem.read_default.as_str(),
				broad.filesystem.read_default.as_str(),
			) && effect_narrows(
			narrow.filesystem.write_default.as_str(),
			broad.filesystem.write_default.as_str(),
		) && effect_narrows(
			narrow.filesystem.exec_default.as_str(),
			broad.filesystem.exec_default.as_str(),
		) && (broad.filesystem.read_default == "allow"
			|| subset(&narrow.filesystem.allow_read, &broad.filesystem.allow_read))
			&& (broad.filesystem.write_default == "allow"
				|| subset(&narrow.filesystem.allow_write, &broad.filesystem.allow_write))
			&& (broad.filesystem.exec_default == "allow"
				|| subset(&narrow.filesystem.allow_exec, &broad.filesystem.allow_exec))
			&& superset(&narrow.filesystem.deny_read, &broad.filesystem.deny_read)
			&& superset(&narrow.filesystem.deny_write, &broad.filesystem.deny_write)
			&& superset(&narrow.filesystem.deny_exec, &broad.filesystem.deny_exec)
			&& (broad.filesystem.tmpdir.is_none()
				|| narrow.filesystem.tmpdir == broad.filesystem.tmpdir)
			&& (!narrow.filesystem.follow_symlinks || broad.filesystem.follow_symlinks)
			&& network(narrow.network.mode.as_str()) >= network(broad.network.mode.as_str())
			&& (broad.network.mode == "open"
				|| subset(&narrow.network.allow_domains, &broad.network.allow_domains))
			&& superset(&narrow.network.deny_domains, &broad.network.deny_domains)
			&& (broad.network.mode == "open"
				|| subset(&narrow.network.allow_ports, &broad.network.allow_ports))
			&& (!narrow.network.allow_localhost || broad.network.allow_localhost)
			&& subset(&narrow.network.allow_unix_sockets, &broad.network.allow_unix_sockets)
			&& subset(&narrow.network.allow_mach_lookup, &broad.network.allow_mach_lookup)
			&& effect_narrows(narrow.exec.default.as_str(), broad.exec.default.as_str())
			&& (broad.exec.default == "allow" || subset(&narrow.exec.allow, &broad.exec.allow))
			&& superset(&narrow.exec.deny, &broad.exec.deny)
			&& (!narrow.exec.allow_interpreters || broad.exec.allow_interpreters)
			&& (!narrow.exec.allow_setuid || broad.exec.allow_setuid)
			&& (!narrow.exec.allow_ptrace || broad.exec.allow_ptrace)
			&& (!narrow.exec.allow_new_session || broad.exec.allow_new_session)
			&& ceiling_narrows(narrow.exec.max_children, broad.exec.max_children)
			&& ceiling_narrows(narrow.resources.wall, broad.resources.wall)
			&& ceiling_narrows(narrow.resources.cpu, broad.resources.cpu)
			&& ceiling_narrows(narrow.resources.memory_bytes, broad.resources.memory_bytes)
			&& ceiling_narrows(narrow.resources.file_size_bytes, broad.resources.file_size_bytes)
			&& ceiling_narrows(narrow.resources.open_files, broad.resources.open_files)
			&& ceiling_narrows(narrow.resources.processes, broad.resources.processes)
			&& ceiling_narrows(narrow.resources.disk_write_bytes, broad.resources.disk_write_bytes)
			&& ceiling_narrows(narrow.resources.stdout_bytes, broad.resources.stdout_bytes)
	}

	#[async_trait]
	impl SandboxPolicyRuntime for AdmissionSandboxRuntime {
		async fn capabilities(&self) -> Result<SandboxCapabilities, PolicyControlFailure> {
			Ok(self.capabilities.clone())
		}

		async fn effective_profile(
			&self,
			session: &str,
		) -> Result<SandboxProfile, PolicyControlFailure> {
			self
				.sessions
				.lock()
				.get(session)
				.map(|session| session.effective.clone())
				.ok_or(PolicyControlFailure::UnknownHandle)
		}

		async fn enforcement(
			&self,
			session: &str,
		) -> Result<SandboxEnforcement, PolicyControlFailure> {
			self
				.sessions
				.lock()
				.get(session)
				.map(|session| session.enforcement.clone())
				.ok_or(PolicyControlFailure::UnknownHandle)
		}

		async fn install(
			&self,
			owner: &str,
			session: &str,
			profile: SandboxProfile,
			scope: PolicyScope,
		) -> Result<InstalledSandboxProfile, PolicyControlFailure> {
			self.supports(&profile)?;
			let mut sessions = self.sessions.lock();
			let session_state = sessions
				.get_mut(session)
				.ok_or(PolicyControlFailure::UnknownHandle)?;
			if !profile_narrows(&profile, &session_state.effective) {
				return Err(PolicyControlFailure::ProfileWidened);
			}
			let handle = Str::from(format!("sandbox-{}", Ulid::generate()));
			session_state.contributions.push(SandboxContribution {
				handle: handle.clone(),
				owner: Str::from(owner),
				profile: profile.clone(),
				scope,
			});
			session_state.effective = profile.clone();
			self
				.handles
				.lock()
				.insert(handle.clone(), Str::from(session));
			Ok(InstalledSandboxProfile { handle_id: handle, profile })
		}

		async fn revoke(&self, owner: &str, handle_id: &str) -> Result<(), PolicyControlFailure> {
			let session_id = self
				.handles
				.lock()
				.get(handle_id)
				.cloned()
				.ok_or(PolicyControlFailure::UnknownHandle)?;
			let mut sessions = self.sessions.lock();
			let session = sessions
				.get_mut(&session_id)
				.ok_or(PolicyControlFailure::UnknownHandle)?;
			let index = session
				.contributions
				.iter()
				.position(|contribution| {
					contribution.handle == handle_id && contribution.owner == owner
				})
				.ok_or(PolicyControlFailure::UnknownHandle)?;
			session.contributions.remove(index);
			session.effective = session
				.contributions
				.last()
				.map_or_else(|| session.baseline.clone(), |value| value.profile.clone());
			self.handles.lock().remove(handle_id);
			Ok(())
		}

		async fn amend(
			&self,
			owner: &str,
			session: &str,
			patch: SandboxProfile,
			scope: PolicyScope,
			_reason: Str,
			_approval: Option<omp_agent::ApprovalSpec>,
		) -> Result<(), PolicyControlFailure> {
			self.install(owner, session, patch, scope).await.map(|_| ())
		}
	}
}

pub use admission::AdmissionSandboxRuntime;

/// Live invocation argument cursors indexed by the host-issued invocation id.
///
/// Registration moves the sole [`IncomingParams`] consumer into this owner;
/// neither CONTROL nor another task can create a competing cursor over the
/// invocation stream.
#[derive(Default)]
pub struct LiveParameterSource {
	invocations: Mutex<BTreeMap<Str, Arc<sync::Mutex<LiveParameters>>>>,
}

struct LiveParameters {
	params: IncomingParams<'static>,
	cursor: Option<IncomingCursor<'static>>,
}

impl LiveParameterSource {
	/// Installs the sole live argument consumer for one invocation.
	pub fn register(
		&self,
		invocation_id: Str,
		params: IncomingParams<'static>,
	) -> Result<(), ParameterAuthorityError> {
		let mut invocations = self.invocations.lock();
		if invocations.contains_key(&invocation_id) {
			return Err(ParameterAuthorityError::Source(Str::new_static(
				"invocation parameter cursor is already registered",
			)));
		}
		invocations.insert(
			invocation_id,
			Arc::new(sync::Mutex::new(LiveParameters { params, cursor: None })),
		);
		Ok(())
	}

	/// Releases the argument consumer after terminal invocation cleanup.
	pub fn unregister(&self, invocation_id: &str) -> bool {
		self.invocations.lock().remove(invocation_id).is_some()
	}

	fn invocation(
		&self,
		invocation_id: &str,
	) -> Result<Arc<sync::Mutex<LiveParameters>>, ParameterAuthorityError> {
		self
			.invocations
			.lock()
			.get(invocation_id)
			.cloned()
			.ok_or_else(|| {
				ParameterAuthorityError::Source(Str::new_static(
					"live invocation argument cursor was not found",
				))
			})
	}
}

fn parameter_path(path: &[ParameterPathPart]) -> Vec<ArgPath> {
	path
		.iter()
		.map(|part| match part {
			ParameterPathPart::Key(key) => ArgPath::Key(key.clone()),
			ParameterPathPart::Index(index) => ArgPath::Index(*index),
		})
		.collect()
}

fn pull_mode(request: &ParameterPullRequest) -> Result<PullMode, ParameterAuthorityError> {
	let offset = usize::try_from(request.offset.unwrap_or(0)).map_err(|_| {
		ParameterAuthorityError::Invalid(Str::new_static("parameter offset is too large"))
	})?;
	Ok(match request.mode.as_deref().unwrap_or("value") {
		"value" | "complete" => PullMode::Complete,
		"started" => PullMode::Started,
		"text" | "chunk" => PullMode::Chunk(offset),
		"line" => PullMode::Line(offset),
		_ => {
			return Err(ParameterAuthorityError::Invalid(Str::new_static(
				"unknown parameter pull mode",
			)));
		},
	})
}

fn pulled_json(pulled: omp_tool::Pulled) -> Result<Value, ParameterAuthorityError> {
	let value = match pulled.kind {
		PulledKind::Complete(value) => value
			.deserialize_into::<Value>()
			.map_err(parameter_source_error)?,
		PulledKind::Started(kind) => Value::String(
			match kind {
				omp_tool::PulledValueKind::Null => "null",
				omp_tool::PulledValueKind::Boolean => "boolean",
				omp_tool::PulledValueKind::Number => "number",
				omp_tool::PulledValueKind::String => "string",
				omp_tool::PulledValueKind::Array => "array",
				omp_tool::PulledValueKind::Object => "object",
			}
			.to_owned(),
		),
		PulledKind::Chunk { value, complete } => json!({"text": value, "complete": complete}),
	};
	Ok(json!({
		"value": value,
		"span": [pulled.span.start, pulled.span.end],
		"matched_key": pulled.matched_key,
	}))
}

async fn run_parameter_pull(
	live: &mut LiveParameters,
	request: &ParameterPullRequest,
) -> Result<Value, ParameterAuthorityError> {
	match request.operation {
		ParameterOperation::Args => live
			.params
			.finalize()
			.await
			.map_err(parameter_source_error)?
			.effective()
			.deserialize_into::<Value>()
			.map_err(parameter_source_error),
		ParameterOperation::Raw => live
			.params
			.raw()
			.await
			.map(|value| Value::String(value.to_string()))
			.map_err(parameter_source_error),
		ParameterOperation::Committed => live
			.params
			.committed()
			.await
			.map(|value| Value::String(value.to_string()))
			.map_err(parameter_source_error),
		ParameterOperation::NextInterrupt => live
			.params
			.next_interrupt()
			.await
			.map(|interrupt| json!({"class": interrupt.class, "reason": interrupt.reason}))
			.map_err(parameter_source_error),
		ParameterOperation::Pull | ParameterOperation::ArrayNext | ParameterOperation::ObjectNext => {
			if live.cursor.is_none() {
				live.cursor = Some(live.params.cursor().map_err(parameter_source_error)?);
			}
			let mut path = parameter_path(&request.path);
			if request.operation == ParameterOperation::ArrayNext {
				path.push(ArgPath::Index(request.index.ok_or_else(|| {
					ParameterAuthorityError::Invalid(Str::new_static("array_next requires index"))
				})?));
			}
			let pulled = {
				let cursor = live
					.cursor
					.as_ref()
					.expect("cursor was initialized")
					.clone();
				let mode = pull_mode(request)?;
				if request.interruptible {
					tokio::select! {
						result = cursor.pull_at(&path, mode, "the requested parameter") => {
							result.map_err(parameter_source_error)?
						},
						interrupt = live.params.next_interrupt() => {
							let interrupt = interrupt.map_err(parameter_source_error)?;
							return Err(ParameterAuthorityError::Source(Str::from(format!(
								"parameter pull interrupted: {}: {}",
								interrupt.class, interrupt.reason
							))));
						},
					}
				} else {
					cursor
						.pull_at(&path, mode, "the requested parameter")
						.await
						.map_err(parameter_source_error)?
				}
			};
			if request.operation != ParameterOperation::ObjectNext {
				return pulled_json(pulled);
			}
			let PulledKind::Complete(value) = pulled.kind else {
				return Err(ParameterAuthorityError::Invalid(Str::new_static(
					"object_next path is not an object",
				)));
			};
			let Some(object) = value.as_object() else {
				return Err(ParameterAuthorityError::Invalid(Str::new_static(
					"object_next path is not an object",
				)));
			};
			let index = usize::try_from(request.index.unwrap_or(0)).map_err(|_| {
				ParameterAuthorityError::Invalid(Str::new_static("object index is too large"))
			})?;
			Ok(match object.iter().nth(index) {
				Some((key, value)) => json!({
					"key": key.to_string(),
					"value": value
						.deserialize_into::<Value>()
						.map_err(parameter_source_error)?,
				}),
				None => Value::Null,
			})
		},
	}
}

fn parameter_source_error(error: impl Display) -> ParameterAuthorityError {
	ParameterAuthorityError::Source(Str::from(error.to_string()))
}

#[async_trait]
impl ParameterSource for LiveParameterSource {
	async fn pull(
		&self,
		request: ParameterPullRequest,
		cancel: CancellationToken,
	) -> Result<ParameterPullResult, ParameterAuthorityError> {
		let invocation = self.invocation(request.invocation_id.as_str())?;
		let mut live = tokio::select! {
			_ = cancel.cancelled() => return Err(ParameterAuthorityError::Source(Str::new_static("parameter pull cancelled"))),
			live = invocation.lock() => live,
		};
		let value = tokio::select! {
			_ = cancel.cancelled() => return Err(ParameterAuthorityError::Source(Str::new_static("parameter pull cancelled"))),
			result = run_parameter_pull(&mut live, &request) => result?,
		};
		Ok(ParameterPullResult(value))
	}
}

/// Durable JSON-lines policy audit used immediately before approval mutation.
pub struct DurablePolicyAuditSink {
	path:   PathBuf,
	append: sync::Mutex<()>,
}

impl DurablePolicyAuditSink {
	/// Uses the session-owned audit path as the sole approval decision log.
	pub fn new(path: PathBuf) -> Self {
		Self { path, append: sync::Mutex::new(()) }
	}
}

#[async_trait]
impl PolicyAuditSink for DurablePolicyAuditSink {
	async fn approval_decided(
		&self,
		ticket: &omp_agent::ApprovalTicket,
	) -> Result<(), PolicyControlFailure> {
		#[derive(Serialize)]
		struct Record<'a> {
			kind:          &'static str,
			ts_ms:         u64,
			ticket_id:     &'a Str,
			invocation_id: &'a Option<Str>,
			state:         &'static str,
			decision:      Option<Decision<'a>>,
		}
		#[derive(Serialize)]
		struct Decision<'a> {
			approved:   bool,
			scope:      &'a str,
			source:     &'static str,
			decided_by: &'a Option<Str>,
			reason:     &'a Option<Str>,
			audited:    bool,
		}
		let decision = ticket.decision.as_ref().map(|decision| Decision {
			approved:   decision.approved,
			scope:      decision.scope.as_str(),
			source:     decision.source.into(),
			decided_by: &decision.decided_by,
			reason:     &decision.reason,
			audited:    decision.audited,
		});
		let record = Record {
			kind: "approval_decided",
			ts_ms: now_ms(),
			ticket_id: &ticket.ticket_id,
			invocation_id: &ticket.invocation_id,
			state: ticket.state.into(),
			decision,
		};
		append_json_line(&self.path, &self.append, &record)
			.await
			.map_err(|error| PolicyControlFailure::Audit(Str::from(error.to_string())))
	}
}

/// Provenance-stamped durable journal for the exceptional direct-filesystem
/// escape. Each append is flushed before the executor is called.
pub struct DurableDirectFilesystemJournal {
	path:   PathBuf,
	append: sync::Mutex<()>,
}

impl DurableDirectFilesystemJournal {
	/// Creates a journal at the session-owned audit path.
	pub fn new(path: PathBuf) -> Self {
		Self { path, append: sync::Mutex::new(()) }
	}
}

#[async_trait]
impl DirectFilesystemJournal for DurableDirectFilesystemJournal {
	async fn append_request(
		&self,
		context: &ControlRequestContext,
		request: &AuditedDirectFilesystemRequest,
	) -> Result<Str, DirectFilesystemAuthorityError> {
		#[derive(Serialize)]
		struct Record<'a> {
			kind:               &'static str,
			receipt:            &'a str,
			ts_ms:              u64,
			request_id:         u64,
			extension:          &'a str,
			artifact_digest:    &'a str,
			host_generation:    u64,
			session_generation: u64,
			invocation:         Option<&'a str>,
			operation:          &'a str,
			path:               &'a Path,
			payload_bytes:      usize,
			payload_digest:     String,
			grant_id:           &'a str,
			publisher:          &'a str,
			capability_digest:  &'a str,
			grant_generation:   u64,
		}
		let receipt = Ulid::generate().to_string();
		let record = Record {
			kind:               "direct_filesystem_request",
			receipt:            &receipt,
			ts_ms:              now_ms(),
			request_id:         context.request_id,
			extension:          context.connection.extension.as_str(),
			artifact_digest:    context.connection.artifact_digest.as_str(),
			host_generation:    context.connection.host_generation,
			session_generation: context.connection.session_generation,
			invocation:         context
				.invocation
				.as_ref()
				.map(|value| value.invocation.as_str()),
			operation:          request.operation.as_str(),
			path:               &request.path,
			payload_bytes:      request.data.len(),
			payload_digest:     Hash32::sum(&request.data).to_hex().to_string(),
			grant_id:           request.grant.grant_id.as_str(),
			publisher:          request.grant.publisher.as_str(),
			capability_digest:  request.grant.capability_digest.as_str(),
			grant_generation:   request.grant.generation,
		};
		append_json_line(&self.path, &self.append, &record)
			.await
			.map_err(|error| DirectFilesystemAuthorityError::Audit(Str::from(error.to_string())))?;
		Ok(Str::from(receipt))
	}
}

async fn append_json_line(
	path: &Path,
	lock: &sync::Mutex<()>,
	value: &impl Serialize,
) -> io::Result<()> {
	let mut bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
	bytes.push(b'\n');
	let _guard = lock.lock().await;
	if let Some(parent) = path.parent() {
		tokio::fs::create_dir_all(parent).await?;
	}
	let mut file = tokio::fs::OpenOptions::new()
		.create(true)
		.append(true)
		.open(path)
		.await?;
	file.write_all(&bytes).await?;
	file.sync_all().await
}

/// Explicit host filesystem executor with bounded request and response bytes.
#[derive(Clone, Copy, Debug, Default)]
pub struct HostDirectFilesystemExecutor;

#[async_trait]
impl DirectFilesystemExecutor for HostDirectFilesystemExecutor {
	async fn execute(
		&self,
		request: AuditedDirectFilesystemRequest,
		cancel: CancellationToken,
	) -> Result<DirectFilesystemOutput, DirectFilesystemAuthorityError> {
		let operation = execute_filesystem(request);
		tokio::select! {
			_ = cancel.cancelled() => Err(DirectFilesystemAuthorityError::Execute(Str::new_static("direct-filesystem request cancelled"))),
			result = operation => result,
		}
	}
}

async fn execute_filesystem(
	request: AuditedDirectFilesystemRequest,
) -> Result<DirectFilesystemOutput, DirectFilesystemAuthorityError> {
	let failure =
		|error: io::Error| DirectFilesystemAuthorityError::Execute(Str::from(error.to_string()));
	match request.operation.as_str() {
		"read" => {
			let file = tokio::fs::File::open(&request.path)
				.await
				.map_err(failure)?;
			let size = file.metadata().await.map_err(failure)?.len();
			if size > MAX_DIRECT_FILESYSTEM_BYTES as u64 {
				return Err(DirectFilesystemAuthorityError::Execute(Str::new_static(
					"file exceeds 1 MiB response ceiling",
				)));
			}
			let mut bytes = Vec::with_capacity(size as usize);
			file
				.take((MAX_DIRECT_FILESYSTEM_BYTES + 1) as u64)
				.read_to_end(&mut bytes)
				.await
				.map_err(failure)?;
			if bytes.len() > MAX_DIRECT_FILESYSTEM_BYTES {
				return Err(DirectFilesystemAuthorityError::Execute(Str::new_static(
					"file exceeds 1 MiB response ceiling",
				)));
			}
			Ok(DirectFilesystemOutput::Bytes(Bytes::from(bytes)))
		},
		"write" => {
			if request.data.len() > MAX_DIRECT_FILESYSTEM_BYTES {
				return Err(DirectFilesystemAuthorityError::Invalid(Str::new_static(
					"payload exceeds 1 MiB",
				)));
			}
			let mut file = tokio::fs::File::create(&request.path)
				.await
				.map_err(failure)?;
			file.write_all(&request.data).await.map_err(failure)?;
			file.sync_data().await.map_err(failure)?;
			Ok(DirectFilesystemOutput::Applied)
		},
		"stat" => {
			let metadata = tokio::fs::symlink_metadata(&request.path)
				.await
				.map_err(failure)?;
			Ok(DirectFilesystemOutput::Stat(filesystem_stat(&metadata)))
		},
		"list" => {
			let mut directory = tokio::fs::read_dir(&request.path).await.map_err(failure)?;
			let mut entries = Vec::new();
			let mut response_bytes = 0_usize;
			while let Some(entry) = directory.next_entry().await.map_err(failure)? {
				let kind = entry.file_type().await.map_err(failure)?;
				let path = entry.path().to_string_lossy().into_owned();
				response_bytes =
					response_bytes.saturating_add(path.len().saturating_mul(6).saturating_add(64));
				if response_bytes > MAX_DIRECT_FILESYSTEM_BYTES {
					return Err(DirectFilesystemAuthorityError::Execute(Str::new_static(
						"directory listing exceeds 1 MiB response ceiling",
					)));
				}
				entries.push(DirectFilesystemEntry {
					path: Str::from(path),
					kind: Str::new_static(file_kind(&kind)),
				});
			}
			entries.sort_by(|left, right| left.path.cmp(&right.path));
			Ok(DirectFilesystemOutput::Entries(entries))
		},
		"mkdir" => {
			tokio::fs::create_dir_all(&request.path)
				.await
				.map_err(failure)?;
			Ok(DirectFilesystemOutput::Applied)
		},
		"remove" => {
			let metadata = tokio::fs::symlink_metadata(&request.path)
				.await
				.map_err(failure)?;
			if metadata.is_dir() {
				tokio::fs::remove_dir_all(&request.path)
					.await
					.map_err(failure)?;
			} else {
				tokio::fs::remove_file(&request.path)
					.await
					.map_err(failure)?;
			}
			Ok(DirectFilesystemOutput::Applied)
		},
		_ => Err(DirectFilesystemAuthorityError::Invalid(Str::new_static("unsupported operation"))),
	}
}

fn filesystem_stat(metadata: &fs::Metadata) -> DirectFilesystemStat {
	DirectFilesystemStat {
		kind:        Str::new_static(if metadata.file_type().is_symlink() {
			"symlink"
		} else if metadata.is_file() {
			"file"
		} else if metadata.is_dir() {
			"directory"
		} else {
			"other"
		}),
		size:        metadata.len(),
		modified_ms: metadata.modified().ok().and_then(epoch_ms),
		readonly:    metadata.permissions().readonly(),
	}
}

fn file_kind(kind: &fs::FileType) -> &'static str {
	if kind.is_symlink() {
		"symlink"
	} else if kind.is_file() {
		"file"
	} else if kind.is_dir() {
		"directory"
	} else {
		"other"
	}
}

fn epoch_ms(time: SystemTime) -> Option<u64> {
	time
		.duration_since(UNIX_EPOCH)
		.ok()
		.and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn now_ms() -> u64 {
	epoch_ms(SystemTime::now()).unwrap_or(0)
}

/// App-facing production handles and generation-binding factories for every
/// envd-owned owner in this module.
///
/// The bundle creates the worker supervisor and durable audit/executor adapters
/// internally. Invocation feeds and sandbox process receipts enter through the
/// exposed authoritative handles at their actual activation boundaries.
pub struct EnvdHostOwnerBackends {
	/// Live sandbox admission state.
	pub sandbox:                   Arc<AdmissionSandboxRuntime>,
	/// Sole invocation argument-cursor registry.
	pub parameters:                Arc<LiveParameterSource>,
	/// Named-worker route and process registry.
	pub workers:                   Arc<WorkerSupervisor>,
	/// Policy CONTROL factory.
	pub policy_factory:            Arc<dyn ControlAuthorityFactory>,
	/// Parameter CONTROL factory.
	pub parameter_factory:         Arc<dyn ControlAuthorityFactory>,
	/// Worker CONTROL factory.
	pub worker_factory:            Arc<dyn ControlAuthorityFactory>,
	/// Audited direct-filesystem CONTROL factory.
	pub direct_filesystem_factory: Arc<dyn ControlAuthorityFactory>,
}

impl EnvdHostOwnerBackends {
	/// Constructs the production bundle with envd's canonical worker ceilings
	/// and fail-closed detected sandbox facilities.
	pub fn production(data_dir: &Path, approvals: omp_agent::ApprovalRoute) -> Self {
		Self::new(
			data_dir,
			detected_sandbox_capabilities(),
			approvals,
			worker_pool::DEFAULT_WORKER_LAYER_CEILING,
			worker_pool::DEFAULT_MAX_CONCURRENT_SPAWNS,
		)
	}

	/// Constructs production envd owners under one session data directory.
	pub fn new(
		data_dir: &Path,
		capabilities: SandboxCapabilities,
		approvals: omp_agent::ApprovalRoute,
		worker_layer_ceiling: u64,
		worker_spawn_ceiling: u64,
	) -> Self {
		let sandbox = Arc::new(AdmissionSandboxRuntime::new(capabilities));
		let parameters = Arc::new(LiveParameterSource::default());
		let workers = Arc::new(WorkerSupervisor::new(worker_layer_ceiling, worker_spawn_ceiling));
		let policy_audit =
			Arc::new(DurablePolicyAuditSink::new(data_dir.join("policy-control.jsonl")));
		let filesystem_journal =
			Arc::new(DurableDirectFilesystemJournal::new(data_dir.join("direct-filesystem.jsonl")));
		let policy_factory = policy_control_factory(
			sandbox.clone() as Arc<dyn SandboxPolicyRuntime>,
			approvals,
			policy_audit,
		);
		let parameter_factory =
			parameter_control_factory(parameters.clone() as Arc<dyn ParameterSource>);
		let worker_factory = worker_control_factory(Arc::clone(&workers));
		let direct_filesystem_factory = direct_filesystem_control_factory(
			filesystem_journal,
			Arc::new(HostDirectFilesystemExecutor),
		);
		Self {
			sandbox,
			parameters,
			workers,
			policy_factory,
			parameter_factory,
			worker_factory,
			direct_filesystem_factory,
		}
	}
}

/// Creates a generation-binding policy owner factory.
pub fn policy_control_factory(
	runtime: Arc<dyn SandboxPolicyRuntime>,
	approvals: omp_agent::ApprovalRoute,
	audit: Arc<dyn PolicyAuditSink>,
) -> Arc<dyn ControlAuthorityFactory> {
	Arc::new(move |identity| {
		Ok(Arc::new(PolicyControlOwner::new(
			identity,
			Arc::clone(&runtime),
			approvals.clone(),
			Arc::clone(&audit),
		)) as Arc<dyn ControlAuthority>)
	})
}

/// Creates a generation-binding live parameter owner factory.
pub fn parameter_control_factory(
	source: Arc<dyn ParameterSource>,
) -> Arc<dyn ControlAuthorityFactory> {
	Arc::new(move |identity| {
		Ok(Arc::new(ParameterControlOwner::new(identity, Arc::clone(&source)))
			as Arc<dyn ControlAuthority>)
	})
}

/// Creates a generation-binding worker owner over the authoritative supervisor.
pub fn worker_control_factory(
	supervisor: Arc<WorkerSupervisor>,
) -> Arc<dyn ControlAuthorityFactory> {
	let processes = supervisor.clone() as Arc<dyn WorkerProcessAuthority>;
	Arc::new(move |identity| {
		Ok(Arc::new(WorkerControlOwner::new(
			identity,
			Arc::clone(&supervisor),
			Arc::clone(&processes),
		)) as Arc<dyn ControlAuthority>)
	})
}

/// Creates a generation-binding audited direct-filesystem owner factory.
pub fn direct_filesystem_control_factory(
	journal: Arc<dyn DirectFilesystemJournal>,
	executor: Arc<dyn DirectFilesystemExecutor>,
) -> Arc<dyn ControlAuthorityFactory> {
	Arc::new(move |identity| {
		Ok(Arc::new(DirectFilesystemControlOwner::new(
			identity,
			Arc::clone(&journal),
			Arc::clone(&executor),
		)) as Arc<dyn ControlAuthority>)
	})
}
