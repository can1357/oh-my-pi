//! Envd-owned authority bridges behind the embedded shell's `dyn` builtin.

use std::{collections::BTreeSet, future::Future, sync::Arc};

use bytes::Bytes;
use futures::StreamExt as _;
use omp_agent::{ApprovalRoute, GateEvent, GateOutcome, HookGate};
use omp_core::{Duration, DurationUnit, Hash32, Str, sf};
use omp_proto::toolhost::v1::HookEventId;
use omp_shell_builtins::{
	DynCallOutput, DynDevice, DynFault, DynFuture, DynHost as ShellDynHost, DynOutput, DynSchema,
};
use omp_tool::{
	DevicePath, Diag, DiagEnvelope, DiagKind, ErasedEv, ErasedOutcome, ErasedStream, IncomingParams,
	Part, PromptCaps, Registry, RegistryError, ToolIdentity, ToolRoute,
};
use omp_tools::{
	device::{DeviceCatalog, DeviceInvokeRequest, ErasedDeviceInvoker},
	staging::{ProposalDecision, ProposalRejection, StagedProposalRegistry},
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::{
	admission::{DynamicAdmission, DynamicInvocationSource},
	blobs::{BlobHost, BlobId},
	mcp::manager::McpManager,
};

tokio::task_local! {
	static EXEC_DIAGS: Arc<Mutex<Vec<Diag>>>;
}

/// Runs one shell execution with a concurrency-safe diagnostic sink.
pub(crate) async fn scope_exec_diags<T>(
	sink: Arc<Mutex<Vec<Diag>>>,
	future: impl Future<Output = T>,
) -> T {
	EXEC_DIAGS.scope(sink, future).await
}

fn capture_exec_diags(diags: &[Diag]) {
	if diags.is_empty() {
		return;
	}
	let _ = EXEC_DIAGS.try_with(|sink| sink.lock().extend_from_slice(diags));
}

/// Envd-owned loopback bridge behind the `dyn` shell builtin.
pub struct DynHost {
	catalog:            DeviceCatalog,
	invoker:            Arc<dyn ErasedDeviceInvoker>,
	proposals:          StagedProposalRegistry,
	hooks:              Arc<HookGate>,
	blobs:              BlobHost,
	mcp:                Arc<McpManager>,
	admission:          DynamicAdmission,
	next_invocation_id: std::sync::atomic::AtomicU64,
}

impl DynHost {
	/// Binds one live device catalog, worker dispatcher, proposal registry, and
	/// session hook gate.
	pub(crate) fn new(
		catalog: DeviceCatalog,
		invoker: Arc<dyn ErasedDeviceInvoker>,
		proposals: StagedProposalRegistry,
		hooks: Arc<HookGate>,
		blobs: BlobHost,
		mcp: Arc<McpManager>,
		admission: DynamicAdmission,
	) -> Self {
		Self {
			catalog,
			invoker,
			proposals,
			hooks,
			blobs,
			mcp,
			admission,
			next_invocation_id: std::sync::atomic::AtomicU64::new(1),
		}
	}

	/// Binds or clears the session's live approval route for nested calls.
	pub(crate) fn bind_approval_route(&self, route: Option<ApprovalRoute>) {
		self.admission.bind_route(route);
	}

	fn invocation_id(&self) -> Str {
		let sequence = self
			.next_invocation_id
			.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
		sf!("dyn-{sequence}")
	}

	async fn visible_names(
		&self,
		registry: &Registry,
		dynamic: &[DynDevice],
	) -> Result<Option<BTreeSet<Str>>, DynFault> {
		if !self.hooks.subscribed(HookEventId::HookEventDeviceList) {
			return Ok(None);
		}
		let mut catalog_hash = Hash32::hasher();
		catalog_hash.update(registry.device_hash().as_bytes());
		for device in dynamic {
			catalog_hash.update(device.name.as_bytes());
			catalog_hash.update(b"\0");
			if let Some(description) = &device.description {
				catalog_hash.update(description.as_bytes());
			}
			catalog_hash.update(b"\0");
		}
		let device_hash = catalog_hash.finalize();
		let mut devices = registry
			.devices()
			.map(device_event_json)
			.collect::<Vec<_>>();
		devices.extend(dynamic.iter().map(|device| {
			json!({
				"name": device.name,
				"path": device.name,
				"summary": device.description,
				"place": "mcp",
				"mounted": true,
				"enabled": true,
				"available": true,
			})
		}));
		let payload = serde_json::to_vec(&json!({ "devices": devices, "turn_id": null }))
			.map(Bytes::from)
			.map_err(|_| DynFault::new("failed to encode the dynamic-device catalog"))?;
		let outcome = self
			.hooks
			.gate(
				HookEventId::HookEventDeviceList,
				GateEvent::new(sf!("device_list:{}", device_hash.to_hex()), payload),
			)
			.await;
		let effective = match outcome {
			GateOutcome::Allow { event, .. } => event.effective_args,
			GateOutcome::Deny { reason, .. } => return Err(DynFault::new(reason)),
			GateOutcome::Approval { .. } => {
				return Err(DynFault::new("device listing cannot require approval"));
			},
		};
		let effective: Value = serde_json::from_slice(&effective)
			.map_err(|_| DynFault::new("device-list hook returned malformed JSON"))?;
		let devices = effective
			.get("devices")
			.and_then(Value::as_array)
			.ok_or_else(|| DynFault::new("device-list hook omitted its effective devices"))?;
		Ok(Some(
			devices
				.iter()
				.filter_map(|device| device.get("name").and_then(Value::as_str).map(Str::new))
				.collect(),
		))
	}

	async fn call_mcp(
		&self,
		name: Str,
		args: Value,
		cancellation: CancellationToken,
	) -> Result<DynCallOutput, DynFault> {
		if let Some(effects) = self.mcp.dynamic_effects(name.as_str()) {
			self
				.admission
				.admit(
					self.invocation_id(),
					name.clone(),
					&effects,
					DynamicInvocationSource::ShellDyn,
					cancellation.clone(),
				)
				.await
				.map_err(|error| DynFault::new(error.to_string()))?;
		}
		self.mcp.call(name.as_str(), args, cancellation).await
	}

	fn proposal_schema(name: &str) -> Option<DynSchema> {
		matches!(name, "resolve" | "reject").then(|| DynSchema {
			name:        Str::new(name),
			description: Some(Str::new_static("Finalize one exact staged proposal.")),
			schema:      json!({
				"type": "object",
				"properties": {
					"proposal_id": {
						"type": "string",
						"minLength": 1,
						"description": "Exact pending proposal id printed by the staging tool."
					},
					"reason": {
						"type": "string",
						"minLength": 1,
						"description": "One-sentence decision reason."
					}
				},
				"required": ["proposal_id", "reason"],
				"additionalProperties": false
			}),
		})
	}

	fn finalize_proposal(&self, name: &str, args: &Value) -> Result<DynCallOutput, DynFault> {
		let object = args
			.as_object()
			.ok_or_else(|| DynFault::new("proposal finalization arguments must be an object"))?;
		if object
			.keys()
			.any(|key| !matches!(key.as_str(), "proposal_id" | "reason"))
		{
			return Err(DynFault::new(
				"proposal finalization accepts only `proposal_id` and `reason`",
			));
		}
		let id = args
			.get("proposal_id")
			.and_then(Value::as_str)
			.map(str::trim)
			.filter(|id| !id.is_empty())
			.ok_or_else(|| DynFault::new("an exact staged proposal id is required"))?;
		let reason = args
			.get("reason")
			.and_then(Value::as_str)
			.map(str::trim)
			.filter(|reason| !reason.is_empty())
			.ok_or_else(|| DynFault::new("a one-sentence reason is required"))?;
		let decision = if name == "resolve" {
			ProposalDecision::Resolve { reason: Str::new(reason) }
		} else {
			ProposalDecision::Reject(ProposalRejection::Requested { reason: Str::new(reason) })
		};
		let outcome = self
			.proposals
			.finalize(id, decision)
			.map_err(|error| DynFault::new(error.to_string()))?;
		let diags = recovery_snapshot_diag(&outcome.payload)
			.into_iter()
			.collect();
		let payload =
			serde_json::to_value(outcome).map_err(|error| DynFault::new(error.to_string()))?;
		Ok(DynCallOutput { output: DynOutput::Json(payload), diags })
	}
}

fn recovery_snapshot_diag(payload: &Value) -> Option<Diag> {
	let recovery = payload.get("recovery_root").and_then(Value::as_str)?;
	Some(if recovery.starts_with("artifact://") {
		Diag::info(DiagKind::Snapshot, "Recovery snapshot recorded").artifact(Str::new(recovery))
	} else {
		Diag::info(DiagKind::Snapshot, sf!("Recovery snapshot recorded at {recovery}"))
	})
}

impl ShellDynHost for DynHost {
	fn list(&self) -> DynFuture<'_, Vec<DynDevice>> {
		Box::pin(async move {
			let registry = self
				.catalog
				.registry()
				.ok_or_else(|| DynFault::new("device catalog is not available in this session"))?;
			let mcp = self.mcp.list().await?;
			let visible = self.visible_names(&registry, &mcp).await?;
			let mut devices = registry
				.devices()
				.map(|device| DynDevice {
					name:        device.name.clone(),
					description: Some(device.summary.clone()),
				})
				.chain(mcp)
				.filter(|device| {
					visible
						.as_ref()
						.is_none_or(|names| names.contains(device.name.as_str()))
				})
				.collect::<Vec<_>>();
			if self.proposals.latest_pending().is_some() {
				devices.extend([
					DynDevice {
						name:        sf!("resolve"),
						description: Some(sf!("Apply one exact staged proposal.")),
					},
					DynDevice {
						name:        sf!("reject"),
						description: Some(sf!("Discard one exact staged proposal.")),
					},
				]);
			}
			devices.sort_by(|left, right| left.name.cmp(&right.name));
			devices.dedup_by(|left, right| left.name == right.name);
			Ok(devices)
		})
	}

	fn schema(&self, name: &str) -> DynFuture<'_, DynSchema> {
		let name = Str::new(name);
		Box::pin(async move {
			if let Some(schema) = Self::proposal_schema(name.as_str()) {
				return Ok(schema);
			}
			let registry = self
				.catalog
				.registry()
				.ok_or_else(|| DynFault::new("device catalog is not available in this session"))?;
			if let Ok(path) = DevicePath::parse(name.as_str())
				&& let Some(device) = registry
					.devices()
					.find(|device| device.name.as_str() == path.root())
			{
				let schema = serde_json::from_slice(device.schema)
					.map_err(|_| DynFault::new(format!("device `{name}` has an invalid JSON schema")))?;
				return Ok(DynSchema { name, description: Some(device.summary.clone()), schema });
			}
			self.mcp.schema(name.as_str()).await
		})
	}

	fn call(
		&self,
		name: &str,
		args: Value,
		cancellation: CancellationToken,
	) -> DynFuture<'_, DynCallOutput> {
		let name = Str::new(name);
		Box::pin(async move {
			let result = async {
				if matches!(name.as_str(), "resolve" | "reject") {
					if cancellation.is_cancelled() {
						return Err(DynFault::new("staged proposal finalization was cancelled"));
					}
					// Finalization is the foreground mutation boundary: once the
					// exact transaction starts, it runs through commit or rollback.
					return self.finalize_proposal(name.as_str(), &args);
				}
				let registry = self
					.catalog
					.registry()
					.ok_or_else(|| DynFault::new("device catalog is not available in this session"))?;
				let Ok(path) = DevicePath::parse(name.as_str()) else {
					return self.call_mcp(name, args, cancellation).await;
				};
				let target = match registry.resolve_device(&path) {
					Ok(target) => target,
					Err(_)
						if registry
							.devices()
							.any(|device| device.name.as_str() == path.root()) =>
					{
						return Err(DynFault::new(format!(
							"device `{name}` rejected its path arguments"
						)));
					},
					Err(_) => return self.call_mcp(name, args, cancellation).await,
				};
				let identity = target.identity();
				let effects = target.effects.clone();
				let invocation_id = self.invocation_id();
				self
					.admission
					.admit(
						invocation_id.clone(),
						target.name.clone(),
						&effects,
						DynamicInvocationSource::ShellDyn,
						cancellation.clone(),
					)
					.await
					.map_err(|error| DynFault::new(error.to_string()))?;
				let raw = Str::new(args.to_string());
				let args_json = Bytes::from(raw.clone());
				let mut stream = match target.route.clone() {
					ToolRoute::Native => {
						let (feed, params) =
							IncomingParams::channel_for(None, Some(invocation_id.clone()));
						feed.args_committed(raw).map_err(|_| {
							DynFault::new("device argument channel closed before dispatch")
						})?;
						registry
							.invoke_device(&path, params)
							.map_err(|error| DynFault::new(format!("device dispatch failed: {error}")))?
					},
					ToolRoute::Remote => {
						return Err(DynFault::new("device is owned by the remote environment host"));
					},
					ToolRoute::Worker { site, name: worker } => {
						self
							.invoker
							.invoke(DeviceInvokeRequest {
								path,
								name: target.name.clone(),
								rev: Str::from(target.rev.to_string()),
								owner: Some(target.claimant.clone()),
								site: Some(site),
								worker: Some(worker),
								invocation_id,
								deadline: Duration::new(5, DurationUnit::Minutes),
								args_json,
							})
							.await
					},
				};
				consume(&registry, &self.blobs, &identity, &mut stream, cancellation).await
			}
			.await;
			if let Ok(call) = &result {
				capture_exec_diags(&call.diags);
			}
			result
		})
	}
}

