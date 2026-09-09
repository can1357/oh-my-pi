//! Host-owned disposable routing index for live session kernels.

use std::{
	fs, io,
	path::{Path, PathBuf},
	sync::Arc,
	time::UNIX_EPOCH,
};

use omp_agent::{
	PeerAutoreply, SessionAuthority, SessionEndpoint, SessionRole, SessionTopology, Up,
};
use omp_core::{FastHashMap, Str};
use omp_dom::{Dom, Op, PropId, Snapshot};
use parking_lot::RwLock;

omp_core::string_id!(
	/// Stable live-session identifier.
	SessionId
);

/// Live policy consulted whenever third-party traffic is eligible for relay.
#[derive(Clone)]
pub struct IrcRelayPolicy {
	enabled: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl IrcRelayPolicy {
	/// Creates a policy backed by the host's current effective configuration.
	#[must_use]
	pub fn new(enabled: impl Fn() -> bool + Send + Sync + 'static) -> Self {
		Self { enabled: Arc::new(enabled) }
	}

	/// Returns a static policy, primarily for non-interactive compositions.
	#[must_use]
	pub fn fixed(enabled: bool) -> Self {
		Self::new(move || enabled)
	}

	fn enabled(&self) -> bool {
		(self.enabled)()
	}
}

impl Default for IrcRelayPolicy {
	fn default() -> Self {
		Self::fixed(true)
	}
}

/// Cloneable endpoint retained by the process composition for one live kernel.
#[derive(Clone)]
pub struct KernelHandle {
	/// Stable session identity.
	pub id:        SessionId,
	/// Display and routing name.
	pub name:      Str,
	/// The kernel's sole upward mailbox.
	pub up:        flume::Sender<Up>,
	/// Latest detached DOM projection.
	pub snapshot:  Arc<RwLock<Snapshot>>,
	/// Authenticated role, parent, and main-session relationship.
	pub topology:  SessionTopology,
	/// Current host policy for relaying third-party traffic to this root.
	pub relay:     IrcRelayPolicy,
	/// Recipient-owned automatic peer reply actor.
	pub autoreply: Option<Arc<dyn PeerAutoreply>>,
}

impl KernelHandle {
	/// Refreshes the detached projection after the controller advances.
	pub fn refresh(&self, session: &omp_session::Session) {
		*self.snapshot.write() = session.dom().snapshot();
	}

	pub(crate) fn endpoint(&self) -> SessionEndpoint {
		SessionEndpoint {
			id:        Str::new(self.id.as_str()),
			name:      self.name.clone(),
			up:        self.up.clone(),
			snapshot:  Arc::clone(&self.snapshot),
			topology:  self.topology.clone(),
			autoreply: self.autoreply.clone(),
		}
	}
}

#[derive(Default)]
struct RegistryState {
	by_id:   FastHashMap<SessionId, KernelHandle>,
	by_name: FastHashMap<Str, SessionId>,
}

/// Thread-safe process-local index of live session controllers.
///
/// This is routing state only. It is never persisted and every projected
/// session fact remains owned by the journal-backed controller.
#[derive(Default)]
pub struct SessionRegistry {
	state: RwLock<RegistryState>,
}

impl SessionRegistry {
	/// Creates an empty live-session registry.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Registers or replaces one live kernel endpoint.
	pub fn register(&self, name: Str, mut handle: KernelHandle) -> Option<KernelHandle> {
		let autoreply = handle.autoreply.clone();
		let mut state = self.state.write();
		let prior_session = state.by_id.values().find_map(|live| {
			(live.up.same_channel(&handle.up) && live.id != handle.id)
				.then(|| (live.id.clone(), live.name.clone(), live.topology.role))
		});
		let routing_name = prior_session
			.as_ref()
			.map_or(name, |(_, prior_name, _)| prior_name.clone());
		handle.name = routing_name.clone();
		if handle.topology.role == SessionRole::Main {
			handle.topology = SessionTopology::main(Str::new(handle.id.as_str()));
		}
		if let Some((prior_id, _, prior_role)) = prior_session {
			for live in state.by_id.values_mut() {
				if live.topology.parent_id.as_deref() == Some(prior_id.as_str()) {
					live.topology.parent_id = Some(Str::new(handle.id.as_str()));
				}
				if prior_role == SessionRole::Main
					&& live.topology.main_id.as_str() == prior_id.as_str()
				{
					live.topology.main_id = Str::new(handle.id.as_str());
				}
			}
		}
		let displaced = if let Some(previous_id) =
			state.by_name.insert(routing_name, handle.id.clone())
			&& previous_id != handle.id
		{
			state.by_id.remove(&previous_id)
		} else {
			None
		};
		let id = handle.id.clone();
		let current_name = handle.name.clone();
		let previous = state.by_id.insert(id, handle);
		if let Some(previous) = &previous
			&& previous.name != current_name
		{
			state.by_name.remove(&previous.name);
		}
		drop(state);
		for replaced in displaced.iter().chain(previous.iter()) {
			if let Some(producer) = &replaced.autoreply
				&& autoreply
					.as_ref()
					.is_none_or(|current| !Arc::ptr_eq(current, producer))
			{
				producer.cancel();
			}
		}
		previous
	}

