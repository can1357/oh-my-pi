//! Export, memory, SSH, share, and cleanse feeds behind the chat host's
//! `/export`, `/memory`, `/ssh`, `/share`, `/cleanse`, and `/changelog`.

use std::{
	fs,
	path::{Path, PathBuf},
	pin::Pin,
	sync::Arc,
};

use omp_chat::overlays::services::{
	CleanseOutcome, CleanseRequest, CleanseRun, MemoryOp, Pending, ServiceError, ServiceResult,
	SshHostRow, SshHostSpec,
};
use omp_core::{Str, sf};
use omp_driver::cleanse::{
	CleanseArgs, CleanseStatus, TargetChoice,
	production::{CleansePresentation, PresentationError, ProductionCleanseHost},
};
use omp_envd::ssh::{AuthPolicy, HostConfig, HostPaths, HostStore};
use tokio_util::sync::CancellationToken;

use super::ServiceState;

/// Share snapshots are trimmed to the primary store ceiling before sealing.
const SHARE_JSON_BUDGET: usize = omp_driver::share::HTTP_MAX_SEALED_BYTES / 2;
/// Prompt budget used to render `/memory view`.
const MEMORY_VIEW_TOKENS: usize = 4_000;

fn failed(error: impl std::fmt::Display) -> ServiceError {
	ServiceError::failed(error)
}

/// `/export [path]`: a standalone HTML projection of the live journal.
pub fn export(
	state: &ServiceState,
	dom: &omp_dom::Dom,
	path: Option<&Path>,
) -> ServiceResult<PathBuf> {
	let journal = state.live_journal.read().clone();
	let target = match path {
		Some(path) if path.is_absolute() => path.to_path_buf(),
		Some(path) => state.project.join(path),
		None => {
			let stem = journal
				.file_stem()
				.and_then(|stem| stem.to_str())
				.unwrap_or("session");
			state.project.join(format!("omp-session-{stem}.html"))
		},
	};
	let blobs =
		omp_journal::blob::BlobStore::open(journal.parent().unwrap_or_else(|| Path::new(".")))
			.map_err(failed)?;
	crate::render_cmd::export_html_snapshot(&journal, dom, &blobs, &target).map_err(failed)?;
	Ok(target)
}

/// `/memory <op>` over the environment's memory runtime.
pub fn memory(state: &ServiceState, op: MemoryOp) -> ServiceResult<Str> {
	let runtime = &state.memory;
	match op {
		MemoryOp::View => {
			let snapshot = runtime
				.prompt_snapshot(None, None, MEMORY_VIEW_TOKENS)
				.map_err(failed)?;
			let mut out = String::new();
			for (label, slot) in [
				("memory", &snapshot.memory),
				("standing", &snapshot.standing),
				("recall", &snapshot.recall),
			] {
				match &slot.content {
					Some(content) => {
						out.push_str("## ");
						out.push_str(label);
						out.push_str("\n\n```\n");
						out.push_str(content);
						out.push_str("\n```\n\n");
					},
					None => {},
				}
			}
			if out.is_empty() {
				let status = runtime.status();
				return Ok(status
					.message
					.unwrap_or_else(|| Str::new_static("Memory payload is empty.")));
			}
			Ok(Str::from(out))
		},
		MemoryOp::Stats => pretty(&runtime.stats().map_err(failed)?),
		MemoryOp::Diagnose => pretty(&runtime.diagnose().map_err(failed)?),
		MemoryOp::Clear => {
			runtime.clear().map_err(failed)?;
			Ok(Str::new_static("Memory cleared."))
		},
		MemoryOp::Enqueue => {
			let queued = runtime.enqueue().map_err(failed)?;
			Ok(sf!("Memory consolidation enqueued ({queued} item(s))."))
		},
	}
}

/// Pretty-JSON rendering for memory reports (the legacy `/memory` output).
fn pretty<T: serde::Serialize>(value: &T) -> ServiceResult<Str> {
	serde_json::to_string_pretty(value)
		.map(|json| Str::from(format!("```json\n{json}\n```")))
		.map_err(failed)
}

/// No `CHANGELOG.md` ships with the binary.
pub fn changelog() -> ServiceResult<Str> {
	Err(ServiceError::Unavailable("changelog (the tree ships no CHANGELOG.md)"))
}

/// Project `.omp/hosts.toml` over the user configuration root (`~/.o2`).
fn ssh_paths(state: &ServiceState) -> ServiceResult<HostPaths> {
	let user_root = omp_core::dirs::user_config_root().map_err(failed)?;
	Ok(HostPaths::new(&user_root, &state.project))
}