async fn consume(
	registry: &Registry,
	blobs: &BlobHost,
	identity: &ToolIdentity,
	stream: &mut ErasedStream<'_>,
	cancellation: CancellationToken,
) -> Result<DynCallOutput, DynFault> {
	let mut diags = Vec::new();
	loop {
		let event = tokio::select! {
			biased;
			() = cancellation.cancelled() => {
				return Err(DynFault::new("dynamic device invocation was cancelled"));
			},
			event = stream.next() => event,
		};
		match event {
			Some(Ok(ErasedEv::Update(update))) => {
				if let Ok(envelope) = serde_json::from_slice::<DiagEnvelope>(&update) {
					diags.push(envelope.diag);
				}
			},
			Some(Ok(ErasedEv::Done(ErasedOutcome::Done { verdict, .. }))) => {
				let output = project_result(registry, blobs, identity, &verdict)?;
				return Ok(DynCallOutput { output, diags });
			},
			Some(Ok(ErasedEv::Done(ErasedOutcome::Detached(job)))) => {
				return Ok(DynCallOutput {
					output: DynOutput::Text(sf!("detached job: {}", job.id)),
					diags,
				});
			},
			Some(Err(error)) => {
				return Err(DynFault::new(format!("device dispatch failed: {error}")));
			},
			None => return Err(DynFault::new("device dispatch ended without an outcome")),
		}
	}
}

