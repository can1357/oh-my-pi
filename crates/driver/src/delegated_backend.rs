//! Delegated execution backend: bridges extension device operations to the
//! `ExecutionBackend` trait.
//!
//! The adapter implements `ExecutionBackend` by delegating to extension device
//! operations via `EnvClient::invoke`. Each device operation (`describe`,
//! `start`, `poll`, `get_log`, `cancel`) is invoked as a tool call, and the
//! response is mapped to the execution contract types.
//!
//! This enables any extension that implements the delegate contract
//! (`docs/research/exec-out-of-core.md` shape C1) to serve as a production
//! execution backend.

use std::{
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::Duration,
};

use omp_core::Str;
use omp_env::{ClientError, EnvClient, InvocationEvent};
use omp_exec::{
	BackendCapabilities, BackendId, CacheSupport, CancelOutcome, CancelSupport, ExecutionBackend,
	ExecutionError, ExecutionEvent, ExecutionRequest, ExecutionResult, ExecutionRun, Outcome,
	Platform, ReattachHandle, ResumeSupport,
};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::exec_composer::REMOTE_POSTURE;

/// Global counter for invocation IDs.
static INVOCATION_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Device operation names for the delegate contract.
mod device {
	pub const DESCRIBE: &str = "exec/describe";
	pub const START: &str = "exec/start";
	pub const POLL: &str = "exec/poll";
	pub const GET_LOG: &str = "exec/get_log";
	pub const CANCEL: &str = "exec/cancel";
}

/// Error from a delegated extension device call.
#[derive(Debug, thiserror::Error)]
pub enum DelegatedError {
	/// The device call failed at the transport level.
	#[error("device call failed: {0}")]
	Transport(#[source] ClientError),
	/// The device returned an error result.
	#[error("device error: {operation}: {detail}")]
	Device {
		/// The operation that failed.
		operation: &'static str,
		/// Error detail from the device.
		detail:    Str,
	},
	/// The device response was malformed.
	#[error("device response malformed: {operation}")]
	Malformed {
		/// The operation that returned malformed data.
		operation: &'static str,
	},
}

/// A connected delegated execution backend.
///
/// Cheap to clone (Arc-backed handle). The extension device path is resolved
/// once at construction.
#[derive(Clone)]
pub struct DelegatedBackend {
	inner: Arc<BackendInner>,
}

struct BackendInner {
	/// Environment client for device calls.
	client:       EnvClient,
	/// Operator-given backend identity.
	id:           BackendId,
	/// Capabilities for this backend.
	capabilities: Arc<BackendCapabilities>,
}

impl DelegatedBackend {
	/// Creates a new delegated backend.
	///
	/// The `client` must have the extension loaded and admitted. The `id` is
	/// the operator-given name used in execution handles.
	pub fn new(client: EnvClient, id: BackendId) -> Self {
		Self {
			inner: Arc::new(BackendInner {
				client,
				id,
				capabilities: Arc::new(BackendCapabilities {
					platforms:      Arc::new([Platform::LINUX_X86_64]),
					needs:          Default::default(),
					max_timeout:    Some(Duration::from_secs(60 * 30)),
					action_cache:   CacheSupport::None,
					cancel:         CancelSupport::None,
					resume:         ResumeSupport::Reattach,
					max_blob_bytes: None,
					warm_caches:    false,
					enforced:       REMOTE_POSTURE,
				}),
			}),
		}
	}

