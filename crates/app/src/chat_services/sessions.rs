//! Session index and agent-definition feeds behind `/resume`, `/hub`, and
//! `/agents`.
//!
//! Sessions come from the durable journal directory through
//! [`omp_driver::sessions::SessionIndex`]; pins live beside them in
//! `session-pins.json`. Agent definitions are the `<agent>.cfg` class files
//! the spawner executes (ADR 0013): every `.cfg` under `<project>/.omp`
//! other than `config.cfg`/`subagent.cfg`, plus the bundled `task` default
//! class. Enablement is `sv_task_disabled_agents`, set live on the process
//! console (children seed from it at spawn) and persisted through the
//! global `config.cfg`.

use std::{fs, io, path::Path};

use omp_agent::AI_MODEL;
use omp_chat::overlays::services::{
	AgentRow, ForeignSessionRow, ForeignSessionSource, ServiceError, ServiceResult, SessionRow,
	SessionScope,
};
use omp_core::Str;
use omp_driver::{sessions::SessionIndex, subagent::settings::SV_TASK_DISABLED_AGENTS};

use super::ServiceState;

/// Pinned session ids beside the journals.
const PINS_FILE: &str = "session-pins.json";
/// Cfg files under `.omp/` that are not agent classes.
const RESERVED_CFGS: [&str; 2] = ["config.cfg", "subagent.cfg"];
/// The spawner's default class when a task names none.
const DEFAULT_AGENT: &str = "task";

/// On-disk sessions in `scope`, pinned first, then newest first.
pub fn rows(state: &ServiceState, scope: SessionScope) -> ServiceResult<Vec<SessionRow>> {
	rows_in(&state.data_dir, &state.sessions_dir, &state.state_dir, scope)
}

/// Foreign Claude Code or Codex transcripts available for one-shot import.
pub fn foreign_rows(source: ForeignSessionSource) -> ServiceResult<Vec<ForeignSessionRow>> {
	crate::session_import::candidates(source.into())
		.map_err(ServiceError::failed)
		.map(|candidates| {
			candidates
				.into_iter()
				.map(|candidate| ForeignSessionRow {
					source,
					id: candidate.id,
					path: candidate.path,
					cwd: candidate.cwd,
					title: candidate.title,
					created_ms: candidate.created_ms,
					modified_ms: candidate.modified_ms,
					messages: candidate.messages,
					first_message: candidate.first_message,
				})
				.collect()
		})
}

/// [`rows`] over explicit roots: `data_dir/projects/*/sessions` for every
/// project, else this project's `sessions_dir` beside its `state_dir`.
pub(crate) fn rows_in(
	data_dir: &Path,
	sessions_dir: &Path,
	state_dir: &Path,
	scope: SessionScope,
) -> ServiceResult<Vec<SessionRow>> {
	if scope == SessionScope::Project {
		return rows_from(sessions_dir, state_dir);
	}
	let mut rows = Vec::new();
	let projects = data_dir.join("projects");
	let entries = match fs::read_dir(&projects) {
		Ok(entries) => Some(entries),
		Err(error) if error.kind() == io::ErrorKind::NotFound => None,
		Err(error) => return Err(ServiceError::failed(error)),
	};
	for entry in entries.into_iter().flatten() {
		let project_state = entry.map_err(ServiceError::failed)?.path();
		if !project_state.is_dir() {
			continue;
		}
		rows.extend(rows_from(&project_state.join("sessions"), &project_state)?);
	}
	if !rows.iter().any(|row| row.path.starts_with(sessions_dir)) {
		rows.extend(rows_from(sessions_dir, state_dir)?);
	}
	rows.sort_by(|left, right| {
		right
			.pinned
			.cmp(&left.pinned)
			.then_with(|| right.modified_ms.cmp(&left.modified_ms))
	});
	Ok(rows)
}

fn rows_from(sessions_dir: &Path, state_dir: &Path) -> ServiceResult<Vec<SessionRow>> {
	let index = SessionIndex::open(sessions_dir).map_err(ServiceError::failed)?;
	let pins = read_pins(&state_dir.join(PINS_FILE)).map_err(ServiceError::failed)?;
	let mut rows = index
		.list()
		.into_iter()
		.map(|stored| {
			let created_ms = stored.created.parse::<u64>().unwrap_or(stored.updated_ms);
			let pinned = pins.iter().any(|pin| *pin == stored.id);
			SessionRow {
				messages: stored.messages,
				id: stored.id,
				path: stored.path,
				title: stored.title,
				created_ms,
				modified_ms: stored.updated_ms,
				parent: None,
				agent: None,
				pinned,
			}
		})
		.collect::<Vec<_>>();
	rows.sort_by_key(|row| !row.pinned);
	Ok(rows)
}

/// Pins or unpins a stored session.
pub fn pin(state: &ServiceState, id: &str, pinned: bool) -> ServiceResult<()> {
	let path = state.state_dir.join(PINS_FILE);
	let mut pins = read_pins(&path).map_err(ServiceError::failed)?;
	let present = pins.iter().position(|pin| pin.as_str() == id);
	match (present, pinned) {
		(None, true) => pins.push(Str::new(id)),
		(Some(at), false) => {
			pins.remove(at);
		},
		_ => return Ok(()),
	}
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent).map_err(ServiceError::failed)?;
	}
	let text = serde_json::to_string(&pins).map_err(ServiceError::failed)?;
	fs::write(&path, text).map_err(ServiceError::failed)
}