	/// Removes one retired session.
	pub fn remove(&self, id: &SessionId<str>) -> Option<KernelHandle> {
		let mut state = self.state.write();
		let handle = state.by_id.remove(id)?;
		if state.by_name.get(&handle.name) == Some(&handle.id) {
			state.by_name.remove(&handle.name);
		}
		let actor_still_registered = handle.autoreply.as_ref().is_some_and(|removed| {
			state.by_id.values().any(|live| {
				live
					.autoreply
					.as_ref()
					.is_some_and(|current| Arc::ptr_eq(current, removed))
			})
		});
		drop(state);
		if !actor_still_registered && let Some(producer) = &handle.autoreply {
			producer.cancel();
		}
		Some(handle)
	}

	/// Looks up a live kernel by stable session id.
	#[must_use]
	pub fn lookup(&self, id: &SessionId<str>) -> Option<KernelHandle> {
		self.state.read().by_id.get(id).cloned()
	}

	/// Looks up a live kernel by its routing name.
	#[must_use]
	pub fn lookup_name(&self, name: &str) -> Option<KernelHandle> {
		let state = self.state.read();
		let id = state.by_name.get(name)?;
		state.by_id.get(id).cloned()
	}

	/// Lists every addressable live kernel.
	#[must_use]
	pub fn list(&self) -> Vec<KernelHandle> {
		self.state.read().by_id.values().cloned().collect()
	}
}

/// Journal-derived metadata for one durable session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredSession {
	/// Session selector, conventionally the `.oms` file stem.
	pub id:         Str,
	/// Canonical journal path.
	pub path:       PathBuf,
	/// Working directory recorded by the genesis frame.
	pub cwd:        Str,
	/// Genesis creation value.
	pub created:    Str,
	/// Journal file modification time in Unix milliseconds.
	pub updated_ms: u64,
	/// Explicit live `<meta name>`, else the first live user prompt.
	pub title:      Option<Str>,
	/// User and assistant messages on the selected live branch.
	pub messages:   u32,
}

impl StoredSession {
	/// Human label for pickers and the welcome box: the first prompt's first
	/// line, else the session id.
	#[must_use]
	pub fn display_name(&self) -> Str {
		self.title.clone().unwrap_or_else(|| self.id.clone())
	}
}

