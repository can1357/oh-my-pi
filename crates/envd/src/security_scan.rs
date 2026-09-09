//! Environment-owned repository security scan authority.

mod cloud;
mod model;
mod sarif;
mod store;

use std::{
	collections::{BTreeMap, BTreeSet},
	fmt::Write as _,
	fs,
	future::Future,
	path::{Path, PathBuf},
	process::Command,
	sync::Arc,
	time::{SystemTime, UNIX_EPOCH},
};

use cloud::CloudClient;
use model::{
	Evidence, Finding, KnowledgeBase, Location, Operation, Plan, Producer, Provenance, Remediation,
	Scan, State, Validation, validation_evidence,
};
use omp_core::{CowBytes, Hash32, Str, Ulid};
use omp_tools::{
	read::{
		Fault as ReadFault,
		resolver::{
			LineOffsetCache, Resolve, ResourceCompletion, ResourceEntry, ResourceList, fuzzy_score,
		},
		selector::ParsedSelector,
	},
	security_scan::{
		Action, Fault, Params, Payload, SecurityScanControl, TargetKind, ValidationStatus,
	},
};
use parking_lot::Mutex;
use serde_json::{Value, json};
use store::{Store, public_bundle, public_scan, redact_value, write_json_atomic};
use tokio_util::sync::CancellationToken;

const MAX_FILES: usize = 20_000;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SARIF_BYTES: u64 = 16 * 1024 * 1024;
const MAX_STATUS_BYTES: usize = 4 * 1024 * 1024;
const WORKFLOW_VERSION: &str = "omp-security-workflow/v2";

/// Live security authority scoped to one project environment.
#[derive(Clone)]
pub struct SecurityScanService {
	root:   Arc<PathBuf>,
	store:  Arc<Store>,
	state:  Arc<Mutex<Result<State, ()>>>,
	active: Arc<Mutex<BTreeMap<Str, CancellationToken>>>,
	cloud:  Option<CloudClient>,
	lines:  Arc<LineOffsetCache>,
}

impl SecurityScanService {
	/// Opens the project security authority under the environment state root.
	pub fn new(root: PathBuf, state_dir: &Path) -> Self {
		let canonical = root.canonicalize().unwrap_or(root);
		let opened = Store::open(&canonical, state_dir);
		let store_available = opened.is_ok();
		let (store, mut state) = match opened {
			Ok(value) => value,
			Err(_) => (
				Store {
					root:       state_dir.join("security-invalid"),
					state_path: state_dir.join("security-invalid/state.json"),
				},
				State::default(),
			),
		};
		let mut recovered = false;
		for operation in state.operations.values_mut() {
			if matches!(operation.phase.as_str(), "queued" | "running") {
				operation.phase = Str::new_static("failed");
				operation.error = Some(Str::new_static("security scan interrupted by host restart"));
				operation.updated_at = now_stamp();
				if let Some(scan) = state.scans.get_mut(&operation.scan_id) {
					scan.status = Str::new_static("failed");
					scan.completed_at = Some(operation.updated_at.clone());
				}
				recovered = true;
			}
		}
		let state_result = if store_available {
			if recovered && store.save(&state).is_err() {
				Err(())
			} else {
				Ok(state)
			}
		} else {
			Err(())
		};
		Self {
			root:   Arc::new(canonical),
			store:  Arc::new(store),
			state:  Arc::new(Mutex::new(state_result)),
			active: Arc::new(Mutex::new(BTreeMap::new())),
			cloud:  CloudClient::from_environment(),
			lines:  Arc::new(LineOffsetCache::default()),
		}
	}

	/// Binds the combined credential authority used for exact cloud-account
	/// leases.
	pub(crate) fn with_credentials(
		mut self,
		credentials: Arc<crate::github_url::GithubCredentialBridge>,
	) -> Self {
		if let Some(cloud) = CloudClient::from_authority(credentials) {
			self.cloud = Some(cloud);
		}
		self
	}

	fn execute_local(&self, params: Params) -> Result<Payload, Fault> {
		match params.action {
			Action::Preflight => self.preflight(params),
			Action::Status => self.status(params),
			Action::Cancel => self.cancel(params),
			Action::Validate => self.validate(params),
			Action::ImportSarif => self.import_sarif(params),
			Action::ExportSarif => self.export_sarif(params),
			Action::Export => self.export_bundle(params),
			Action::Lineage => self.lineage(params),
			Action::RemediationCreate => self.remediation_create(params),
			Action::RemediationStatus => self.remediation_status(params),
			Action::RemediationCleanup => self.remediation_cleanup(params),
			Action::Start
			| Action::CloudScans
			| Action::CloudStart
			| Action::CloudStatus
			| Action::CloudPull => Err(Fault::InvalidArguments),
		}
	}

	fn preflight(&self, params: Params) -> Result<Payload, Fault> {
		let target = params.target_kind.unwrap_or_default();
		let include_paths = clean_paths(params.include_paths.unwrap_or_default())?;
		let exclude_paths = clean_paths(params.exclude_paths.unwrap_or_default())?;
		if target == TargetKind::ScopedPath && include_paths.is_empty() {
			return Err(Fault::InvalidArguments);
		}
		let (base_revision, head_revision) = match target {
			TargetKind::RefDiff => (
				Some(resolve_revision(&self.root, required(params.base_revision)?)?),
				Some(resolve_revision(&self.root, required(params.head_revision)?)?),
			),
			_ => (None, None),
		};
		let knowledge_bases =
			knowledge_bases(&self.root, params.knowledge_base_paths.unwrap_or_default())?;
		let archive_existing = params.archive_existing.unwrap_or(false);
		let output_root = params
			.output_root
			.map(|path| {
				validate_output_root(&self.root, &path, archive_existing)?;
				Ok(path)
			})
			.transpose()?;
		let tree_digest =
			tree_digest(&self.root, target, base_revision.as_deref(), head_revision.as_deref())?;
		let workflow_fingerprint = Str::new(format!(
			"omp-security-workflow/v2:sha256:{}",
			Hash32::sum(WORKFLOW_VERSION.as_bytes()).to_hex()
		));
		let canonical = serde_json::to_vec(&json!({
			"target": target,
			"include_paths": include_paths,
			"exclude_paths": exclude_paths,
			"base_revision": base_revision,
			"head_revision": head_revision,
			"knowledge_bases": knowledge_bases,
			"output_root": output_root,
			"archive_existing": archive_existing,
			"tree_digest": tree_digest,
			"workflow_fingerprint": workflow_fingerprint,
		}))
		.map_err(|_| Fault::Storage)?;
		let fingerprint =
			Str::new(format!("omp-security-plan/v2:sha256:{}", Hash32::sum(&canonical).to_hex()));
		let id_digest = Hash32::sum(fingerprint.as_bytes()).to_hex();
		let id = Str::new(format!("secplan_{}", &id_digest[..24]));
		let plan = Plan {
			id: id.clone(),
			fingerprint: fingerprint.clone(),
			created_at: now_stamp(),
			target,
			include_paths,
			exclude_paths,
			base_revision,
			head_revision,
			knowledge_bases,
			output_root,
			archive_existing,
			tree_digest,
			workflow_fingerprint,
		};
		self.mutate(|state| {
			state.plans.insert(id.clone(), plan);
			Ok(())
		})?;
		Ok(payload(
			Action::Preflight,
			format!(
				"Security plan {id} is ready. Fingerprint: {fingerprint}. Start it with action=start \
				 and plan_id={id}."
			),
			json!({"plan": {"id": id, "fingerprint": fingerprint}}),
		))
	}