	/// Calls one device operation and returns its JSON result.
	async fn call_device(
		&self,
		operation: &'static str,
		args: Value,
	) -> Result<Value, DelegatedError> {
		let seq = INVOCATION_COUNTER.fetch_add(1, Ordering::Relaxed);
		let invocation_id = format!("delegated-{}-{}", operation, seq);
		let invoke = omp_env::frame::InvokeTool {
			invocation_id,
			name: operation.to_string(),
			rev: String::new(),
			deadline_ms: u64::try_from(Duration::from_secs(30).as_millis()).unwrap_or(u64::MAX),
			output_request: omp_env::frame::OutputRequest::Complete as i32,
			restrictions: None,
			..Default::default()
		};

		let mut invocation = self
			.inner
			.client
			.invoke(invoke)
			.await
			.map_err(DelegatedError::Transport)?;

		// Wait for acceptance
		match invocation
			.next_event()
			.await
			.map_err(DelegatedError::Transport)?
		{
			Some(InvocationEvent::Accepted(_)) => {},
			Some(InvocationEvent::Verdict(v)) => {
				// Some devices may return immediately with verdict
				return Self::extract_result(v, operation);
			},
			_ => {
				return Err(DelegatedError::Device {
					operation,
					detail: Str::new_static("device did not accept"),
				});
			},
		}

		// Commit empty args with the device-specific arguments
		let args_bytes =
			bytes::Bytes::from(serde_json::to_vec(&args).unwrap_or_else(|_| b"{}".to_vec()));
		invocation
			.commit_args(args_bytes, Default::default(), 0, None)
			.await
			.map_err(DelegatedError::Transport)?;

		// Stream events until verdict
		loop {
			match invocation
				.next_event()
				.await
				.map_err(DelegatedError::Transport)?
			{
				Some(InvocationEvent::Verdict(v)) => {
					return Self::extract_result(v, operation);
				},
				Some(InvocationEvent::Accepted(_)) | Some(InvocationEvent::Update(_)) => {
					// Continue streaming
				},
				Some(InvocationEvent::Admission(_)) => {
					// Should not happen for backend operations
					return Err(DelegatedError::Device {
						operation,
						detail: Str::new_static("unexpected admission query"),
					});
				},
				None => {
					return Err(DelegatedError::Device {
						operation,
						detail: Str::new_static("device stream closed without verdict"),
					});
				},
			}
		}
	}

	fn extract_result(
		v: omp_env::frame::Verdict,
		operation: &'static str,
	) -> Result<Value, DelegatedError> {
		// Check for error outcome
		if v.is_error {
			return Err(DelegatedError::Device {
				operation,
				detail: Str::new_static("device returned error"),
			});
		}
		// Parse the json bytes field as a JSON Value
		if v.json.is_empty() {
			return Err(DelegatedError::Malformed { operation });
		}
		serde_json::from_slice(&v.json).map_err(|_| DelegatedError::Malformed { operation })
	}
}

impl ExecutionBackend for DelegatedBackend {
	type Run = DelegatedRun;

	fn id(&self) -> &BackendId<str> {
		&self.inner.id
	}

	fn capabilities(&self) -> &BackendCapabilities {
		&self.inner.capabilities
	}

	fn start(
		&self,
		request: ExecutionRequest,
	) -> impl Future<Output = Result<Self::Run, ExecutionError>> + Send + '_ {
		let backend = self.clone();
		async move { backend.start_request(request).await }
	}

	fn reattach(
		&self,
		handle: ReattachHandle,
		context: omp_exec::ReattachContext,
	) -> impl Future<Output = Result<Self::Run, ExecutionError>> + Send + '_ {
		let backend = self.clone();
		async move { backend.reattach_request(handle, context).await }
	}
}

impl DelegatedBackend {
	async fn start_request(
		&self,
		request: ExecutionRequest,
	) -> Result<DelegatedRun, ExecutionError> {
		// Map ExecutionRequest to the device's start payload
		let steps: Vec<serde_json::Value> = request
			.argv
			.iter()
			.map(|arg| serde_json::json!({ "run": arg.as_str() }))
			.collect();

		let env_map: serde_json::Map<String, serde_json::Value> = request
			.env
			.iter()
			.map(|e| (e.name.to_string(), serde_json::json!(e.value.as_str())))
			.collect();
		let args = serde_json::json!({
			"steps": steps,
			"env": env_map,
		});

		let result = self
			.call_device(device::START, args)
			.await
			.map_err(|e| ExecutionError::Transport { source: Arc::new(e) })?;

		let operation = result
			.get("operation")
			.and_then(|v| v.as_str())
			.unwrap_or("")
			.to_string();

		if operation.is_empty() {
			return Err(ExecutionError::Transport {
				source: Arc::new(DelegatedError::Malformed { operation: device::START }),
			});
		}

		Ok(DelegatedRun {
			backend:   self.clone(),
			operation: Str::from(operation),
			id:        request.id,
			outputs:   request.outputs,
			timeout:   request.timeout,
			cursor:    None,
			settled:   false,
			cancel:    CancellationToken::new(),
		})
	}