/// Selects exactly the journal prefix that materializes into the live DOM.
fn live_chain(entries: &[omp_journal::Entry]) -> Vec<&omp_journal::Entry> {
	let Some(mut index) = entries.len().checked_sub(1) else {
		return Vec::new();
	};
	let by_id = entries
		.iter()
		.enumerate()
		.map(|(index, entry)| (entry.id, index))
		.collect::<FastHashMap<_, _>>();
	let mut reverse = Vec::new();
	loop {
		let entry = &entries[index];
		reverse.push(entry);
		if let Some(prior) = entry.prior {
			let Some(parent) = by_id.get(&prior) else {
				return Vec::new();
			};
			index = *parent;
		} else if let Some(previous) = index.checked_sub(1) {
			index = previous;
		} else {
			break;
		}
	}
	reverse.reverse();
	reverse
}

fn clean_title(text: &str) -> Option<Str> {
	let line = text.lines().next()?;
	let clean = line
		.chars()
		.filter(|character| !character.is_control())
		.collect::<String>();
	let clean = clean.trim();
	(!clean.is_empty()).then(|| Str::new(clean))
}

/// Derives picker metadata from the selected branch's DOM vocabulary rather
/// than raw file order. `<meta name>` wins over the first live user node.
fn live_metadata(entries: &[omp_journal::Entry]) -> (Option<Str>, u32) {
	let chain = live_chain(entries);
	let user = omp_journal::Kind::known(omp_journal::KindName::MsgUser);
	let assistant = omp_journal::Kind::known(omp_journal::KindName::MsgAssistantStart);
	let patch = omp_journal::Kind::known(omp_journal::KindName::Patch);
	let meta = Dom::new().meta();
	let mut explicit = None;
	let mut first_prompt = None;
	let mut messages = 0_u32;
	for entry in chain {
		if entry.kind == user {
			messages = messages.saturating_add(1);
			if first_prompt.is_none()
				&& let Ok(payload) =
					serde_json::from_str::<omp_journal::data::MsgUser>(entry.data.as_str())
			{
				first_prompt = clean_title(payload.text.as_str());
			}
		} else if entry.kind == assistant {
			messages = messages.saturating_add(1);
		} else if entry.kind == patch
			&& let Ok(payload) = serde_json::from_str::<omp_journal::data::Patch>(entry.data.as_str())
			&& let Ok(ops) = serde_json::from_str::<Vec<Op>>(payload.ops.get())
		{
			for op in ops {
				if let Op::Set { h, prop, value } = op
					&& h == meta
					&& prop == PropId::Name.into()
				{
					explicit = value.as_str().and_then(clean_title);
				}
			}
		}
	}
	(explicit.or(first_prompt), messages)
}

/// Disposable in-memory lookup rebuilt by scanning `.oms` genesis frames.
#[derive(Default)]
pub struct SessionIndex {
	by_id: RwLock<FastHashMap<Str, StoredSession>>,
}

impl SessionIndex {
	/// Scans `root` and builds a disposable index from authoritative journals.
	pub fn open(root: impl AsRef<Path>) -> Result<Self, io::Error> {
		let index = Self::default();
		index.refresh(root)?;
		Ok(index)
	}