fn project_result(
	registry: &Registry,
	blobs: &BlobHost,
	identity: &ToolIdentity,
	verdict: &[u8],
) -> Result<DynOutput, DynFault> {
	let caps = PromptCaps {
		maximum_parts:      u16::MAX,
		maximum_text_bytes: u32::MAX,
		media:              true,
		dialect:            Default::default(),
		model_class:        Default::default(),
	};
	let output = match registry.prompt(identity, verdict, &caps) {
		Ok(Some(parts)) => {
			let outputs = parts
				.iter()
				.cloned()
				.map(|part| project_part(blobs, part))
				.collect::<Result<Vec<_>, _>>()?;
			join_outputs(outputs)
		},
		Ok(None) => DynOutput::Text(Str::default()),
		Err(RegistryError::UnsupportedExternal { .. }) => project_external_verdict(verdict)?,
		Err(error) => {
			return Err(DynFault::new(format!("device result projection failed: {error}")));
		},
	};
	if faulted(verdict) {
		Err(DynFault::new(output_error_message(output)))
	} else {
		Ok(output)
	}
}

fn project_part(blobs: &BlobHost, part: Part) -> Result<DynOutput, DynFault> {
	match part {
		Part::Text { text } => Ok(DynOutput::Text(text)),
		Part::Json { json } => serde_json::from_slice(&json)
			.map(DynOutput::Json)
			.map_err(|_| DynFault::new("device returned a malformed JSON output part")),
		Part::Blob { blob, .. } => {
			let hash = blob
				.hash
				.parse::<Hash32>()
				.map_err(|_| DynFault::new("device returned an invalid blob identity"))?;
			let bytes = blobs
				.get(BlobId { hash: hash.into_bytes(), size: blob.byte_len })
				.map_err(|_| DynFault::new("device output blob is unavailable"))?;
			Ok(DynOutput::Blob { mime: blob.media_type, bytes })
		},
	}
}