/// Agent classes the spawner can execute, project classes first.
pub fn agents(state: &ServiceState) -> ServiceResult<Vec<AgentRow>> {
	let disabled = SV_TASK_DISABLED_AGENTS.get(&state.con);
	let enabled = |name: &str| !disabled.iter().any(|entry| entry.as_str() == name);
	let mut rows = Vec::new();
	let root = state.project.join(".omp");
	let entries = match fs::read_dir(&root) {
		Ok(entries) => Some(entries),
		Err(error) if error.kind() == io::ErrorKind::NotFound => None,
		Err(error) => return Err(ServiceError::failed(error)),
	};
	for entry in entries.into_iter().flatten() {
		let path = entry.map_err(ServiceError::failed)?.path();
		let Some(name) = path
			.file_name()
			.and_then(|name| name.to_str())
			.filter(|name| !RESERVED_CFGS.contains(name))
			.and_then(|name| name.strip_suffix(".cfg"))
		else {
			continue;
		};
		let source = fs::read_to_string(&path).map_err(ServiceError::failed)?;
		let (description, model) = describe_cfg(&source);
		rows.push(AgentRow {
			name: Str::new(name),
			source: Str::new_static("project"),
			description: description
				.unwrap_or_else(|| Str::new(format!("Class cfg {}", path.display()))),
			model,
			tools: Vec::new(),
			enabled: enabled(name),
			path: Some(path),
		});
	}
	rows.sort_by(|left, right| left.name.cmp(&right.name));
	if !rows.iter().any(|row| row.name.as_str() == DEFAULT_AGENT) {
		rows.push(AgentRow {
			name:        Str::new_static(DEFAULT_AGENT),
			source:      Str::new_static("bundled"),
			description: Str::new_static(
				"Default class: inherits the parent's live values plus subagent.cfg",
			),
			model:       None,
			tools:       Vec::new(),
			enabled:     enabled(DEFAULT_AGENT),
			path:        None,
		});
	}
	Ok(rows)
}

/// Enables or disables one class for spawning: live on the process console
/// and persisted in the global cfg.
pub fn set_agent_enabled(state: &ServiceState, name: &str, enabled: bool) -> ServiceResult<()> {
	let mut disabled = SV_TASK_DISABLED_AGENTS.get(&state.con);
	let present = disabled.iter().position(|entry| entry.as_str() == name);
	match (present, enabled) {
		(Some(at), true) => {
			disabled.remove(at);
		},
		(None, false) => disabled.push(Str::new(name)),
		_ => return Ok(()),
	}
	let literal = omp_con::Value::List(
		disabled
			.iter()
			.map(|entry| omp_con::Value::Str(entry.clone()))
			.collect(),
	)
	.to_string();
	SV_TASK_DISABLED_AGENTS
		.set(&state.con, disabled)
		.map_err(ServiceError::failed)?;
	crate::config_cmd::set_persisted(
		&state.project,
		crate::cli::ConfigScope::Global,
		SV_TASK_DISABLED_AGENTS.name(),
		&literal,
	)
	.map_err(|error| ServiceError::failed(format!("{error}")))
}

/// First leading `//` comment line as the description and the `ai_model`
/// assignment as the class model, read from the cfg script.
fn describe_cfg(source: &str) -> (Option<Str>, Option<Str>) {
	let description = source
		.lines()
		.map(str::trim)
		.take_while(|line| line.is_empty() || line.starts_with("//"))
		.find_map(|line| line.strip_prefix("//"))
		.map(|line| Str::new(line.trim()))
		.filter(|line| !line.is_empty());
	let model = omp_con::parse(&Str::new(source))
		.ok()
		.and_then(|statements| {
			statements.into_iter().rev().find_map(|statement| {
				let name = statement.args.first()?.as_atom()?;
				(name.as_str() == AI_MODEL.name())
					.then(|| statement.args.get(1)?.as_atom().cloned())
					.flatten()
			})
		});
	(description, model)
}

fn read_pins(path: &Path) -> Result<Vec<Str>, io::Error> {
	match fs::read_to_string(path) {
		Ok(text) => serde_json::from_str(&text).map_err(io::Error::other),
		Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
		Err(error) => Err(error),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn cfg_description_and_model_come_from_the_script() {
		let source = "// Fast reviewer\n// second line\nai_model @smol\nai_thinking low\n";
		let (description, model) = describe_cfg(source);
		assert_eq!(description.as_deref(), Some("Fast reviewer"));
		assert_eq!(model.as_deref(), Some("@smol"));
		assert_eq!(describe_cfg("ai_thinking low\n"), (None, None));
	}

	#[test]
	fn pins_round_trip_through_the_file() {
		let directory = tempfile::tempdir().expect("tempdir");
		let path = directory.path().join("nested").join(PINS_FILE);
		assert!(read_pins(&path).expect("missing file is empty").is_empty());
		fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
		fs::write(&path, r#"["alpha"]"#).expect("write");
		assert_eq!(read_pins(&path).expect("read"), vec![Str::new_static("alpha")]);
	}
}