/// `/ssh list`: project declarations shadow user ones with the same alias.
pub fn ssh_hosts(state: &ServiceState) -> ServiceResult<Vec<SshHostRow>> {
	let paths = ssh_paths(state)?;
	let mut rows = Vec::new();
	let mut seen = std::collections::BTreeSet::new();
	for (scope, path) in [("project", &paths.project), ("user", &paths.user)] {
		let store = HostStore::load(path).map_err(failed)?;
		for alias in store.aliases() {
			if !seen.insert(alias.clone()) {
				continue;
			}
			let host = store.get(alias.as_str()).map_err(failed)?;
			rows.push(SshHostRow {
				name:   alias,
				target: sf!("{}@{}:{}", host.user, host.address, host.port),
				scope:  Str::new_static(scope),
				auth:   match &host.auth {
					AuthPolicy::Agent => Str::new_static("agent"),
					AuthPolicy::Key { path } => Str::new(path.display().to_string()),
				},
			});
		}
	}
	Ok(rows)
}

/// `/ssh add`.
pub fn ssh_add(state: &ServiceState, spec: &SshHostSpec) -> ServiceResult<Str> {
	let paths = ssh_paths(state)?;
	let path = if spec.project {
		&paths.project
	} else {
		&paths.user
	};
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent).map_err(failed)?;
	}
	HostStore::load(path)
		.map_err(failed)?
		.upsert(path, spec.alias.clone(), HostConfig {
			address:      spec.address.clone(),
			port:         spec.port,
			user:         spec.user.clone(),
			host_key:     spec.host_key.clone(),
			auth:         spec
				.key
				.clone()
				.map_or(AuthPolicy::Agent, |path| AuthPolicy::Key { path }),
			timeout_secs: 30,
		})
		.map_err(failed)?;
	Ok(sf!("Configured SSH host `{}` in {}.", spec.alias, path.display()))
}

/// `/ssh remove`.
pub fn ssh_remove(state: &ServiceState, alias: &str, project: bool) -> ServiceResult<Str> {
	let paths = ssh_paths(state)?;
	let path = if project { &paths.project } else { &paths.user };
	let removed = HostStore::load(path)
		.map_err(failed)?
		.remove(path, alias)
		.map_err(failed)?;
	if removed {
		Ok(sf!("Removed SSH host `{alias}` from {}.", path.display()))
	} else {
		Err(ServiceError::Failed(sf!("SSH host `{alias}` is not configured in {}", path.display())))
	}
}

/// The `secrets.yml` files `/share` redacts with, low to high precedence:
/// the user file under the configuration root (`~/.o2`, profile-aware —
/// never the data directory), then `<project>/.omp/secrets.yml`.
///
/// # Errors
///
/// Returns [`omp_core::dirs::DataDirError::HomeUnset`] when no home directory
/// is set.
pub fn secrets_files(project: &Path) -> Result<[PathBuf; 2], omp_core::dirs::DataDirError> {
	Ok([
		omp_core::dirs::user_config_root()?.join("secrets.yml"),
		project.join(".omp").join("secrets.yml"),
	])
}

/// `/share`: redact, seal, and upload the snapshot; settles with the viewer
/// URL.
pub fn share(state: &ServiceState, snapshot: serde_json::Value) -> ServiceResult<Pending<Str>> {
	let Some(stack) = state.stack.as_ref() else {
		return Err(ServiceError::Unavailable("share (credentials live on the remote gateway host)"));
	};
	let settings = omp_driver::settings::Settings::from_con(&state.con);
	let [user_secrets, project_secrets] = secrets_files(&state.project).map_err(failed)?;
	let secrets = omp_driver::secrets::session::SecretSessionSnapshot::build(
		0,
		&user_secrets,
		&project_secrets,
		[],
	)
	.map_err(failed)?;
	let projection = omp_driver::share::ShareProjection::materialize_bounded(
		snapshot,
		settings.export,
		&secrets,
		SHARE_JSON_BUDGET,
	);
	let sealed = omp_driver::share::seal(&projection).map_err(failed)?;
	let bridge = Arc::new(omp_envd::github_url::GithubCredentialBridge::new());
	let _ = bridge.bind(Arc::clone(&stack.credential_authority));
	let store = omp_driver::share::DirectShareStore::new(&settings.share.server_url, bridge)
		.map_err(failed)?;
	let selected = match settings.share.store {
		omp_driver::settings::ShareStore::Http => omp_driver::share::ShareStoreKind::Http,
		omp_driver::settings::ShareStore::Gist => omp_driver::share::ShareStoreKind::Gist,
	};
	let viewer = settings.share.server_url.clone();
	let (tx, rx) = flume::bounded(1);
	state.runtime.spawn(async move {
		let result = omp_driver::share::upload(&store, selected, &sealed, &viewer)
			.await
			.map(|result| match result.fallback {
				Some(fallback) => sf!(
					"Share URL: {} (fell back to {:?}: {})",
					result.url,
					fallback.to,
					fallback.message
				),
				None => sf!("Share URL: {}", result.url),
			})
			.map_err(failed);
		let _ = tx.send(result);
	});
	Ok(rx)
}