	async fn start(&self, params: Params, call_cancel: CancellationToken) -> Result<Payload, Fault> {
		let plan_id = required(params.plan_id)?;
		let plan = self
			.inspect(|state| state.plans.get(&plan_id).cloned())?
			.ok_or(Fault::NotFound)?;
		let current_digest = tree_digest(
			&self.root,
			plan.target,
			plan.base_revision.as_deref(),
			plan.head_revision.as_deref(),
		)?;
		if current_digest != plan.tree_digest {
			return Err(Fault::InvalidArguments);
		}
		if call_cancel.is_cancelled() {
			return Err(Fault::Unavailable);
		}
		let nonce = unique_material();
		let operation_id =
			Str::new(format!("secop_{}", &Hash32::sum(nonce.as_bytes()).to_hex()[..24]));
		let scan_id = Str::new(format!(
			"secscan_{}",
			&Hash32::sum(format!("{nonce}:{plan_id}").as_bytes()).to_hex()[..24]
		));
		let created = now_stamp();
		let operation = Operation {
			id:            operation_id.clone(),
			scan_id:       scan_id.clone(),
			plan_id:       plan_id.clone(),
			phase:         Str::new_static("queued"),
			created_at:    created.clone(),
			updated_at:    created.clone(),
			finding_count: 0,
			error:         None,
		};
		let producer = native_producer();
		let provenance = native_provenance(&plan, &operation_id, &producer);
		let scan = Scan {
			id: scan_id.clone(),
			plan_id: Some(plan_id.clone()),
			status: Str::new_static("running"),
			created_at: created,
			completed_at: None,
			target: plan.target,
			producer,
			provenance,
			findings: Vec::new(),
			report: None,
			sarif: None,
		};
		self.mutate(|state| {
			state.operations.insert(operation_id.clone(), operation);
			state.scans.insert(scan_id.clone(), scan);
			Ok(())
		})?;
		let operation_cancel = CancellationToken::new();
		self
			.active
			.lock()
			.insert(operation_id.clone(), operation_cancel.clone());
		let service = self.clone();
		let spawned_operation = operation_id.clone();
		tokio::spawn(async move {
			service
				.run_scan(spawned_operation, plan, operation_cancel)
				.await;
		});
		Ok(payload(
			Action::Start,
			format!("Security scan {scan_id} started as {operation_id}."),
			json!({"operation": {"id": operation_id, "scan_id": scan_id, "phase": "queued"}}),
		))
	}

	async fn run_scan(&self, operation_id: Str, plan: Plan, cancellation: CancellationToken) {
		let _ = self.mutate(|state| {
			let operation = state
				.operations
				.get_mut(&operation_id)
				.ok_or(Fault::NotFound)?;
			operation.phase = Str::new_static("running");
			operation.updated_at = now_stamp();
			Ok(())
		});
		let root = Arc::clone(&self.root);
		let store_root = self.store.root.clone();
		let plan_for_scan = plan.clone();
		let token = cancellation.clone();
		let result = tokio::task::spawn_blocking(move || {
			scan_target(&root, &store_root, &plan_for_scan, &token)
		})
		.await;
		let scan_result = match result {
			Ok(result) => result,
			Err(_) => Err(Fault::Storage),
		};
		let completed = now_stamp();
		let _ = self.mutate(|state| {
			let operation = state
				.operations
				.get_mut(&operation_id)
				.ok_or(Fault::NotFound)?;
			let scan = state
				.scans
				.get_mut(&operation.scan_id)
				.ok_or(Fault::NotFound)?;
			match scan_result {
				Ok(mut findings) if !cancellation.is_cancelled() => {
					for finding in &mut findings {
						finding.scan_id = scan.id.clone();
					}
					operation.phase = Str::new_static("completed");
					operation.finding_count = findings.len();
					scan.status = Str::new_static("completed");
					scan.findings = findings;
					scan.report = Some(render_report(scan));
					scan.sarif = Some(sarif::export(scan, &self.root));
				},
				Ok(_) => {
					operation.phase = Str::new_static("cancelled");
					scan.status = Str::new_static("cancelled");
				},
				Err(_) if cancellation.is_cancelled() => {
					operation.phase = Str::new_static("cancelled");
					scan.status = Str::new_static("cancelled");
				},
				Err(_) => {
					operation.phase = Str::new_static("failed");
					operation.error = Some(Str::new_static("security scan execution failed"));
					scan.status = Str::new_static("failed");
				},
			}
			operation.updated_at = completed.clone();
			scan.completed_at = Some(completed.clone());
			Ok(())
		});
		if let Some(output) = plan.output_root {
			let export = self
				.inspect(|state| {
					state
						.operations
						.get(&operation_id)
						.and_then(|operation| state.scans.get(&operation.scan_id))
						.cloned()
				})
				.and_then(|scan| scan.ok_or(Fault::NotFound))
				.and_then(|scan| export_directory(&self.root, &output, plan.archive_existing, &scan));
			if export.is_err() {
				let _ = self.mutate(|state| {
					let operation = state
						.operations
						.get_mut(&operation_id)
						.ok_or(Fault::NotFound)?;
					operation.phase = Str::new_static("failed");
					operation.error = Some(Str::new_static("security scan output export failed"));
					let scan = state
						.scans
						.get_mut(&operation.scan_id)
						.ok_or(Fault::NotFound)?;
					scan.status = Str::new_static("failed");
					Ok(())
				});
			}
		}
		self.active.lock().remove(&operation_id);
	}

	fn status(&self, params: Params) -> Result<Payload, Fault> {
		let operation_id = required(params.operation_id)?;
		let operation = self
			.inspect(|state| state.operations.get(&operation_id).cloned())?
			.ok_or(Fault::NotFound)?;
		Ok(payload(
			Action::Status,
			format!(
				"Security scan {}: {}; {} finding(s).",
				operation.scan_id, operation.phase, operation.finding_count
			),
			json!({"operation": operation}),
		))
	}

	fn cancel(&self, params: Params) -> Result<Payload, Fault> {
		let operation_id = required(params.operation_id)?;
		let exists = self.inspect(|state| state.operations.contains_key(&operation_id))?;
		if !exists {
			return Err(Fault::NotFound);
		}
		let cancelled = self.active.lock().get(&operation_id).is_some_and(|token| {
			token.cancel();
			true
		});
		Ok(payload(
			Action::Cancel,
			if cancelled {
				format!("Cancellation requested for {operation_id}.")
			} else {
				format!("No running operation {operation_id}.")
			},
			json!({"operation_id": operation_id, "cancelled": cancelled}),
		))
	}

	fn validate(&self, params: Params) -> Result<Payload, Fault> {
		let scan_id = required(params.scan_id)?;
		let finding_id = required(params.finding_id)?;
		let status = params.validation_status.ok_or(Fault::InvalidArguments)?;
		let summary = required(params.validation_summary)?;
		let input = params.validation_evidence.unwrap_or_default();
		if input.iter().any(|item| item.label.trim().is_empty()) {
			return Err(Fault::InvalidArguments);
		}
		self.mutate(|state| {
			let scan = state.scans.get_mut(&scan_id).ok_or(Fault::NotFound)?;
			let finding = scan
				.findings
				.iter_mut()
				.find(|finding| finding.id == finding_id)
				.ok_or(Fault::NotFound)?;
			let evidence = validation_evidence(&finding.fingerprint, finding.evidence.len(), input);
			let evidence_ids = evidence.iter().map(|item| item.id.clone()).collect();
			finding.evidence.extend(evidence);
			finding.validation = Validation {
				status,
				summary: Some(summary),
				evidence_ids,
				validated_at: Some(now_stamp()),
			};
			scan.report = Some(render_report(scan));
			scan.sarif = Some(sarif::export(scan, &self.root));
			Ok(())
		})?;
		Ok(payload(
			Action::Validate,
			format!("Finding {finding_id} validation is now {}.", enum_json(status)),
			json!({"finding": {"id": finding_id, "validation_status": status}}),
		))
	}

	fn import_sarif(&self, params: Params) -> Result<Payload, Fault> {
		let input = workspace_path(&self.root, &required(params.input_path)?, true)?;
		if fs::metadata(&input).map_err(|_| Fault::Storage)?.len() > MAX_SARIF_BYTES {
			return Err(Fault::InvalidSarif);
		}
		let bytes = fs::read(&input).map_err(|_| Fault::Storage)?;
		let value: Value = serde_json::from_slice(&bytes).map_err(|_| Fault::InvalidSarif)?;
		let mut scan = sarif::import(value, &self.root, &input)?;
		scan.sarif = Some(sarif::export(&scan, &self.root));
		let scan_id = scan.id.clone();
		let count = scan.findings.len();
		self.mutate(|state| {
			state.scans.insert(scan_id.clone(), scan);
			Ok(())
		})?;
		Ok(payload(
			Action::ImportSarif,
			format!("Imported {count} SARIF finding(s) as security scan {scan_id}."),
			json!({"scan": {"id": scan_id, "finding_count": count}}),
		))
	}

	fn export_sarif(&self, params: Params) -> Result<Payload, Fault> {
		let scan_id = required(params.scan_id)?;
		let scan = self
			.inspect(|state| state.scans.get(&scan_id).cloned())?
			.ok_or(Fault::NotFound)?;
		let output = workspace_path(&self.root, &required(params.output_path)?, false)?;
		write_json_atomic(&output, &sarif::export(&scan, &self.root))?;
		Ok(payload(
			Action::ExportSarif,
			format!(
				"Exported security scan {scan_id} as SARIF to {}.",
				relative_display(&self.root, &output)
			),
			json!({"scan_id": scan_id, "path": relative_display(&self.root, &output), "format": "sarif-2.1.0"}),
		))
	}