	/// Replaces every cached row from the current journal directory contents.
	pub fn refresh(&self, root: impl AsRef<Path>) -> Result<(), io::Error> {
		let mut paths = Vec::new();
		collect_journals(root.as_ref(), &mut paths)?;
		let mut rows = FastHashMap::default();
		for path in paths {
			let entries = match omp_journal::Journal::scan(&path) {
				Ok(opened) => opened,
				Err(error) => {
					tracing::warn!(journal = %path.display(), %error, "skipping invalid session journal");
					continue;
				},
			};
			let Some(genesis) = entries.first() else {
				continue;
			};
			let payload: omp_journal::data::Genesis = match serde_json::from_str(genesis.data.as_str())
			{
				Ok(payload) => payload,
				Err(error) => {
					tracing::warn!(journal = %path.display(), %error, "skipping journal with invalid genesis");
					continue;
				},
			};
			let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
				continue;
			};
			let updated_ms = fs::metadata(&path)?
				.modified()?
				.duration_since(UNIX_EPOCH)
				.unwrap_or_default()
				.as_millis()
				.try_into()
				.unwrap_or(u64::MAX);
			let (title, messages) = live_metadata(&entries);
			rows.insert(Str::new(stem), StoredSession {
				id: Str::new(stem),
				path,
				cwd: payload.cwd,
				created: payload.created,
				updated_ms,
				title,
				messages,
			});
		}
		*self.by_id.write() = rows;
		Ok(())
	}

	/// Looks up one derived durable-session row.
	#[must_use]
	pub fn get(&self, id: &str) -> Option<StoredSession> {
		self.by_id.read().get(id).cloned()
	}

	/// Lists derived sessions newest first.
	#[must_use]
	pub fn list(&self) -> Vec<StoredSession> {
		let mut rows: Vec<_> = self.by_id.read().values().cloned().collect();
		rows.sort_unstable_by(|left, right| {
			right
				.updated_ms
				.cmp(&left.updated_ms)
				.then_with(|| left.id.cmp(&right.id))
		});
		rows
	}

	/// The newest `limit` sessions other than the journal at `exclude`, for
	/// the welcome box's recent-session rows.
	#[must_use]
	pub fn recent(&self, exclude: Option<&Path>, limit: usize) -> Vec<StoredSession> {
		let mut rows = self.list();
		rows.retain(|row| exclude.is_none_or(|exclude| row.path != exclude));
		rows.truncate(limit);
		rows
	}
}

fn collect_journals(directory: &Path, output: &mut Vec<PathBuf>) -> Result<(), io::Error> {
	let entries = match fs::read_dir(directory) {
		Ok(entries) => entries,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
		Err(error) => return Err(error),
	};
	for entry in entries {
		let path = entry?.path();
		if path.is_dir() {
			collect_journals(&path, output)?;
		} else if path.extension().and_then(|value| value.to_str())
			== Some(omp_journal::FILE_EXTENSION)
		{
			output.push(path);
		}
	}
	Ok(())
}

impl SessionAuthority for SessionRegistry {
	fn lookup(&self, id_or_name: &str) -> Option<SessionEndpoint> {
		self
			.lookup(SessionId::from_ref(id_or_name))
			.or_else(|| self.lookup_name(id_or_name))
			.map(|handle| handle.endpoint())
	}

	fn list(&self) -> Vec<SessionEndpoint> {
		SessionRegistry::list(self)
			.into_iter()
			.map(|handle| handle.endpoint())
			.collect()
	}

	fn relay_target(&self, from: &SessionEndpoint, to: &SessionEndpoint) -> Option<SessionEndpoint> {
		let state = self.state.read();
		let live_from = state
			.by_id
			.get(SessionId::from_ref(from.id.as_str()))
			.filter(|live| {
				live.name == from.name
					&& live.up.same_channel(&from.up)
					&& live.topology == from.topology
			})?;
		let live_to = state
			.by_id
			.get(SessionId::from_ref(to.id.as_str()))
			.filter(|live| {
				live.name == to.name && live.up.same_channel(&to.up) && live.topology == to.topology
			})?;
		if live_from.topology.role == SessionRole::Main
			|| live_to.topology.role == SessionRole::Main
			|| live_from.topology.main_id != live_to.topology.main_id
		{
			return None;
		}
		let main = state
			.by_id
			.get(SessionId::from_ref(live_from.topology.main_id.as_str()))?;
		(main.topology.role == SessionRole::Main
			&& main.topology.main_id.as_str() == main.id.as_str()
			&& main.relay.enabled())
		.then(|| main.endpoint())
	}
}

#[cfg(test)]
mod tests {
	use std::time::{Duration, SystemTime};

	use omp_journal::{EntryDraft, Journal, Kind, KindName};

	use super::*;

