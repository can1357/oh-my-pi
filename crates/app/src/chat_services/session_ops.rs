//! Session-lifecycle feeds for `/resume`, `/tree`, `/plan-review`, and
//! `/btw`: the stored-session index operations the picker performs, the
//! live journal read as a branch DAG, session-local artifacts, and the
//! tool-less side kernel that answers side questions.

use std::{
	fs,
	path::{Path, PathBuf},
	sync::Arc,
};

use omp_chat::overlays::services::{ServiceError, ServiceResult, SideEvent, TreeEntry};
use omp_core::{Str, Ulid};
use omp_dom::{Op, PropId, Txn, Value};
use omp_journal::{Journal, kind};
use omp_session::{ComponentRegistry, Session};

use super::ServiceState;

const BTW_PROMPT: &str = include_str!("../../../chat/prompts/btw-user.md");
/// Preview clip for tree rows.
const PREVIEW: usize = 160;

fn journal_path(state: &ServiceState, id: &str) -> PathBuf {
	let path = Path::new(id);
	if path.components().count() > 1 || path.extension().is_some() {
		path.to_path_buf()
	} else {
		state.sessions_dir.join(id).with_extension("oms")
	}
}

fn io(error: &std::io::Error) -> ServiceError {
	ServiceError::Failed(Str::new(error.to_string()))
}

/// Renames a stored session by patching its `<meta title>` prop. The live
/// session is renamed by the controller (`HostCommand::Rename`), which
/// owns its journal handle; the picker only ever renames other sessions.
pub(super) fn rename(state: &ServiceState, id: &str, title: &str) -> ServiceResult<()> {
	let path = journal_path(state, id);
	if path == *state.live_journal.read() {
		return Err(ServiceError::Failed(Str::new_static(
			"the live session is renamed with /rename",
		)));
	}
	let mut session = Session::open(&path, ComponentRegistry::standard())
		.map_err(|error| ServiceError::Failed(Str::new(error.to_string())))?;
	let cause = session
		.head()
		.ok_or(ServiceError::Failed(Str::new_static("journal has no head")))?;
	session
		.patch(Txn {
			cause,
			label: Some(Str::new_static("session.rename")),
			ops: vec![Op::Set {
				h:     session.dom().meta(),
				prop:  PropId::Name.into(),
				value: Value::Str(Str::new(title)),
			}],
		})
		.map_err(|error| ServiceError::Failed(Str::new(error.to_string())))?;
	Ok(())
}

/// Deletes a stored session file (never the live one) and its session-scoped
/// `local://` tree. Content-addressed blobs are shared by all project
/// sessions, so their roots are released here but physical reclamation remains
/// the project-wide journal mark-and-sweep performed by `omp gc`.
pub(super) fn delete(state: &ServiceState, id: &str) -> ServiceResult<()> {
	let path = journal_path(state, id);
	if path == *state.live_journal.read() {
		return Err(ServiceError::Failed(Str::new_static("the live session is deleted with /drop")));
	}
	fs::remove_file(&path).map_err(|error| io(&error))?;
	let local_session = path
		.file_stem()
		.filter(|stem| !stem.is_empty())
		.map(|stem| path.with_file_name(stem));
	if let Some(local_session) = local_session
		&& let Err(error) = fs::remove_dir_all(&local_session)
		&& error.kind() != std::io::ErrorKind::NotFound
	{
		return Err(io(&error));
	}
	Ok(())
}

/// Root of the live session's `local://` artifacts.
fn local_root(state: &ServiceState) -> Option<PathBuf> {
	let journal = state.live_journal.read();
	let stem = journal
		.file_stem()
		.and_then(|stem| stem.to_str())
		.map(str::to_owned)?;
	Some(journal.parent()?.join(stem).join("local"))
}