/// Chat cleanse presentation: no interactive pickers; `--all` or a request
/// decides, otherwise every discovered checker runs.
struct ChatCleansePresentation {
	request: Option<Str>,
	all:     bool,
}

impl CleansePresentation for ChatCleansePresentation {
	fn pick_target<'a>(
		&'a self,
		_checkers: &'a [omp_driver::cleanse::Checker],
		cancel: &'a CancellationToken,
	) -> Pin<Box<dyn Future<Output = Result<TargetChoice, PresentationError>> + 'a>> {
		Box::pin(async move {
			if cancel.is_cancelled() {
				return Ok(TargetChoice::Cancel);
			}
			Ok(match (&self.request, self.all) {
				(Some(request), _) => TargetChoice::Request(request.clone()),
				(None, _) => TargetChoice::All,
			})
		})
	}

	fn prompt_request<'a>(
		&'a self,
		_cancel: &'a CancellationToken,
	) -> Pin<Box<dyn Future<Output = Result<Option<Str>, PresentationError>> + 'a>> {
		Box::pin(async move { Ok(self.request.clone()) })
	}
}

/// `/cleanse`: runs the driver workflow on the runtime; Esc cancels through
/// the returned sender.
pub fn cleanse(state: &ServiceState, request: CleanseRequest) -> ServiceResult<CleanseRun> {
	let args = CleanseArgs {
		all: request.all || request.request.is_none(),
		tests: request.tests,
		request: request.request.clone(),
		..CleanseArgs::default()
	};
	let presentation =
		Arc::new(ChatCleansePresentation { request: request.request, all: args.all });
	let host =
		ProductionCleanseHost::open(state.project.clone(), state.data_dir.clone(), presentation)
			.map_err(failed)?;
	let cancel = CancellationToken::new();
	let (cancel_tx, cancel_rx) = flume::bounded::<()>(1);
	let (tx, rx) = flume::bounded(1);
	let token = cancel.clone();
	state.runtime.spawn(async move {
		let _ = cancel_rx.recv_async().await;
		token.cancel();
	});
	// The driver's presentation futures are not `Send`, so the run lives on
	// its own thread and blocks on the shared runtime from there.
	let runtime = state.runtime.clone();
	std::thread::Builder::new()
		.name("omp-cleanse".into())
		.spawn(move || {
			let result = runtime
				.block_on(omp_driver::cleanse::run(&args, &host, &cancel))
				.map(|exit| {
					let status = match exit.status {
						CleanseStatus::Clean => "clean",
						CleanseStatus::Unresolved => "unresolved",
						CleanseStatus::Cancelled => "cancelled",
						CleanseStatus::Unsupported => "unsupported",
					};
					let summary = match exit.status {
						CleanseStatus::Clean => {
							Str::new_static("Cleanse completed with no remaining diagnostics.")
						},
						CleanseStatus::Unresolved => sf!(
							"Cleanse left {} file group(s) unresolved{}.",
							exit.remainder.len(),
							if exit.omitted_files == 0 {
								String::new()
							} else {
								format!(" ({} more omitted)", exit.omitted_files)
							}
						),
						CleanseStatus::Unsupported => {
							Str::new_static("No supported cleanse checker was discovered.")
						},
						CleanseStatus::Cancelled => Str::new_static("Cleanse cancelled."),
					};
					CleanseOutcome {
						status: Str::new_static(status),
						summary,
						remainder: exit
							.remainder
							.iter()
							.map(|group| {
								sf!(
									"{}: {} issue(s)",
									group.file.as_deref().unwrap_or("(project)"),
									group.diagnostics.len()
								)
							})
							.collect(),
					}
				})
				.map_err(failed);
			let _ = tx.send(result);
		})
		.map_err(failed)?;
	Ok(CleanseRun { done: rx, cancel: cancel_tx })
}