fn join_outputs(mut outputs: Vec<DynOutput>) -> DynOutput {
	if outputs.len() == 1 {
		outputs.pop().expect("one output")
	} else {
		DynOutput::Parts(outputs)
	}
}

fn project_external_verdict(verdict: &[u8]) -> Result<DynOutput, DynFault> {
	let verdict = serde_json::from_slice::<Value>(verdict)
		.map_err(|_| DynFault::new("external device returned a malformed verdict"))?;
	let value = verdict
		.get("value")
		.cloned()
		.ok_or_else(|| DynFault::new("external device verdict omitted its value"))?;
	Ok(match value {
		Value::String(text) => DynOutput::Text(Str::new(text)),
		other => DynOutput::Json(other),
	})
}

fn output_error_message(output: DynOutput) -> Str {
	match output {
		DynOutput::Text(text) | DynOutput::Markdown(text) => text,
		DynOutput::Json(value) => Str::new(value.to_string()),
		DynOutput::Blob { mime, .. } => sf!("device returned a binary error payload ({mime})"),
		DynOutput::Parts(parts) => {
			let text = parts
				.into_iter()
				.map(output_error_message)
				.filter(|part| !part.is_empty())
				.collect::<Vec<_>>();
			Str::new(text.join("\n"))
		},
	}
}