	fn export_bundle(&self, params: Params) -> Result<Payload, Fault> {
		let scan_id = required(params.scan_id)?;
		let scan = self
			.inspect(|state| state.scans.get(&scan_id).cloned())?
			.ok_or(Fault::NotFound)?;
		let output = workspace_path(&self.root, &required(params.output_path)?, false)?;
		write_json_atomic(&output, &public_bundle(&scan))?;
		Ok(payload(
			Action::Export,
			format!(
				"Exported redacted security scan {scan_id} to {}.",
				relative_display(&self.root, &output)
			),
			json!({"scan_id": scan_id, "path": relative_display(&self.root, &output), "redacted": true}),
		))
	}

	fn lineage(&self, params: Params) -> Result<Payload, Fault> {
		let before_id = required(params.before_scan_id)?;
		let after_id = required(params.after_scan_id)?;
		let (before, after) = self.inspect(|state| {
			(state.scans.get(&before_id).cloned(), state.scans.get(&after_id).cloned())
		})?;
		let before = before.ok_or(Fault::NotFound)?;
		let after = after.ok_or(Fault::NotFound)?;
		if after.status != "completed" {
			return Err(Fault::InvalidArguments);
		}
		let comparison = compare_lineage(&before, &after);
		let unchanged = comparison["unchanged"].as_u64().unwrap_or_default();
		let resolved = comparison["resolved"].as_u64().unwrap_or_default();
		let introduced = comparison["introduced"].as_u64().unwrap_or_default();
		Ok(payload(
			Action::Lineage,
			format!(
				"Security lineage {before_id} -> {after_id}: {unchanged} unchanged, {introduced} \
				 introduced, {resolved} resolved."
			),
			comparison,
		))
	}

	fn remediation_create(&self, params: Params) -> Result<Payload, Fault> {
		let scan_id = required(params.scan_id)?;
		let finding_ids = params
			.finding_ids
			.unwrap_or_default()
			.into_iter()
			.map(|id| Str::new(id.trim()))
			.filter(|id| !id.is_empty())
			.collect::<BTreeSet<_>>();
		if finding_ids.is_empty() {
			return Err(Fault::InvalidArguments);
		}
		let scan = self
			.inspect(|state| state.scans.get(&scan_id).cloned())?
			.ok_or(Fault::NotFound)?;
		if finding_ids
			.iter()
			.any(|id| !scan.findings.iter().any(|finding| finding.id == *id))
		{
			return Err(Fault::NotFound);
		}
		ensure_clean_repository(&self.root)?;
		let id = params
			.remediation_id
			.filter(|id| valid_remediation_id(id))
			.unwrap_or_else(|| Str::new(format!("security-remediation-{}", unique_material())));
		let path = self.store.root.join("remediations").join(id.as_str());
		if path.exists() {
			return Err(Fault::InvalidArguments);
		}
		fs::create_dir_all(path.parent().ok_or(Fault::Storage)?).map_err(|_| Fault::Storage)?;
		let status = Command::new("git")
			.args([
				"-C",
				self.root.to_string_lossy().as_ref(),
				"worktree",
				"add",
				"--detach",
				path.to_string_lossy().as_ref(),
				"HEAD",
			])
			.status()
			.map_err(|_| Fault::Storage)?;
		if !status.success() {
			return Err(Fault::Storage);
		}
		let remediation = Remediation {
			id:          id.clone(),
			scan_id:     scan_id.clone(),
			finding_ids: finding_ids.into_iter().collect(),
			path:        Str::new(path.to_string_lossy()),
			status:      Str::new_static("ready"),
			created_at:  now_stamp(),
		};
		if let Err(error) = self.mutate(|state| {
			state.remediations.insert(id.clone(), remediation.clone());
			Ok(())
		}) {
			let _ = remove_worktree(&self.root, &path);
			return Err(error);
		}
		Ok(payload(
			Action::RemediationCreate,
			format!("Created isolated remediation workspace {id} at {}.", path.display()),
			json!({"remediation": remediation}),
		))
	}

	fn remediation_status(&self, params: Params) -> Result<Payload, Fault> {
		let id = required(params.remediation_id)?;
		let remediation = self
			.inspect(|state| state.remediations.get(&id).cloned())?
			.ok_or(Fault::NotFound)?;
		Ok(payload(
			Action::RemediationStatus,
			format!(
				"Remediation workspace {id}: {}; path {}; {} finding(s).",
				remediation.status,
				remediation.path,
				remediation.finding_ids.len(),
			),
			json!({"remediation": remediation}),
		))
	}

	fn remediation_cleanup(&self, params: Params) -> Result<Payload, Fault> {
		let id = required(params.remediation_id)?;
		let remediation = self
			.inspect(|state| state.remediations.get(&id).cloned())?
			.ok_or(Fault::NotFound)?;
		remove_worktree(&self.root, Path::new(remediation.path.as_str()))?;
		self.mutate(|state| {
			state.remediations.remove(&id);
			Ok(())
		})?;
		Ok(payload(
			Action::RemediationCleanup,
			format!("Removed remediation workspace {id}."),
			json!({"remediation_id": id, "removed": true}),
		))
	}

	async fn cloud_execute(
		&self,
		params: Params,
		cancellation: CancellationToken,
	) -> Result<Payload, Fault> {
		let cloud = self
			.cloud
			.as_ref()
			.ok_or(Fault::Unavailable)?
			.authorize(params.credential_id)?;
		match params.action {
			Action::CloudScans => {
				let items = cloud.configurations(&cancellation).await?;
				let output = if items.is_empty() {
					"No Codex Security cloud scan configurations are available.".to_owned()
				} else {
					items
						.iter()
						.map(|item| {
							format!(
								"{} {} repo={} environment={} {}",
								item["id"].as_str().unwrap_or("unknown"),
								item["current_step"].as_str().unwrap_or("unknown"),
								item["repository_id"].as_str().unwrap_or("unknown"),
								item["environment_id"].as_str().unwrap_or("unknown"),
								item["repository_url"].as_str().unwrap_or("unknown"),
							)
						})
						.collect::<Vec<_>>()
						.join("\n")
				};
				Ok(payload(Action::CloudScans, output, json!({"configurations": items})))
			},
			Action::CloudStart => {
				let repository_id = required(params.repository_id)?;
				let repository_url = required(params.repository_url)?;
				let environment_id = required(params.environment_id)?;
				let configuration = cloud
					.start(
						&repository_id,
						&repository_url,
						&environment_id,
						params.lookback_days.as_ref(),
						&cancellation,
					)
					.await?;
				let id = configuration
					.get("id")
					.and_then(Value::as_str)
					.ok_or(Fault::Cloud)?;
				Ok(payload(
					Action::CloudStart,
					format!(
						"Codex Security cloud scan {id} started for {repository_url}. This consumes \
						 cloud scan allowance."
					),
					json!({"cloud_scan": configuration}),
				))
			},
			Action::CloudStatus => {
				let id = required(params.cloud_configuration_id)?;
				let stats = cloud.status(&id, &cancellation).await?;
				let step = stats
					.get("current_step")
					.and_then(Value::as_str)
					.unwrap_or("unknown");
				let finished = stats
					.get("finished_commits")
					.and_then(Value::as_u64)
					.unwrap_or_default();
				let pending = stats
					.get("pending_commits")
					.and_then(Value::as_u64)
					.unwrap_or_default();
				let failed = stats
					.get("failed_commits")
					.and_then(Value::as_u64)
					.unwrap_or_default();
				Ok(payload(
					Action::CloudStatus,
					format!(
						"Codex Security cloud scan {id}: {step}; {finished} finished commit(s), \
						 {pending} pending, {failed} failed."
					),
					json!({"cloud_stats": redact_value(stats)}),
				))
			},
			Action::CloudPull => {
				let id = required(params.cloud_configuration_id)?;
				let mut scan = cloud.pull(&id, &self.root, &cancellation).await?;
				scan.sarif = Some(sarif::export(&scan, &self.root));
				let scan_id = scan.id.clone();
				let count = scan.findings.len();
				self.mutate(|state| {
					state.scans.insert(scan_id.clone(), scan);
					Ok(())
				})?;
				Ok(payload(
					Action::CloudPull,
					format!(
						"Imported {count} Codex Security cloud finding(s) as security scan {scan_id}."
					),
					json!({"imported_scan": {"id": scan_id, "finding_count": count}}),
				))
			},
			_ => Err(Fault::InvalidArguments),
		}
	}