fn local_path(state: &ServiceState, url: &str) -> ServiceResult<PathBuf> {
	let rest = url
		.strip_prefix("local://")
		.ok_or(ServiceError::Failed(Str::new_static("not a local:// url")))?;
	if rest.is_empty() || rest.split('/').any(|part| part == ".." || part.is_empty()) {
		return Err(ServiceError::Failed(Str::new_static("invalid local:// path")));
	}
	local_root(state)
		.map(|root| root.join(rest))
		.ok_or(ServiceError::Unavailable("local artifacts"))
}

/// Reads one `local://` artifact of the live session.
pub(super) fn read_local(state: &ServiceState, url: &str) -> ServiceResult<Str> {
	let path = local_path(state, url)?;
	fs::read_to_string(&path)
		.map(Str::new)
		.map_err(|error| io(&error))
}

/// Writes one `local://` artifact of the live session (a large-paste
/// `paste-N.md`) and returns its URL. `name` is a bare file name: directory
/// segments are refused so a menu choice can never escape the session root.
pub(super) fn write_local(state: &ServiceState, name: &str, content: &str) -> ServiceResult<Str> {
	if name.is_empty() || name == ".." || name.contains(['/', '\\']) {
		return Err(ServiceError::Failed(Str::new_static("invalid local:// name")));
	}
	let root = local_root(state).ok_or(ServiceError::Unavailable("local artifacts"))?;
	fs::create_dir_all(&root).map_err(|error| io(&error))?;
	let path = root.join(name);
	// Write beside, then rename: a reader never sees a half-written paste.
	// Any ordinary error removes the stage immediately; process-crash debris is
	// confined to the session tree and disappears with session deletion.
	let staging = root.join(format!(".{name}.{}.tmp", Ulid::generate()));
	let result = fs::write(&staging, content).and_then(|()| fs::rename(&staging, &path));
	if let Err(error) = result {
		let _ = fs::remove_file(&staging);
		return Err(io(&error));
	}
	Ok(Str::new(format!("local://{name}")))
}

/// Lists `local://` artifacts of the live session ending in `suffix`,
/// newest first.
pub(super) fn list_local(state: &ServiceState, suffix: &str) -> ServiceResult<Vec<Str>> {
	let root = local_root(state).ok_or(ServiceError::Unavailable("local artifacts"))?;
	let entries = match fs::read_dir(&root) {
		Ok(entries) => entries,
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
		Err(error) => return Err(io(&error)),
	};
	let mut rows = entries
		.filter_map(Result::ok)
		.filter_map(|entry| {
			let name = entry.file_name().to_str()?.to_owned();
			if !name.ends_with(suffix) {
				return None;
			}
			let modified = entry.metadata().and_then(|meta| meta.modified()).ok()?;
			Some((modified, name))
		})
		.collect::<Vec<_>>();
	rows.sort_by(|left, right| right.0.cmp(&left.0));
	Ok(rows
		.into_iter()
		.map(|(_, name)| Str::new(format!("local://{name}")))
		.collect())
}