fn faulted(verdict: &[u8]) -> bool {
	serde_json::from_slice::<Value>(verdict)
		.ok()
		.is_some_and(|value| {
			value
				.get("kind")
				.and_then(Value::as_str)
				.is_some_and(|kind| matches!(kind, "fault" | "faulted"))
		})
}

fn device_event_json(device: omp_tool::MountedDevice<'_>) -> Value {
	let place = match device.route {
		ToolRoute::Native => String::from("env"),
		ToolRoute::Remote => String::from("remote"),
		ToolRoute::Worker { name, .. } => format!("worker:{name}"),
	};
	let mut row = Map::from_iter([
		("name".to_owned(), Value::String(device.name.to_string())),
		("family".to_owned(), Value::String(device.rev.family.to_string())),
		("rev".to_owned(), Value::from(device.rev.n)),
		("claimant".to_owned(), Value::String(device.claimant.to_string())),
		("path".to_owned(), Value::String(device.name.to_string())),
		("summary".to_owned(), Value::String(device.summary.to_string())),
		("place".to_owned(), Value::String(place)),
		("mounted".to_owned(), Value::Bool(true)),
		("enabled".to_owned(), Value::Bool(true)),
		("available".to_owned(), Value::Bool(true)),
	]);
	if let Some(metadata) = device.metadata {
		let mut provenance = Map::new();
		for (name, value) in [
			("publisher", metadata.publisher.as_ref()),
			("extension_id", metadata.extension_id.as_ref()),
			("version", metadata.version.as_ref()),
			("artifact_digest", metadata.artifact_digest.as_ref()),
			("layer", metadata.layer.as_ref()),
			("tier", metadata.tier.as_ref()),
		] {
			if let Some(value) = value {
				provenance.insert(name.to_owned(), Value::String(value.to_string()));
			}
		}
		if let Some(generation) = metadata.generation {
			provenance.insert("generation".to_owned(), Value::from(generation));
		}
		if !provenance.is_empty() {
			row.insert("provenance".to_owned(), Value::Object(provenance));
		}
	}
	Value::Object(row)
}

#[cfg(test)]
mod tests {
	use std::{
		future::Future,
		sync::atomic::{AtomicUsize, Ordering},
	};

	use futures::Stream;
	use omp_tool::{
		Claims, Constraint, Effects, Ev, ExecEffects, Precedence, Presentation, Rev, Tool, ToolSpec,
	};
	use omp_tools::device::{DeviceInvokeRequest, DeviceInvoker};

	use super::*;
	use crate::{
		admission::ApprovalMode,
		mcp::{McpService, manager::ProductionConnector},
	};

	struct CountingDevice {
		spec:  ToolSpec,
		calls: Arc<AtomicUsize>,
	}

	impl Tool for CountingDevice {
		type Fault = Value;
		type Params = Value;
		type Payload = Value;
		type Update = Value;

		fn spec(&self) -> &ToolSpec {
			&self.spec
		}