	fn mutate(&self, operation: impl FnOnce(&mut State) -> Result<(), Fault>) -> Result<(), Fault> {
		let mut guard = self.state.lock();
		let save = {
			let state = guard.as_mut().map_err(|()| Fault::Storage)?;
			operation(state)?;
			self.store.save(state)
		};
		if let Err(error) = save {
			*guard = Err(());
			return Err(error);
		}
		Ok(())
	}

	fn inspect<T>(&self, operation: impl FnOnce(&State) -> T) -> Result<T, Fault> {
		let guard = self.state.lock();
		let state = guard.as_ref().map_err(|()| Fault::Storage)?;
		Ok(operation(state))
	}

	fn render_resource(&self, resource: &str) -> Result<Vec<u8>, ReadFault> {
		let parts = security_parts(resource)?;
		let guard = self.state.lock();
		let state = guard.as_ref().map_err(|()| security_state_fault())?;
		let mut body = String::new();
		match parts.as_slice() {
			[] => body.push_str(
				"# Security\n\nOMP-owned security plans, scans, findings, provenance, SARIF, and \
				 remediation workspaces. This namespace is read-only; use `dyn security_scan` for \
				 mutations.\n\n- `security://plans`\n- `security://scans`\n- \
				 `security://remediations`\n",
			),
			["plans"] => {
				body.push_str("# Security plans\n\n");
				for plan in state.plans.values().rev() {
					let _ = writeln!(
						body,
						"- `{}` — {:?}; fingerprint {}",
						plan.id, plan.target, plan.fingerprint
					);
				}
			},
			["plans", plan_id] => {
				body = serde_json::to_string_pretty(
					state
						.plans
						.get(*plan_id)
						.ok_or_else(|| unknown_resource(resource))?,
				)
				.map_err(|_| security_state_fault())?
			},
			["scans"] => {
				body.push_str("# Security scans\n\n");
				for scan in state.scans.values().rev() {
					let _ = writeln!(
						body,
						"- `{}` — {}; {} finding(s); producer {}",
						scan.id,
						scan.status,
						scan.findings.len(),
						sanitize_text(&scan.producer.name)
					);
				}
			},
			["scans", scan_id] => {
				let scan = state
					.scans
					.get(*scan_id)
					.ok_or_else(|| unknown_scan(scan_id))?;
				let _ = writeln!(
					body,
					"# Security scan {}\n\n- Status: **{}**\n- Findings: **{}**\n- Producer: \
					 **{}**\n\nResources: `manifest`, `findings`, `report`, `sarif`, and `provenance`.",
					scan.id,
					scan.status,
					scan.findings.len(),
					sanitize_text(&scan.producer.name)
				);
			},
			["scans", scan_id, "manifest"] => {
				body = serde_json::to_string_pretty(&public_scan(
					state
						.scans
						.get(*scan_id)
						.ok_or_else(|| unknown_scan(scan_id))?,
				))
				.map_err(|_| security_state_fault())?
			},
			["scans", scan_id, "findings"] => render_findings_index(
				&mut body,
				state
					.scans
					.get(*scan_id)
					.ok_or_else(|| unknown_scan(scan_id))?,
			),
			["scans", scan_id, "findings", finding_id] => {
				let scan = state
					.scans
					.get(*scan_id)
					.ok_or_else(|| unknown_scan(scan_id))?;
				let finding = scan
					.findings
					.iter()
					.find(|finding| finding.id == *finding_id)
					.ok_or_else(|| unknown_finding(finding_id))?;
				render_finding(&mut body, finding);
			},
			["scans", scan_id, "report"] => {
				body = sanitize_text(
					state
						.scans
						.get(*scan_id)
						.ok_or_else(|| unknown_scan(scan_id))?
						.report
						.as_deref()
						.unwrap_or("No report was retained."),
				)
			},
			["scans", scan_id, "sarif"] => {
				body = serde_json::to_string_pretty(&sarif::export(
					state
						.scans
						.get(*scan_id)
						.ok_or_else(|| unknown_scan(scan_id))?,
					&self.root,
				))
				.map_err(|_| security_state_fault())?
			},
			["scans", scan_id, "provenance"] => {
				body = serde_json::to_string_pretty(&redact_value(json!(
					state
						.scans
						.get(*scan_id)
						.ok_or_else(|| unknown_scan(scan_id))?
						.provenance
				)))
				.map_err(|_| security_state_fault())?
			},
			["remediations"] => {
				body.push_str("# Security remediation workspaces\n\n");
				for remediation in state.remediations.values() {
					let _ = writeln!(
						body,
						"- `{}` — {}; {} finding(s)",
						remediation.id,
						remediation.status,
						remediation.finding_ids.len()
					);
				}
			},
			["remediations", id] => {
				let remediation = state
					.remediations
					.get(*id)
					.ok_or_else(|| unknown_resource(resource))?;
				body = serde_json::to_string_pretty(remediation).map_err(|_| security_state_fault())?;
			},
			_ => return Err(unknown_resource(resource)),
		}
		body.push('\n');
		Ok(body.into_bytes())
	}

	fn list_resource(
		&self,
		resource: &str,
		max_entries: usize,
		max_bytes: usize,
	) -> Result<ResourceList, ReadFault> {
		let parts = security_parts(resource)?;
		let guard = self.state.lock();
		let state = guard.as_ref().map_err(|()| security_state_fault())?;
		let mut candidates = Vec::new();
		match parts.as_slice() {
			[] => {
				candidates.push(security_entry("plans", true, "plans"));
				candidates.push(security_entry("scans", true, "scans"));
				candidates.push(security_entry("remediations", true, "remediations"));
			},
			["plans"] => {
				for plan in state.plans.values() {
					candidates.push(security_entry(&format!("plans/{}", plan.id), false, &plan.id));
				}
			},
			["scans"] => {
				for scan in state.scans.values() {
					candidates.push(security_entry(&format!("scans/{}", scan.id), true, &scan.id));
				}
			},
			["scans", scan_id] => {
				if !state.scans.contains_key(*scan_id) {
					return Err(unknown_scan(scan_id));
				}
				for (name, directory) in [
					("manifest", false),
					("findings", true),
					("report", false),
					("sarif", false),
					("provenance", false),
				] {
					candidates.push(security_entry(&format!("scans/{scan_id}/{name}"), directory, name));
				}
			},
			["scans", scan_id, "findings"] => {
				for finding in &state
					.scans
					.get(*scan_id)
					.ok_or_else(|| unknown_scan(scan_id))?
					.findings
				{
					candidates.push(security_entry(
						&format!("scans/{scan_id}/findings/{}", finding.id),
						false,
						&finding.id,
					));
				}
			},
			["remediations"] => {
				for remediation in state.remediations.values() {
					candidates.push(security_entry(
						&format!("remediations/{}", remediation.id),
						false,
						&remediation.id,
					));
				}
			},
			_ => return Err(unknown_resource(resource)),
		}
		bounded_entries(candidates, max_entries, max_bytes)
	}

	fn complete_resource(
		&self,
		query: &str,
		max_results: usize,
	) -> Result<Vec<ResourceCompletion>, ReadFault> {
		let guard = self.state.lock();
		let state = guard.as_ref().map_err(|()| security_state_fault())?;
		let mut paths = vec![
			("plans".to_owned(), Str::new_static("frozen security plans")),
			("scans".to_owned(), Str::new_static("stored security scans")),
			("remediations".to_owned(), Str::new_static("isolated remediation workspaces")),
		];
		for plan in state.plans.values() {
			paths.push((format!("plans/{}", plan.id), plan.fingerprint.clone()));
		}
		for scan in state.scans.values() {
			let prefix = format!("scans/{}", scan.id);
			paths.push((
				prefix.clone(),
				Str::new(format!("{}; {} finding(s)", scan.status, scan.findings.len())),
			));
			for child in ["manifest", "findings", "report", "sarif", "provenance"] {
				paths.push((format!("{prefix}/{child}"), Str::new_static("security scan resource")));
			}
			for finding in &scan.findings {
				paths.push((format!("{prefix}/findings/{}", finding.id), finding.summary.clone()));
			}
		}
		for remediation in state.remediations.values() {
			paths.push((format!("remediations/{}", remediation.id), remediation.status.clone()));
		}
		let query = query
			.trim()
			.strip_prefix("security://")
			.unwrap_or(query.trim())
			.trim_start_matches('/');
		let mut matches = paths
			.into_iter()
			.filter_map(|(path, description)| {
				Some(ResourceCompletion {
					value: Str::new(format!("security://{path}")),
					description,
					score: fuzzy_score(query, &path)?,
				})
			})
			.collect::<Vec<_>>();
		matches.sort_unstable_by(|left, right| {
			right
				.score
				.cmp(&left.score)
				.then_with(|| left.value.cmp(&right.value))
		});
		matches.truncate(max_results);
		Ok(matches)
	}
}