	fn write_journal(root: &Path, stem: &str, prompt: Option<&str>, age: Duration) -> PathBuf {
		let path = root.join(format!("{stem}.{}", omp_journal::FILE_EXTENSION));
		let mut journal = Journal::create(&path).expect("create journal");
		let genesis = journal
			.append(EntryDraft {
				kind:  Kind::known(KindName::Journal),
				by:    None,
				prior: None,
				label: None,
				data:  Str::new(r#"{"version":1,"cwd":"/w","created":"2026-01-01T00:00:00Z"}"#),
			})
			.expect("genesis");
		if let Some(prompt) = prompt {
			let payload = serde_json::json!({ "text": prompt }).to_string();
			journal
				.append(EntryDraft {
					kind:  Kind::known(KindName::MsgUser),
					by:    Some(genesis.id),
					prior: None,
					label: None,
					data:  Str::new(payload),
				})
				.expect("prompt");
		}
		drop(journal);
		let modified = SystemTime::now() - age;
		fs::File::options()
			.write(true)
			.open(&path)
			.expect("reopen")
			.set_modified(modified)
			.expect("set mtime");
		path
	}

	#[test]
	fn recent_orders_newest_first_and_excludes_the_open_journal() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let root = scratch.path();
		let oldest = write_journal(
			root,
			"old",
			Some("  Fix the parser\nsecond line"),
			Duration::from_secs(300),
		);
		let current = write_journal(root, "current", Some("live prompt"), Duration::from_secs(0));
		let middle = write_journal(root, "mid", None, Duration::from_secs(60));
		let control = write_journal(root, "ctl", Some("\u{7}\t\n"), Duration::from_secs(120));

		let index = SessionIndex::open(root).expect("index");
		let recent = index.recent(Some(&current), 2);
		assert_eq!(
			recent
				.iter()
				.map(|row| row.path.clone())
				.collect::<Vec<_>>(),
			[middle.clone(), control.clone()]
		);
		assert_eq!(recent[0].display_name().as_str(), "mid", "no prompt falls back to the id");
		assert_eq!(
			recent[1].display_name().as_str(),
			"ctl",
			"control-only prompt falls back to the id"
		);

		let all = index.recent(Some(&current), 8);
		assert_eq!(all.iter().map(|row| row.path.clone()).collect::<Vec<_>>(), [
			middle, control, oldest
		]);
		assert_eq!(all[2].display_name().as_str(), "Fix the parser");
		assert_eq!(all[2].messages, 1);
		assert!(index.recent(None, 8).iter().any(|row| row.path == current));
	}

	#[test]
	fn metadata_uses_explicit_name_and_messages_from_the_live_branch() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let path = scratch.path().join("branched.oms");
		let mut session =
			omp_session::Session::create(&path, omp_session::ComponentRegistry::standard())
				.expect("session");
		let cause = session.head().expect("genesis");
		session
			.patch(omp_dom::Txn {
				cause,
				label: Some(Str::new_static("rename")),
				ops: vec![Op::Set {
					h:     session.dom().meta(),
					prop:  PropId::Name.into(),
					value: omp_dom::Value::Str(Str::new_static("Live title")),
				}],
			})
			.expect("live rename");
		session.begin_turn().expect("live turn");
		let live = session
			.user("live prompt", Vec::new())
			.expect("live prompt");
		session.begin_turn().expect("abandoned turn");
		session
			.user("abandoned prompt", Vec::new())
			.expect("abandoned prompt");
		let cause = session.head().expect("abandoned head");
		session
			.patch(omp_dom::Txn {
				cause,
				label: Some(Str::new_static("rename")),
				ops: vec![Op::Set {
					h:     session.dom().meta(),
					prop:  PropId::Name.into(),
					value: omp_dom::Value::Str(Str::new_static("Abandoned title")),
				}],
			})
			.expect("abandoned rename");
		session.rewind(live).expect("rewind");
		session.begin_turn().expect("commit branch selection");
		drop(session);

		let index = SessionIndex::open(scratch.path()).expect("index");
		let stored = index.get("branched").expect("stored session");
		assert_eq!(stored.title.as_deref(), Some("Live title"));
		assert_eq!(stored.messages, 1, "abandoned messages do not count");
	}
}
