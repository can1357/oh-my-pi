//! Launch facts for the chat welcome box: the project's recent sessions and
//! its language-server roster. Both are observer-local projections computed
//! once at boot (ADR 0005); nothing here is journaled.

use std::{
	env,
	path::Path,
	process,
	time::{SystemTime, UNIX_EPOCH},
};

use omp_chat::welcome::{LspServer, LspStatus, RecentSession};
use omp_envd::docserver::{
	lsp_binary::{BinaryPlatform, resolve_lsp_binary},
	lsp_config::{
		ResolvedLspConfig, ResolvedLspServer, discover_native_lsp_sources, load_lsp_config,
	},
	lsp_registry::root_marker_ancestor,
};
use omp_proto::document::v1::{LspServerStage, LspStatusResponse};

/// Rows reserved by the welcome box.
pub const RECENT_LIMIT: usize = 4;

/// Longest the launch path waits on the Environment's roster before falling
/// back to the configuration projection.
pub const LSP_STATUS_BUDGET: std::time::Duration = std::time::Duration::from_millis(1500);

/// Newest sessions in `sessions_dir` other than the journal at `current`,
/// labeled by first prompt (else id) and journal age.
pub fn recent_sessions(sessions_dir: &Path, current: &Path) -> Vec<RecentSession> {
	let index = match omp_driver::sessions::SessionIndex::open(sessions_dir) {
		Ok(index) => index,
		Err(error) => {
			tracing::warn!(dir = %sessions_dir.display(), %error, "recent sessions unavailable");
			return Vec::new();
		},
	};
	let now_ms = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX);
	index
		.recent(Some(current), RECENT_LIMIT)
		.into_iter()
		.map(|session| RecentSession {
			name:     session.display_name(),
			time_ago: omp_tui::components::relative_age(now_ms.saturating_sub(session.updated_ms)),
		})
		.collect()
}

/// The Environment's live roster (`lsp_status`): every discovered
/// declaration matching the project with its supervisor stage.
pub fn lsp_from_status(status: &LspStatusResponse) -> Vec<LspServer> {
	status
		.servers
		.iter()
		.map(|server| LspServer {
			name:       server.name.as_str().into(),
			status:     match LspServerStage::try_from(server.stage) {
				Ok(LspServerStage::Available) => LspStatus::Available,
				Ok(LspServerStage::Ready) => LspStatus::Ready,
				Ok(LspServerStage::Failed) => LspStatus::Error,
				Ok(
					LspServerStage::Starting | LspServerStage::Indexing | LspServerStage::Unspecified,
				)
				| Err(_) => LspStatus::Connecting,
			},
			file_types: server
				.file_types
				.iter()
				.map(|file_type| file_type.as_str().into())
				.collect(),
		})
		.collect()
}

/// Configuration-only fallback when the Environment roster is unreachable:
/// language servers declared for `project` (bundled, user, project layers —
/// the same sources the Environment's supervisor discovers), filtered to
/// enabled primary servers whose root markers match the checkout. A server
/// whose binary resolves is `Available`; one
/// whose binary is missing is `Error`.
pub fn lsp_servers(project: &Path, user_root: Option<&Path>) -> Vec<LspServer> {
	let config =
		discover_native_lsp_sources(user_root, project).and_then(|sources| load_lsp_config(&sources));
	let config = match config {
		Ok(config) => config,
		Err(error) => {
			tracing::warn!(%error, "language-server roster unavailable");
			return Vec::new();
		},
	};
	let platform = if cfg!(windows) {
		BinaryPlatform::Windows
	} else {
		BinaryPlatform::Posix
	};
	let local_roots = [project.to_path_buf()];
	let path = env::var_os("PATH");
	project_lsp(&config, project, |server| {
		resolve_lsp_binary(
			server.command.value.as_str(),
			&server.args.value,
			&local_roots,
			path.as_deref(),
			process::id(),
			platform,
		)
		.is_ok()
	})
}

/// Pure roster projection: `resolves` answers whether a declaration's binary
/// can be launched.
fn project_lsp(
	config: &ResolvedLspConfig,
	project: &Path,
	resolves: impl Fn(&ResolvedLspServer) -> bool,
) -> Vec<LspServer> {
	config
		.servers
		.values()
		.filter(|server| !server.disabled.value && !server.is_linter.value)
		.filter(|server| root_marker_ancestor(project, &server.root_markers.value).is_some())
		.map(|server| LspServer {
			name:       server.name.clone(),
			status:     if resolves(server) {
				LspStatus::Available
			} else {
				LspStatus::Error
			},
			file_types: server.file_types.value.clone(),
		})
		.collect()
}

#[cfg(test)]
mod tests {
	use std::fs;

	use omp_envd::docserver::lsp_config::LspConfigSource;

	use super::*;

	fn config(document: &str) -> ResolvedLspConfig {
		load_lsp_config(&[LspConfigSource::manifest("test", document.as_bytes(), false)])
			.expect("valid config")
	}

	#[test]
	fn roster_follows_markers_flags_and_binary_resolution() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let root = scratch.path();
		fs::write(root.join("Cargo.toml"), "[package]\n").expect("marker");
		let config = config(
			r#"{"servers":{
				"rust":   {"command":"rust-analyzer","fileTypes":["rs"],"rootMarkers":["Cargo.toml"]},
				"ghost":  {"command":"ghost-lsp","fileTypes":["rs"],"rootMarkers":["Cargo.toml"]},
				"ts":     {"command":"tsserver","fileTypes":["ts"],"rootMarkers":["package.json"]},
				"lint":   {"command":"rust-analyzer","fileTypes":["rs"],"rootMarkers":["Cargo.toml"],"isLinter":true},
				"off":    {"command":"rust-analyzer","fileTypes":["rs"],"rootMarkers":["Cargo.toml"],"disabled":true}
			}}"#,
		);
		let roster = project_lsp(&config, root, |server| server.command.value == "rust-analyzer");
		assert_eq!(roster, [
			LspServer {
				name:       "ghost".into(),
				status:     LspStatus::Error,
				file_types: vec!["rs".into()],
			},
			LspServer {
				name:       "rust".into(),
				status:     LspStatus::Available,
				file_types: vec!["rs".into()],
			},
		]);
	}

	#[test]
	fn live_roster_maps_supervisor_stages() {
		use omp_proto::document::v1::LspServerStatus;
		let server = |name: &str, stage: LspServerStage| LspServerStatus {
			name: name.to_owned(),
			stage: stage as i32,
			file_types: vec!["rs".to_owned()],
			..LspServerStatus::default()
		};
		let status = LspStatusResponse {
			servers: vec![
				server("a", LspServerStage::Available),
				server("s", LspServerStage::Starting),
				server("i", LspServerStage::Indexing),
				server("r", LspServerStage::Ready),
				server("f", LspServerStage::Failed),
			],
		};
		let statuses = lsp_from_status(&status)
			.into_iter()
			.map(|server| (server.name, server.status))
			.collect::<Vec<_>>();
		assert_eq!(statuses, [
			("a".into(), LspStatus::Available),
			("s".into(), LspStatus::Connecting),
			("i".into(), LspStatus::Connecting),
			("r".into(), LspStatus::Ready),
			("f".into(), LspStatus::Error),
		]);
	}

	#[test]
	fn roster_is_empty_without_matching_markers() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let config = config(
			r#"{"servers":{"rust":{"command":"rust-analyzer","fileTypes":["rs"],"rootMarkers":["Cargo.toml"]}}}"#,
		);
		assert!(project_lsp(&config, scratch.path(), |_| true).is_empty());
	}
}