impl SecurityScanControl for SecurityScanService {
	fn execute(
		&self,
		params: Params,
		cancellation: CancellationToken,
	) -> impl Future<Output = Result<Payload, Fault>> + Send + '_ {
		async move {
			match params.action {
				Action::Start => self.start(params, cancellation).await,
				Action::CloudScans | Action::CloudStart | Action::CloudStatus | Action::CloudPull => {
					self.cloud_execute(params, cancellation).await
				},
				_ => {
					if cancellation.is_cancelled() {
						Err(Fault::Unavailable)
					} else {
						self.execute_local(params)
					}
				},
			}
		}
	}
}

impl Resolve for SecurityScanService {
	async fn read<'a>(
		&'a self,
		resource: &'a str,
		selector: &'a ParsedSelector,
	) -> Result<CowBytes<'static>, ReadFault> {
		let bytes = self.render_resource(resource)?;
		crate::tool_url::select_bytes(&self.lines, resource, CowBytes::from(bytes), selector)
	}

	async fn list(
		&self,
		resource: &str,
		max_entries: usize,
		max_bytes: usize,
	) -> Result<ResourceList, ReadFault> {
		self.list_resource(resource, max_entries, max_bytes)
	}

	async fn complete(
		&self,
		query: &str,
		max_results: usize,
	) -> Result<Vec<ResourceCompletion>, ReadFault> {
		self.complete_resource(query, max_results)
	}
}

fn scan_target(
	root: &Path,
	store_root: &Path,
	plan: &Plan,
	cancellation: &CancellationToken,
) -> Result<Vec<Finding>, Fault> {
	let mut temporary = None;
	let scan_root = if plan.target == TargetKind::RefDiff {
		let head = plan
			.head_revision
			.as_deref()
			.ok_or(Fault::InvalidArguments)?;
		let path = store_root
			.join("targets")
			.join(format!("scan-{}", unique_material()));
		fs::create_dir_all(path.parent().ok_or(Fault::Storage)?).map_err(|_| Fault::Storage)?;
		let status = Command::new("git")
			.args([
				"-C",
				root.to_string_lossy().as_ref(),
				"worktree",
				"add",
				"--detach",
				path.to_string_lossy().as_ref(),
				head,
			])
			.status()
			.map_err(|_| Fault::Storage)?;
		if !status.success() {
			return Err(Fault::Storage);
		}
		temporary = Some(path.clone());
		path
	} else {
		root.to_path_buf()
	};
	let allowed = target_paths(root, plan)?;
	let result = scan_workspace(&scan_root, plan, allowed.as_ref(), cancellation);
	if let Some(path) = temporary {
		let _ = remove_worktree(root, &path);
	}
	result
}

fn scan_workspace(
	root: &Path,
	plan: &Plan,
	allowed: Option<&BTreeSet<PathBuf>>,
	cancellation: &CancellationToken,
) -> Result<Vec<Finding>, Fault> {
	let mut paths = Vec::new();
	collect_files(root, root, &mut paths, cancellation)?;
	let producer = native_producer();
	let mut findings = Vec::new();
	for path in paths.into_iter().take(MAX_FILES) {
		if cancellation.is_cancelled() {
			return Err(Fault::Unavailable);
		}
		let relative = path.strip_prefix(root).map_err(|_| Fault::Storage)?;
		if allowed.is_some_and(|allowed| !allowed.contains(relative)) {
			continue;
		}
		if !plan.include_paths.is_empty()
			&& !plan
				.include_paths
				.iter()
				.any(|include| relative.starts_with(include.as_str()))
		{
			continue;
		}
		if plan
			.exclude_paths
			.iter()
			.any(|exclude| relative.starts_with(exclude.as_str()))
		{
			continue;
		}
		let metadata = fs::metadata(&path).map_err(|_| Fault::Storage)?;
		if metadata.len() > MAX_FILE_BYTES {
			continue;
		}
		let bytes = fs::read(&path).map_err(|_| Fault::Storage)?;
		let Ok(text) = std::str::from_utf8(&bytes) else {
			continue;
		};
		for (index, line) in text.lines().enumerate() {
			let rule = if line.contains("-----BEGIN PRIVATE KEY-----") {
				Some((
					"private-key",
					"Private key material is committed to the repository",
					"critical",
					"Remove and rotate the private key.",
				))
			} else if contains_aws_access_key(line) {
				Some((
					"aws-access-key",
					"AWS access key identifier is committed to the repository",
					"high",
					"Remove and rotate the AWS credential.",
				))
			} else {
				None
			};
			let Some((rule_id, summary, severity, remediation)) = rule else {
				continue;
			};
			let normalized = relative.to_string_lossy().replace('\\', "/");
			let location = Location {
				path:         Str::new(normalized.as_str()),
				start_line:   (index + 1) as u64,
				end_line:     None,
				start_column: None,
				end_column:   None,
				role:         Some(Str::new_static("primary")),
			};
			let fingerprint = Str::new(format!(
				"omp-security/v1:sha256:{}",
				Hash32::sum(format!("{rule_id}:{normalized}:{}", index + 1).as_bytes()).to_hex()
			));
			let digest = Hash32::sum(fingerprint.as_bytes()).to_hex();
			let provenance = Provenance {
				producer:            producer.clone(),
				created_at:          now_stamp(),
				imported_at:         None,
				source_ids:          BTreeMap::new(),
				vendor_fingerprints: BTreeMap::new(),
				metadata:            BTreeMap::from([
					(Str::new_static("plan_fingerprint"), Value::String(plan.fingerprint.to_string())),
					(
						Str::new_static("workflow_fingerprint"),
						Value::String(plan.workflow_fingerprint.to_string()),
					),
				]),
			};
			findings.push(Finding {
				id: Str::new(format!("secf_{}", &digest[..24])),
				scan_id: Str::default(),
				fingerprint,
				rule_id: Str::new_static(rule_id),
				title: Str::new_static(summary),
				summary: Str::new_static(summary),
				severity: Str::new_static(severity),
				confidence: Str::new_static("high"),
				category: Str::new_static("secrets"),
				cwe: vec![Str::new_static("CWE-798")],
				locations: vec![location],
				evidence: Vec::<Evidence>::new(),
				remediation: Some(Str::new_static(remediation)),
				validation: Validation {
					status:       ValidationStatus::Unvalidated,
					summary:      None,
					evidence_ids: Vec::new(),
					validated_at: None,
				},
				disposition: Str::new_static("open"),
				provenance,
			});
		}
	}
	Ok(findings)
}

fn compare_lineage(before: &Scan, after: &Scan) -> Value {
	let mut used_after = BTreeSet::new();
	let mut matches = Vec::new();
	for finding in &before.findings {
		let exact = after
			.findings
			.iter()
			.find(|candidate| candidate.fingerprint == finding.fingerprint);
		let rule_location = exact.or_else(|| {
			after.findings.iter().find(|candidate| {
				!used_after.contains(&candidate.id)
					&& candidate.rule_id.eq_ignore_ascii_case(&finding.rule_id)
					&& same_primary_location(finding, candidate)
			})
		});
		let taxonomy_location = rule_location.or_else(|| {
			let candidates = after
				.findings
				.iter()
				.filter(|candidate| {
					!used_after.contains(&candidate.id) && taxonomy_location_match(finding, candidate)
				})
				.collect::<Vec<_>>();
			(candidates.len() == 1).then_some(candidates[0])
		});
		if let Some(candidate) = taxonomy_location {
			used_after.insert(candidate.id.clone());
			let basis = if candidate.fingerprint == finding.fingerprint {
				"fingerprint"
			} else if candidate.rule_id.eq_ignore_ascii_case(&finding.rule_id)
				&& same_primary_location(finding, candidate)
			{
				"rule_location"
			} else {
				"taxonomy_location"
			};
			matches.push(json!({
				"before_finding_id": finding.id,
				"after_finding_id": candidate.id,
				"fingerprint": finding.fingerprint,
				"status": "unchanged",
				"match_basis": basis,
			}));
		} else {
			matches.push(json!({
				"before_finding_id": finding.id,
				"fingerprint": finding.fingerprint,
				"status": "resolved",
			}));
		}
	}
	for finding in &after.findings {
		if !used_after.contains(&finding.id) {
			matches.push(json!({
				"after_finding_id": finding.id,
				"fingerprint": finding.fingerprint,
				"status": "new",
			}));
		}
	}
	let unchanged = matches
		.iter()
		.filter(|entry| entry["status"] == "unchanged")
		.count();
	let resolved = matches
		.iter()
		.filter(|entry| entry["status"] == "resolved")
		.count();
	let introduced = matches
		.iter()
		.filter(|entry| entry["status"] == "new")
		.count();
	json!({
		"before_scan_id": before.id,
		"after_scan_id": after.id,
		"matches": matches,
		"unchanged": unchanged,
		"introduced": introduced,
		"resolved": resolved,
	})
}