	async fn reattach_request(
		&self,
		handle: ReattachHandle,
		_context: omp_exec::ReattachContext,
	) -> Result<DelegatedRun, ExecutionError> {
		// Reattach by creating a run that starts polling from the stored operation
		Ok(DelegatedRun {
			backend:   self.clone(),
			operation: handle.operation,
			id:        handle.id,
			outputs:   omp_exec::OutputSpec::Logs,
			timeout:   Duration::from_secs(60 * 30),
			cursor:    None,
			settled:   false,
			cancel:    CancellationToken::new(),
		})
	}
}

/// One delegated run in progress.
pub struct DelegatedRun {
	backend:   DelegatedBackend,
	operation: Str,
	id:        omp_exec::ExecutionId,
	outputs:   omp_exec::OutputSpec,
	timeout:   Duration,
	cursor:    Option<Str>,
	settled:   bool,
	cancel:    CancellationToken,
}

impl ExecutionRun for DelegatedRun {
	fn next_event(&mut self) -> impl Future<Output = Option<ExecutionEvent>> + Send + '_ {
		let backend = self.backend.clone();
		let operation = self.operation.clone();
		let id = self.id.clone();
		let cursor = self.cursor.clone();
		let settled = self.settled;
		async move {
			if settled {
				return None;
			}
			backend.next_event_for(operation, id, cursor).await
		}
	}

	fn cancel(&self) -> impl Future<Output = CancelOutcome> + Send + '_ {
		async move {
			let result = self
				.backend
				.call_device(
					device::CANCEL,
					serde_json::json!({ "operation": self.operation.as_str() }),
				)
				.await;

			match result {
				Ok(v) => {
					let outcome = v.get("outcome").and_then(|o| o.as_str()).unwrap_or("");
					match outcome {
						"unsupported" => CancelOutcome::Unsupported,
						"cancelled" => CancelOutcome::Cancelled,
						"already-settled" => CancelOutcome::AlreadySettled,
						"requested" => CancelOutcome::Requested,
						_ => CancelOutcome::Failed,
					}
				},
				Err(_) => CancelOutcome::Failed,
			}
		}
	}

	fn detach(self) -> ReattachHandle {
		ReattachHandle::new(self.backend.inner.id.clone(), self.operation, self.id)
	}
}

impl DelegatedBackend {
	async fn next_event_for(
		&self,
		operation: Str,
		id: omp_exec::ExecutionId,
		cursor: Option<Str>,
	) -> Option<ExecutionEvent> {
		// Poll for state
		let mut poll_args = serde_json::json!({ "operation": operation.as_str() });
		if let Some(ref cur) = cursor {
			poll_args["cursor"] = serde_json::json!(cur.as_str());
		}

		let poll_result = match self.call_device(device::POLL, poll_args).await {
			Ok(v) => v,
			Err(e) => {
				return Some(ExecutionEvent::Settled(Err(ExecutionError::Transport {
					source: Arc::new(e),
				})));
			},
		};

		let state = poll_result
			.get("state")
			.and_then(|s| s.as_str())
			.unwrap_or("unknown");

		// Map state to events
		match state {
			"running" => Some(ExecutionEvent::Executing),
			"succeeded" | "failed" => {
				let exit_code = poll_result
					.get("exitCode")
					.and_then(|c| c.as_i64())
					.unwrap_or(if state == "succeeded" { 0 } else { 1 }) as i32;

				Some(ExecutionEvent::Settled(Ok(ExecutionResult {
					id,
					backend: self.inner.id.clone(),
					outcome: Outcome::Exited { code: exit_code },
					logs: None,
					artifacts: Arc::new([]),
					output_digests: Default::default(),
					timing: Default::default(),
					transfer: Default::default(),
					cache_hit: false,
					fallback: None,
				})))
			},
			_ => Some(ExecutionEvent::Queued),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn backend_id_is_preserved() {
		let id = BackendId::new_static("buildbuddy");
		// We can't create a real EnvClient in a unit test, but we can verify
		// the type structure compiles correctly.
		assert_eq!(id.as_str(), "buildbuddy");
	}

	#[test]
	fn device_operation_names_are_correct() {
		assert_eq!(device::DESCRIBE, "exec/describe");
		assert_eq!(device::START, "exec/start");
		assert_eq!(device::POLL, "exec/poll");
		assert_eq!(device::GET_LOG, "exec/get_log");
		assert_eq!(device::CANCEL, "exec/cancel");
	}
}