		fn call<'c>(
			&'c self,
			_incoming: IncomingParams<'c>,
		) -> impl Stream<Item = Ev<Value, Value, Value>> + Send + 'c {
			self.calls.fetch_add(1, Ordering::Relaxed);
			futures::stream::empty()
		}

		fn prompt(&self, _view: Result<&Value, &Value>, _caps: &PromptCaps) -> Vec<Part> {
			Vec::new()
		}
	}

	#[derive(Clone)]
	struct NoWorker;

	impl DeviceInvoker for NoWorker {
		fn invoke(
			&self,
			_request: DeviceInvokeRequest,
		) -> impl Future<Output = ErasedStream<'static>> + Send {
			async { Box::pin(futures::stream::empty()) as ErasedStream<'static> }
		}
	}

	#[test]
	fn proposal_dyn_schema_requires_exact_identity_and_reason() {
		for name in ["resolve", "reject"] {
			let schema = DynHost::proposal_schema(name).expect("proposal device schema");
			assert_eq!(schema.schema["required"], json!(["proposal_id", "reason"]));
			assert_eq!(schema.schema["additionalProperties"], false);
			assert_eq!(
				schema.schema["properties"]["proposal_id"]["description"],
				"Exact pending proposal id printed by the staging tool."
			);
		}
	}

	#[tokio::test]
	async fn recovery_snapshot_is_captured_out_of_band() {
		let artifact =
			"artifact://sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
		let diag = recovery_snapshot_diag(&json!({ "recovery_root": artifact }))
			.expect("snapshot diagnostic");
		assert_eq!(diag.native_kind(), Some(DiagKind::Snapshot));
		assert_eq!(diag.artifact.as_deref(), Some(artifact));

		let sink = Arc::new(Mutex::new(Vec::new()));
		scope_exec_diags(Arc::clone(&sink), async {
			capture_exec_diags(std::slice::from_ref(&diag));
		})
		.await;
		assert_eq!(sink.lock().as_slice(), &[diag]);
	}

	#[test]
	fn native_projection_preserves_json_and_blob_parts() {
		let scratch = tempfile::tempdir().expect("scratch");
		let blobs = BlobHost::open(scratch.path()).expect("blobs");
		let id = blobs.put(b"image").expect("store image");
		let json = project_part(&blobs, Part::Json { json: Bytes::from_static(br#"{"ok":true}"#) })
			.expect("JSON part");
		assert_eq!(json, DynOutput::Json(json!({"ok": true})));
		let blob = project_part(&blobs, Part::Blob {
			blob: omp_tool::BlobRef {
				hash:       Str::new(Hash32::new(id.hash).to_hex().as_str()),
				media_type: sf!("image/png"),
				byte_len:   id.size,
			},
			alt:  None,
		})
		.expect("blob part");
		assert_eq!(blob, DynOutput::Blob {
			mime:  sf!("image/png"),
			bytes: Bytes::from_static(b"image"),
		});
	}

	#[tokio::test]
	async fn denied_dynamic_effects_never_invoke_native_target() {
		let scratch = tempfile::tempdir().expect("scratch");
		let calls = Arc::new(AtomicUsize::new(0));
		let mut registry = Registry::new();
		registry
			.register(
				CountingDevice {
					spec:  ToolSpec {
						name:            sf!("danger"),
						rev:             Rev { family: sf!("test"), n: 1 },
						description:     sf!("mutating test device"),
						schema:          Bytes::from_static(br#"{"type":"object","properties":{}}"#),
						constraint:      Constraint::None,
						effects:         Effects {
							exec: Some(ExecEffects { commands: Arc::from([sf!("*")]), network: true }),
							..Effects::empty()
						},
						projection_code: [1; 32],
					},
					calls: Arc::clone(&calls),
				},
				Presentation::Device,
				Claims {
					precedence: Precedence::ENHANCEMENT,
					claimant:   sf!("omp/test"),
					replaces:   None,
				},
			)
			.expect("register target");
		let registry = Arc::new(registry);
		let catalog = DeviceCatalog::default();
		catalog
			.install_registry(Arc::clone(&registry))
			.expect("install catalog");
		let blobs = BlobHost::open(scratch.path().join("blobs")).expect("blobs");
		let mcp_service = McpService::open(scratch.path().join("mcp.sqlite3")).expect("MCP service");
		let mcp = McpManager::new(
			Arc::clone(&mcp_service),
			Arc::new(ProductionConnector::new(scratch.path().to_path_buf())),
			Arc::from([]),
			scratch.path().join("local"),
		);
		let admission =
			DynamicAdmission::new(ApprovalMode::AlwaysAsk, std::collections::BTreeMap::new(), None);
		let host = DynHost::new(
			catalog,
			Arc::new(NoWorker),
			StagedProposalRegistry::new(),
			Arc::new(HookGate::channel().0),
			blobs,
			mcp,
			admission,
		);

		let result = ShellDynHost::call(&host, "danger", json!({}), CancellationToken::new()).await;
		assert!(result.is_err());
		assert_eq!(calls.load(Ordering::Relaxed), 0);
	}
}