fn same_primary_location(left: &Finding, right: &Finding) -> bool {
	match (left.locations.first(), right.locations.first()) {
		(Some(left), Some(right)) => {
			left.path.eq_ignore_ascii_case(&right.path) && left.start_line == right.start_line
		},
		_ => false,
	}
}

fn taxonomy_location_match(left: &Finding, right: &Finding) -> bool {
	if !left.cwe.iter().any(|left| {
		right
			.cwe
			.iter()
			.any(|right| left.eq_ignore_ascii_case(right))
	}) {
		return false;
	}
	left.locations.iter().any(|left| {
		right.locations.iter().any(|right| {
			left.path.eq_ignore_ascii_case(&right.path)
				&& left.start_line.abs_diff(right.start_line) <= 3
		})
	})
}

fn target_paths(root: &Path, plan: &Plan) -> Result<Option<BTreeSet<PathBuf>>, Fault> {
	let args: Option<Vec<&str>> = match plan.target {
		TargetKind::WorkingTree => Some(vec!["diff", "--name-only", "HEAD"]),
		TargetKind::RefDiff => Some(vec![
			"diff",
			"--name-only",
			plan
				.base_revision
				.as_deref()
				.ok_or(Fault::InvalidArguments)?,
			plan
				.head_revision
				.as_deref()
				.ok_or(Fault::InvalidArguments)?,
		]),
		_ => None,
	};
	let Some(args) = args else { return Ok(None) };
	let output = Command::new("git")
		.arg("-C")
		.arg(root)
		.args(args)
		.output()
		.map_err(|_| Fault::Storage)?;
	if !output.status.success() || output.stdout.len() > MAX_STATUS_BYTES {
		return Err(Fault::Storage);
	}
	let text = std::str::from_utf8(&output.stdout).map_err(|_| Fault::Storage)?;
	let mut paths = text
		.lines()
		.filter(|line| !line.is_empty())
		.map(PathBuf::from)
		.collect::<BTreeSet<_>>();
	if plan.target == TargetKind::WorkingTree {
		paths.extend(untracked_paths(root)?);
	}
	Ok(Some(paths))
}

fn tree_digest(
	root: &Path,
	target: TargetKind,
	base: Option<&str>,
	head: Option<&str>,
) -> Result<Str, Fault> {
	let head_output = Command::new("git")
		.arg("-C")
		.arg(root)
		.args(["rev-parse", "HEAD"])
		.output()
		.map_err(|_| Fault::Storage)?;
	if !head_output.status.success() {
		return Err(Fault::Storage);
	}
	let mut material = head_output.stdout;
	if target == TargetKind::RefDiff {
		material.extend_from_slice(base.ok_or(Fault::InvalidArguments)?.as_bytes());
		material.extend_from_slice(head.ok_or(Fault::InvalidArguments)?.as_bytes());
	} else {
		let status = Command::new("git")
			.arg("-C")
			.arg(root)
			.args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
			.output()
			.map_err(|_| Fault::Storage)?;
		if !status.status.success() || status.stdout.len() > MAX_STATUS_BYTES {
			return Err(Fault::Storage);
		}
		material.extend_from_slice(&status.stdout);
		for path in status_paths(&status.stdout) {
			let full = root.join(&path);
			if !full.is_file() {
				continue;
			}
			let metadata = fs::metadata(&full).map_err(|_| Fault::Storage)?;
			if metadata.len() > MAX_FILE_BYTES {
				continue;
			}
			material.extend_from_slice(path.to_string_lossy().as_bytes());
			material.extend_from_slice(&fs::read(full).map_err(|_| Fault::Storage)?);
		}
	}
	Ok(Str::new(Hash32::sum(&material).to_hex().as_str()))
}

fn status_paths(status: &[u8]) -> BTreeSet<PathBuf> {
	status
		.split(|byte| *byte == 0)
		.filter_map(|entry| {
			let path = entry.get(3..)?;
			(!path.is_empty()).then(|| PathBuf::from(String::from_utf8_lossy(path).as_ref()))
		})
		.collect()
}

fn untracked_paths(root: &Path) -> Result<BTreeSet<PathBuf>, Fault> {
	let output = Command::new("git")
		.arg("-C")
		.arg(root)
		.args(["ls-files", "--others", "--exclude-standard"])
		.output()
		.map_err(|_| Fault::Storage)?;
	if !output.status.success() || output.stdout.len() > MAX_STATUS_BYTES {
		return Err(Fault::Storage);
	}
	let text = std::str::from_utf8(&output.stdout).map_err(|_| Fault::Storage)?;
	Ok(text
		.lines()
		.filter(|line| !line.is_empty())
		.map(PathBuf::from)
		.collect())
}

fn resolve_revision(root: &Path, revision: Str) -> Result<Str, Fault> {
	let output = Command::new("git")
		.args([
			"-C",
			root.to_string_lossy().as_ref(),
			"rev-parse",
			"--verify",
			&format!("{revision}^{{commit}}"),
		])
		.output()
		.map_err(|_| Fault::Storage)?;
	if !output.status.success() {
		return Err(Fault::InvalidArguments);
	}
	let value = std::str::from_utf8(&output.stdout)
		.map_err(|_| Fault::Storage)?
		.trim();
	if value.is_empty() {
		Err(Fault::InvalidArguments)
	} else {
		Ok(Str::new(value))
	}
}
fn knowledge_bases(root: &Path, paths: Vec<Str>) -> Result<Vec<KnowledgeBase>, Fault> {
	paths
		.into_iter()
		.map(|path| {
			let full = workspace_path(root, &path, true)?;
			let bytes = fs::read(&full).map_err(|_| Fault::Storage)?;
			Ok(KnowledgeBase {
				path,
				sha256: Str::new(Hash32::sum(&bytes).to_hex().as_str()),
				size: bytes.len() as u64,
			})
		})
		.collect()
}
fn validate_output_root(root: &Path, relative: &str, archive: bool) -> Result<(), Fault> {
	let output = workspace_path(root, relative, false)?;
	if !output.exists() {
		return Ok(());
	}
	let metadata = output.symlink_metadata().map_err(|_| Fault::Storage)?;
	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err(Fault::InvalidArguments);
	}
	if !archive
		&& output
			.read_dir()
			.map_err(|_| Fault::Storage)?
			.next()
			.is_some()
	{
		return Err(Fault::InvalidArguments);
	}
	Ok(())
}