/// The live journal as a branch DAG: every entry with its tree parent
/// (`prior` when it branched, else the preceding entry), user/assistant
/// text previews, and live-chain membership.
pub(super) fn journal_tree(state: &ServiceState) -> ServiceResult<Vec<TreeEntry>> {
	let path = state.live_journal.read().clone();
	let entries =
		Journal::scan(&path).map_err(|error| ServiceError::Failed(Str::new(error.to_string())))?;
	let live = omp_journal::live_chain(&entries)
		.map(|entry| entry.id)
		.collect::<std::collections::HashSet<_>>();
	let head = entries.last().map(|entry| entry.id);
	// Assistant text arrives as `stream@1` appends after the start entry;
	// fold each stream's text onto the assistant start that opened it.
	let mut assistant_text = std::collections::HashMap::<u32, (usize, String)>::new();
	let mut rows = Vec::with_capacity(entries.len());
	for (index, entry) in entries.iter().enumerate() {
		let parent = entry
			.prior
			.or_else(|| index.checked_sub(1).map(|prev| entries[prev].id));
		let mut text = String::new();
		match entry.kind.name.as_str() {
			kind::MSG_USER => {
				if let Ok(payload) =
					serde_json::from_str::<omp_journal::data::MsgUser>(entry.data.as_str())
				{
					text = payload.text.to_string();
				}
			},
			kind::STREAM => {
				if let Ok(payload) =
					serde_json::from_str::<omp_journal::data::Stream>(entry.data.as_str())
				{
					match payload.op {
						omp_journal::data::StreamOp::Open => {
							if payload.prop.as_deref() == Some("text")
								&& let Some(owner) = rows.iter().rposition(|row: &TreeEntry| {
									row.kind.as_str() == kind::MSG_ASSISTANT_START
								}) {
								assistant_text.insert(payload.sid, (owner, String::new()));
							}
						},
						omp_journal::data::StreamOp::Append => {
							if let Some((_, buffer)) = assistant_text.get_mut(&payload.sid)
								&& let Some(delta) = payload.text
							{
								buffer.push_str(delta.as_str());
							}
						},
						omp_journal::data::StreamOp::Close => {
							if let Some((owner, buffer)) = assistant_text.remove(&payload.sid)
								&& let Some(row) = rows.get_mut(owner)
							{
								row.text = Str::new(clip(&buffer));
							}
						},
					}
				}
			},
			_ => {},
		}
		rows.push(TreeEntry {
			id: entry.id,
			parent,
			kind: entry.kind.name.clone(),
			text: Str::new(clip(&text)),
			live: live.contains(&entry.id),
			head: Some(entry.id) == head,
		});
	}
	Ok(rows)
}

fn clip(text: &str) -> &str {
	let line = text.lines().next().unwrap_or_default();
	line
		.char_indices()
		.nth(PREVIEW)
		.map_or(line, |(end, _)| &line[..end])
}

/// Answers a side question on a tool-less ephemeral child kernel that
/// shares the parent's model and console, streaming its text deltas.
pub(super) fn btw(
	state: &ServiceState,
	question: &str,
	context: &str,
) -> ServiceResult<flume::Receiver<SideEvent>> {
	let (tx, rx) = flume::unbounded();
	let data_dir = state.data_dir.clone();
	let project = state.project.clone();
	let model = state.model.clone();
	let con = Arc::clone(&state.con);
	let prompt = {
		let mut text = String::new();
		if !context.trim().is_empty() {
			text.push_str("<conversation-context>\n");
			text.push_str(context);
			text.push_str("\n</conversation-context>\n\n");
		}
		text.push_str(&BTW_PROMPT.replace("{{question}}", question));
		Str::new(text)
	};
	state.runtime.spawn(async move {
		let options = omp_driver::headless::kernel::KernelOptions {
			ephemeral: true,
			no_tools: true,
			..omp_driver::headless::kernel::KernelOptions::default()
		};
		let composed = omp_driver::headless::kernel::compose_kernel(
			&data_dir,
			&project,
			model.as_str(),
			con,
			options,
		)
		.await;
		let (mut kernel, mut session, _) = match composed {
			Ok(composed) => composed,
			Err(error) => {
				let _ = tx.send(SideEvent::Error(Str::new(error.to_string())));
				return;
			},
		};
		let ephemeral = session.journal_path().to_path_buf();
		let events = kernel.subscribe();
		let deltas = tx.clone();
		let pump = tokio::spawn(async move {
			while let Ok(event) = events.recv_async().await {
				if let omp_agent::KernelEvent::TextDelta(text) = event
					&& deltas.send(SideEvent::Delta(text)).is_err()
				{
					break;
				}
			}
		});
		let outcome = kernel
			.run_turn(
				&mut session,
				omp_agent::TurnInput { text: prompt, attachments: Vec::new() },
				omp_agent::RunControl::default(),
			)
			.await;
		drop(kernel);
		let _ = pump.await;
		let _ = tx.send(match outcome {
			Ok(_) => SideEvent::Done,
			Err(error) => SideEvent::Error(Str::new(error.to_string())),
		});
		drop(session);
		let _ = fs::remove_file(ephemeral);
	});
	Ok(rx)
}