fn export_directory(root: &Path, relative: &str, archive: bool, scan: &Scan) -> Result<(), Fault> {
	let output = workspace_path(root, relative, false)?;
	if output.exists() {
		if output
			.symlink_metadata()
			.map_err(|_| Fault::Storage)?
			.file_type()
			.is_symlink()
		{
			return Err(Fault::InvalidArguments);
		}
		let nonempty = output
			.read_dir()
			.map_err(|_| Fault::Storage)?
			.next()
			.is_some();
		if nonempty {
			if !archive {
				return Err(Fault::InvalidArguments);
			}
			fs::rename(&output, output.with_extension(format!("archive-{}", unique_material())))
				.map_err(|_| Fault::Storage)?;
		}
	}
	fs::create_dir_all(&output).map_err(|_| Fault::Storage)?;
	write_json_atomic(&output.join("scan.json"), &public_scan(scan))?;
	write_json_atomic(&output.join("findings.json"), &scan.findings)?;
	write_json_atomic(&output.join("provenance.json"), &redact_value(json!(scan.provenance)))?;
	write_json_atomic(&output.join("results.sarif"), &sarif::export(scan, root))?;
	if let Some(report) = &scan.report {
		store::write_bytes_atomic(&output.join("report.md"), report.as_bytes())?;
	}
	Ok(())
}
fn ensure_clean_repository(root: &Path) -> Result<(), Fault> {
	let output = Command::new("git")
		.args([
			"-C",
			root.to_string_lossy().as_ref(),
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
		])
		.output()
		.map_err(|_| Fault::Storage)?;
	if !output.status.success() || !output.stdout.is_empty() {
		Err(Fault::InvalidArguments)
	} else {
		Ok(())
	}
}
fn remove_worktree(root: &Path, path: &Path) -> Result<(), Fault> {
	let status = Command::new("git")
		.args([
			"-C",
			root.to_string_lossy().as_ref(),
			"worktree",
			"remove",
			"--force",
			path.to_string_lossy().as_ref(),
		])
		.status()
		.map_err(|_| Fault::Storage)?;
	if status.success() {
		Ok(())
	} else {
		Err(Fault::Storage)
	}
}
fn collect_files(
	root: &Path,
	directory: &Path,
	paths: &mut Vec<PathBuf>,
	cancellation: &CancellationToken,
) -> Result<(), Fault> {
	if cancellation.is_cancelled() {
		return Err(Fault::Unavailable);
	}
	for entry in fs::read_dir(directory).map_err(|_| Fault::Storage)? {
		let entry = entry.map_err(|_| Fault::Storage)?;
		let path = entry.path();
		let relative = path.strip_prefix(root).map_err(|_| Fault::Storage)?;
		if relative.starts_with(".git") || relative.starts_with("target") {
			continue;
		}
		let kind = entry.file_type().map_err(|_| Fault::Storage)?;
		if kind.is_symlink() {
			continue;
		}
		if kind.is_dir() {
			collect_files(root, &path, paths, cancellation)?;
		} else if kind.is_file() {
			paths.push(path);
		}
		if paths.len() >= MAX_FILES {
			break;
		}
	}
	Ok(())
}
fn contains_aws_access_key(line: &str) -> bool {
	line.as_bytes().windows(20).any(|window| {
		window.starts_with(b"AKIA")
			&& window[4..]
				.iter()
				.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
	})
}
fn native_producer() -> Producer {
	Producer {
		kind:    Str::new_static("omp-native"),
		name:    Str::new_static("OMP Native Security"),
		version: Some(Str::new_static("2.0.0")),
		vendor:  None,
	}
}
fn native_provenance(plan: &Plan, operation: &str, producer: &Producer) -> Provenance {
	Provenance {
		producer:            producer.clone(),
		created_at:          now_stamp(),
		imported_at:         None,
		source_ids:          BTreeMap::from([(Str::new_static("operation_id"), Str::new(operation))]),
		vendor_fingerprints: BTreeMap::new(),
		metadata:            BTreeMap::from([
			(Str::new_static("plan_fingerprint"), Value::String(plan.fingerprint.to_string())),
			(
				Str::new_static("workflow_fingerprint"),
				Value::String(plan.workflow_fingerprint.to_string()),
			),
		]),
	}
}
fn render_report(scan: &Scan) -> Str {
	let mut body = format!("# Security report {}\n\nFindings: {}\n\n", scan.id, scan.findings.len());
	for finding in &scan.findings {
		let _ = writeln!(
			body,
			"- **{}** `{}` [{}] — {}",
			finding.severity,
			sanitize_text(&finding.rule_id),
			enum_json(finding.validation.status),
			sanitize_text(&finding.summary),
		);
	}
	Str::new(body)
}
fn render_findings_index(body: &mut String, scan: &Scan) {
	let _ = writeln!(body, "# Findings for {}\n", scan.id);
	for finding in &scan.findings {
		let location = finding.locations.first();
		let suffix = location
			.map(|location| format!(" (`{}:{}`)", sanitize_text(&location.path), location.start_line))
			.unwrap_or_default();
		let _ = writeln!(
			body,
			"- `{}` **{}** — {}{}",
			finding.id,
			sanitize_text(&finding.rule_id),
			sanitize_text(&finding.summary),
			suffix,
		);
	}
	if scan.findings.is_empty() {
		body.push_str("No findings.\n");
	}
}
fn render_finding(body: &mut String, finding: &Finding) {
	let _ = writeln!(
		body,
		"## {}\n\n- ID: `{}`\n- Rule: `{}`\n- Severity: **{}**\n- Validation: **{}**",
		sanitize_text(&finding.title),
		finding.id,
		sanitize_text(&finding.rule_id),
		finding.severity,
		enum_json(finding.validation.status),
	);
	for location in &finding.locations {
		let _ =
			writeln!(body, "- Location: `{}:{}`", sanitize_text(&location.path), location.start_line,);
	}
	let _ = writeln!(body, "\n{}\n", sanitize_text(&finding.summary));
	if let Some(summary) = &finding.validation.summary {
		let _ = writeln!(body, "### Validation\n\n{}\n", sanitize_text(summary));
	}
	if !finding.validation.evidence_ids.is_empty() {
		let _ = writeln!(
			body,
			"Validation evidence: {}\n",
			finding
				.validation
				.evidence_ids
				.iter()
				.map(Str::as_str)
				.collect::<Vec<_>>()
				.join(", "),
		);
	}
	if !finding.evidence.is_empty() {
		body.push_str("### Evidence\n\n");
		for evidence in &finding.evidence {
			let _ = writeln!(
				body,
				"- **{}** — {}",
				sanitize_text(&evidence.label),
				sanitize_text(&evidence.explanation),
			);
		}
		body.push('\n');
	}
	if let Some(remediation) = &finding.remediation {
		let _ = writeln!(body, "### Remediation\n\n{}\n", sanitize_text(remediation));
	}
}
fn sanitize_text(value: &str) -> String {
	let mut output = String::new();
	let mut chars = value.chars().peekable();
	while let Some(character) = chars.next() {
		if character == '\u{1b}' {
			if chars.peek() == Some(&'[') {
				chars.next();
				for next in chars.by_ref() {
					if ('@'..='~').contains(&next) {
						break;
					}
				}
			}
			continue;
		}
		if !character.is_control() || matches!(character, '\n' | '\t') {
			output.push(character);
		}
	}
	output
}
fn enum_json<T: serde::Serialize>(value: T) -> String {
	serde_json::to_value(value)
		.ok()
		.and_then(|value| value.as_str().map(str::to_owned))
		.unwrap_or_else(|| "unknown".to_owned())
}
fn payload(action: Action, output: String, data: Value) -> Payload {
	Payload { action, output: Str::new(output), data: redact_value(data) }
}
pub(super) fn now_stamp() -> Str {
	Str::new(
		SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map_or(0, |duration| duration.as_millis())
			.to_string(),
	)
}
fn unique_material() -> String {
	Ulid::generate().to_string()
}
fn required(value: Option<Str>) -> Result<Str, Fault> {
	value
		.filter(|value| !value.trim().is_empty())
		.map(|value| Str::new(value.trim()))
		.ok_or(Fault::InvalidArguments)
}
fn clean_paths(paths: Vec<Str>) -> Result<Vec<Str>, Fault> {
	let unique = paths
		.into_iter()
		.map(|path| {
			let trimmed = path.trim();
			let normalized = trimmed.trim_start_matches("./");
			checked_relative(normalized)?;
			Ok(Str::new(normalized))
		})
		.collect::<Result<BTreeSet<_>, Fault>>()?;
	Ok(unique.into_iter().collect())
}
fn checked_relative(path: &str) -> Result<&Path, Fault> {
	let candidate = Path::new(path);
	if path.contains('\\')
		|| candidate.as_os_str().is_empty()
		|| candidate.is_absolute()
		|| candidate.components().any(|component| {
			matches!(
				component,
				std::path::Component::ParentDir
					| std::path::Component::RootDir
					| std::path::Component::Prefix(_)
			) || matches!(component, std::path::Component::Normal(name) if name == ".git")
		}) {
		Err(Fault::InvalidArguments)
	} else {
		Ok(candidate)
	}
}
fn workspace_path(root: &Path, path: &str, must_exist: bool) -> Result<PathBuf, Fault> {
	let relative = checked_relative(path)?;
	let candidate = root.join(relative);
	let parent = if must_exist {
		candidate.as_path()
	} else {
		candidate.parent().ok_or(Fault::InvalidArguments)?
	};
	let canonical_parent = if parent.exists() {
		parent.canonicalize().map_err(|_| Fault::Storage)?
	} else {
		let mut ancestor = parent;
		while !ancestor.exists() {
			ancestor = ancestor.parent().ok_or(Fault::InvalidArguments)?;
		}
		ancestor.canonicalize().map_err(|_| Fault::Storage)?
	};
	if !canonical_parent.starts_with(root) {
		return Err(Fault::InvalidArguments);
	}
	if must_exist
		&& (!candidate.exists()
			|| candidate
				.symlink_metadata()
				.map_err(|_| Fault::Storage)?
				.file_type()
				.is_symlink())
	{
		return Err(Fault::InvalidArguments);
	}
	Ok(candidate)
}
fn relative_display(root: &Path, path: &Path) -> String {
	path
		.strip_prefix(root)
		.unwrap_or(path)
		.to_string_lossy()
		.into_owned()
}
fn valid_remediation_id(value: &str) -> bool {
	value.starts_with("security-remediation-")
		&& value
			.chars()
			.all(|character| character.is_ascii_alphanumeric() || character == '-')
}
fn security_parts(resource: &str) -> Result<Vec<&str>, ReadFault> {
	let resource = resource.trim_matches('/');
	if resource.is_empty() {
		return Ok(Vec::new());
	}
	let parts = resource.split('/').collect::<Vec<_>>();
	if parts
		.iter()
		.any(|part| part.is_empty() || matches!(*part, "." | "..") || part.contains('\\'))
	{
		return Err(ReadFault::Invalid {
			message: Str::new_static("Invalid or escaping security:// resource."),
		});
	}
	Ok(parts)
}
fn security_state_fault() -> ReadFault {
	ReadFault::Source {
		message: Str::new_static("Stored security scan state is corrupt or unavailable."),
	}
}
fn unknown_scan(scan_id: &str) -> ReadFault {
	ReadFault::Source {
		message: Str::new(format!(
			"Unknown security scan: {scan_id}. Read security://scans to list stored scans."
		)),
	}
}
fn unknown_finding(finding_id: &str) -> ReadFault {
	ReadFault::Source { message: Str::new(format!("Unknown security finding: {finding_id}.")) }
}
fn unknown_resource(resource: &str) -> ReadFault {
	ReadFault::Source {
		message: Str::new(format!(
			"Unknown security resource: security://{}. Read security:// for the index.",
			resource.trim_matches('/')
		)),
	}
}
fn security_entry(path: &str, directory: bool, name: &str) -> ResourceEntry {
	ResourceEntry {
		uri: Str::new(format!("security://{path}{}", if directory { "/" } else { "" })),
		name: Str::new(name),
		directory,
		size: 0,
	}
}
fn bounded_entries(
	candidates: Vec<ResourceEntry>,
	max_entries: usize,
	max_bytes: usize,
) -> Result<ResourceList, ReadFault> {
	let mut entries = Vec::new();
	let mut used = 0usize;
	let mut truncated = false;
	for entry in candidates {
		let bytes = entry.uri.len().saturating_add(entry.name.len());
		if entries.len() == max_entries || used.saturating_add(bytes) > max_bytes {
			truncated = true;
			break;
		}
		used += bytes;
		entries.push(entry);
	}
	Ok(ResourceList { entries, truncated })
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use super::*;

	fn fixture() -> (PathBuf, PathBuf) {
		let unique = unique_material();
		let root = std::env::temp_dir().join(format!("omp-security-{unique}"));
		let state = std::env::temp_dir().join(format!("omp-security-state-{unique}"));
		fs::create_dir_all(&root).expect("fixture root");
		let initialized = Command::new("git")
			.args(["init", "-q"])
			.current_dir(&root)
			.status()
			.expect("git init");
		assert!(initialized.success());
		Command::new("git")
			.args(["config", "user.email", "security@example.invalid"])
			.current_dir(&root)
			.status()
			.expect("git config");
		Command::new("git")
			.args(["config", "user.name", "Security Test"])
			.current_dir(&root)
			.status()
			.expect("git config");
		fs::write(root.join("README"), "fixture\n").expect("readme");
		Command::new("git")
			.args(["add", "."])
			.current_dir(&root)
			.status()
			.expect("git add");
		Command::new("git")
			.args(["commit", "-qm", "fixture"])
			.current_dir(&root)
			.status()
			.expect("git commit");
		(root, state)
	}
	fn empty(action: Action) -> Params {
		serde_json::from_value(json!({"action": action})).expect("params")
	}
	async fn wait(service: &SecurityScanService, operation_id: &str) -> Operation {
		for _ in 0..100 {
			let operation = service
				.inspect(|state| state.operations.get(operation_id).cloned())
				.expect("state")
				.expect("operation");
			if !matches!(operation.phase.as_str(), "queued" | "running") {
				return operation;
			}
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
		panic!("security operation did not settle")
	}

	#[tokio::test]
	async fn local_plan_run_validation_sarif_export_and_lineage_are_durable() {
		let (root, state_dir) = fixture();
		fs::write(root.join("leak.txt"), "-----BEGIN PRIVATE KEY-----\n").expect("leak");
		let service = SecurityScanService::new(root.clone(), &state_dir);
		let preflight = service
			.preflight(Params {
				action: Action::Preflight,
				target_kind: Some(TargetKind::Repository),
				..empty(Action::Preflight)
			})
			.expect("preflight");
		let plan_id = preflight.data["plan"]["id"].as_str().expect("plan");
		let started = service
			.start(
				Params { plan_id: Some(Str::new(plan_id)), ..empty(Action::Start) },
				CancellationToken::new(),
			)
			.await
			.expect("start");
		let operation_id = started.data["operation"]["id"]
			.as_str()
			.expect("operation")
			.to_owned();
		let operation = wait(&service, &operation_id).await;
		assert_eq!(operation.phase, "completed");
		assert_eq!(operation.finding_count, 1);
		let scan = service
			.inspect(|state| state.scans.get(&operation.scan_id).cloned())
			.expect("state")
			.expect("scan");
		let finding_id = scan.findings[0].id.clone();
		service
			.validate(Params {
				scan_id: Some(scan.id.clone()),
				finding_id: Some(finding_id.clone()),
				validation_status: Some(ValidationStatus::Validated),
				validation_summary: Some(Str::new_static("confirmed")),
				validation_evidence: Some(vec![omp_tools::security_scan::ValidationEvidence {
					label:       Str::new_static("review"),
					explanation: Str::new_static("manual confirmation"),
				}]),
				..empty(Action::Validate)
			})
			.expect("validate");
		service
			.export_sarif(Params {
				scan_id: Some(scan.id.clone()),
				output_path: Some(Str::new_static("result.sarif")),
				..empty(Action::ExportSarif)
			})
			.expect("export");
		let imported = service
			.import_sarif(Params {
				input_path: Some(Str::new_static("result.sarif")),
				..empty(Action::ImportSarif)
			})
			.expect("import");
		assert_eq!(imported.data["scan"]["finding_count"], 1);
		let imported_id = Str::new(imported.data["scan"]["id"].as_str().expect("imported id"));
		let lineage = service
			.lineage(Params {
				before_scan_id: Some(scan.id.clone()),
				after_scan_id: Some(imported_id),
				..empty(Action::Lineage)
			})
			.expect("lineage");
		assert_eq!(lineage.data["unchanged"], 1);
		Command::new("git")
			.args(["add", "."])
			.current_dir(&root)
			.status()
			.expect("git add");
		Command::new("git")
			.args(["commit", "-qm", "security fixture"])
			.current_dir(&root)
			.status()
			.expect("git commit");
		let remediation = service
			.remediation_create(Params {
				scan_id: Some(scan.id.clone()),
				finding_ids: Some(vec![finding_id]),
				..empty(Action::RemediationCreate)
			})
			.expect("remediation");
		let remediation_id = Str::new(
			remediation.data["remediation"]["id"]
				.as_str()
				.expect("remediation id"),
		);
		service
			.remediation_cleanup(Params {
				remediation_id: Some(remediation_id),
				..empty(Action::RemediationCleanup)
			})
			.expect("cleanup");
		let reopened = SecurityScanService::new(root.clone(), &state_dir);
		assert!(
			reopened
				.inspect(|state| state.scans.contains_key(&scan.id))
				.expect("state")
		);
		fs::remove_dir_all(root).expect("remove root");
		fs::remove_dir_all(state_dir).expect("remove state");
	}

	#[test]
	fn public_exports_recursively_redact_private_identity() {
		let value = redact_value(json!({
			"account": {"email": "secret@example.com"},
			"nested": {
				"access_token": "secret",
				"password": "secret",
				"credentialAffinity": "safe",
			},
		}));
		assert!(value.get("account").is_none());
		assert!(value["nested"].get("access_token").is_none());
		assert!(value["nested"].get("password").is_none());
		assert_eq!(value["nested"]["credentialAffinity"], "safe");
	}

	#[tokio::test]
	async fn security_url_exposes_sarif_and_redacted_provenance() {
		let (root, state_dir) = fixture();
		let service = SecurityScanService::new(root.clone(), &state_dir);
		let index = service
			.read("", &ParsedSelector::None)
			.await
			.expect("index");
		assert!(
			std::str::from_utf8(&index)
				.expect("utf8")
				.contains("remediation")
		);
		fs::remove_dir_all(root).expect("remove root");
		fs::remove_dir_all(state_dir).expect("remove state");
	}
}
