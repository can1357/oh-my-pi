//! Environment-owned containment and publication authority for generated
//! skills.

use std::{
	collections::{BTreeMap, BTreeSet},
	fs::{self, Metadata, OpenOptions},
	io::{self, Write as _},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
};

use bytes::BytesMut;
use omp_agent::{GateError, HookEvent, HookGate, HookPatch};
use omp_core::Str;
use omp_proto::toolhost::v1::HookEventId;
use omp_tools::manage_skill::{
	Action, AuthorityError, ManagedSkillAuthority, MutationOutcome, MutationRequest,
};
use parking_lot::Mutex;
use serde::Serialize;

use crate::managed_skills_domain::{CandidateError, ManagedSkillCandidate, is_valid_name};

#[derive(Serialize)]
struct ManagedResourceRef<'a> {
	uri:    &'a str,
	kind:   &'static str,
	origin: &'static str,
}

#[derive(Serialize)]
struct ManagedResourcesChangedEvent<'a> {
	added:   Box<[ManagedResourceRef<'a>]>,
	removed: Box<[ManagedResourceRef<'a>]>,
	reason:  &'static str,
}

impl HookEvent for ManagedResourcesChangedEvent<'_> {
	type Return = ();

	const ID: HookEventId = HookEventId::HookEventResourcesChanged;
	const REV: u32 = 1;

	fn encode_into(&self, out: &mut BytesMut) {
		out.extend_from_slice(b"\n");
		out.extend_from_slice(
			&serde_json::to_vec(self).expect("managed resource payload must serialize to JSON"),
		);
	}

	fn apply(&mut self, _: &HookPatch) -> Result<(), GateError> {
		Ok(())
	}
}

/// Environment authority for one profile-scoped managed-skill root.
pub struct ManagedSkills {
	root:           PathBuf,
	authored_names: BTreeSet<Str>,
	hooks:          Arc<HookGate>,
	mutation_locks: Mutex<BTreeMap<Str, Arc<Mutex<()>>>>,
	revision:       AtomicU64,
	temp_sequence:  AtomicU64,
}

impl ManagedSkills {
	/// Creates an authority with an immutable set of authored names which
	/// generated skills may never claim.
	pub fn new(root: PathBuf, authored_names: BTreeSet<Str>, hooks: Arc<HookGate>) -> Self {
		Self {
			root,
			authored_names,
			hooks,
			mutation_locks: Mutex::new(BTreeMap::new()),
			revision: AtomicU64::new(0),
			temp_sequence: AtomicU64::new(0),
		}
	}

	fn notify_changed(&self, action: Action, name: &str) {
		if !self
			.hooks
			.subscribed(HookEventId::HookEventResourcesChanged)
		{
			return;
		}
		let uri = self.root.join(name).join("SKILL.md");
		let uri = uri.to_string_lossy();
		let resource = || ManagedResourceRef {
			uri:    uri.as_ref(),
			kind:   "skill",
			origin: crate::managed_skills_domain::PROVIDER_ID,
		};
		let (added, removed) = match action {
			Action::Create => (vec![resource()].into_boxed_slice(), Vec::new().into_boxed_slice()),
			Action::Update => {
				(vec![resource()].into_boxed_slice(), vec![resource()].into_boxed_slice())
			},
			Action::Delete => (Vec::new().into_boxed_slice(), vec![resource()].into_boxed_slice()),
		};
		self
			.hooks
			.notify(&ManagedResourcesChangedEvent { added, removed, reason: "reload" });
	}

	fn serialize_name<'a>(&self, raw: &'a str) -> Result<(Str, NameLock<'_>), AuthorityError> {
		let normalized = raw.trim().to_ascii_lowercase();
		if !is_valid_name(&normalized) {
			return Err(AuthorityError::InvalidName);
		}
		let name = Str::from(normalized);
		let lock = {
			let mut locks = self.mutation_locks.lock();
			Arc::clone(
				locks
					.entry(name.clone())
					.or_insert_with(|| Arc::new(Mutex::new(()))),
			)
		};
		Ok((name.clone(), NameLock { owner: self, name, lock }))
	}

	fn mutate_locked(
		&self,
		name: &Str,
		request: MutationRequest<'_>,
	) -> Result<MutationOutcome, AuthorityError> {
		self.ensure_root()?;
		let directory = self.root.join(name.as_str());
		match request.action {
			Action::Create => {
				if self.authored_names.contains(name) {
					return Err(AuthorityError::AuthoredShadow);
				}
				let candidate = self.candidate(request)?;
				self.ensure_skill_directory(&directory, true)?;
				let file = directory.join("SKILL.md");
				write_exclusive(&file, candidate.serialize().as_bytes())?;
			},
			Action::Update => {
				let candidate = self.candidate(request)?;
				self.ensure_skill_directory(&directory, false)?;
				let file = directory.join("SKILL.md");
				self.atomic_replace(&directory, &file, candidate.serialize().as_bytes())?;
			},
			Action::Delete => {
				self.ensure_skill_directory(&directory, false)?;
				let file = directory.join("SKILL.md");
				if let Ok(metadata) = fs::symlink_metadata(&file) {
					ensure_regular_unlinked(&metadata)?;
				}
				fs::remove_dir_all(&directory).map_err(map_io)?;
			},
		}
		let revision = self
			.revision
			.fetch_add(1, Ordering::AcqRel)
			.saturating_add(1);
		Ok(MutationOutcome {
			action: request.action,
			name: name.clone(),
			path: Str::from(format!("{}/SKILL.md", name.as_str())),
			revision,
		})
	}

	fn candidate(
		&self,
		request: MutationRequest<'_>,
	) -> Result<ManagedSkillCandidate, AuthorityError> {
		let description = request
			.description
			.ok_or(AuthorityError::InvalidDescription)?;
		let body = request.body.ok_or(AuthorityError::EmptyBody)?;
		ManagedSkillCandidate::new(request.name, description, body).map_err(|error| match error {
			CandidateError::InvalidName => AuthorityError::InvalidName,
			CandidateError::InvalidDescription => AuthorityError::InvalidDescription,
			CandidateError::EmptyBody => AuthorityError::EmptyBody,
			CandidateError::TooLarge => AuthorityError::TooLarge,
		})
	}

	fn ensure_root(&self) -> Result<(), AuthorityError> {
		match fs::symlink_metadata(&self.root) {
			Ok(metadata) => ensure_directory(&metadata),
			Err(error) if error.kind() == io::ErrorKind::NotFound => {
				let parent = self.root.parent().ok_or(AuthorityError::UnsafePath)?;
				fs::create_dir_all(parent).map_err(map_io)?;
				match fs::create_dir(&self.root) {
					Ok(()) => Ok(()),
					Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
						let metadata = fs::symlink_metadata(&self.root).map_err(map_io)?;
						ensure_directory(&metadata)
					},
					Err(error) => Err(map_io(error)),
				}
			},
			Err(error) => Err(map_io(error)),
		}
	}

	fn ensure_skill_directory(&self, directory: &Path, create: bool) -> Result<(), AuthorityError> {
		match fs::symlink_metadata(directory) {
			Ok(metadata) => ensure_directory(&metadata),
			Err(error) if error.kind() == io::ErrorKind::NotFound && create => {
				match fs::create_dir(directory) {
					Ok(()) => Ok(()),
					Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
						let metadata = fs::symlink_metadata(directory).map_err(map_io)?;
						ensure_directory(&metadata)
					},
					Err(error) => Err(map_io(error)),
				}
			},
			Err(error) if error.kind() == io::ErrorKind::NotFound => Err(AuthorityError::NotFound),
			Err(error) => Err(map_io(error)),
		}
	}

	#[cfg(unix)]
	fn atomic_replace(
		&self,
		directory: &Path,
		file: &Path,
		bytes: &[u8],
	) -> Result<(), AuthorityError> {
		let metadata = fs::symlink_metadata(file).map_err(map_update_io)?;
		ensure_regular_unlinked(&metadata)?;
		let sequence = self.temp_sequence.fetch_add(1, Ordering::Relaxed);
		let temporary = directory.join(format!(".SKILL.md.{}.{}.tmp", std::process::id(), sequence));
		let result = (|| {
			write_exclusive(&temporary, bytes)?;
			ensure_directory(&fs::symlink_metadata(directory).map_err(map_io)?)?;
			ensure_regular_unlinked(&fs::symlink_metadata(file).map_err(map_update_io)?)?;
			fs::rename(&temporary, file).map_err(map_io)
		})();
		if result.is_err() {
			let _ = fs::remove_file(&temporary);
		}
		result
	}

	#[cfg(windows)]
	fn atomic_replace(
		&self,
		_directory: &Path,
		file: &Path,
		bytes: &[u8],
	) -> Result<(), AuthorityError> {
		use std::os::windows::fs::OpenOptionsExt as _;
		const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
		let metadata = fs::symlink_metadata(file).map_err(map_update_io)?;
		ensure_regular_unlinked(&metadata)?;
		let mut handle = OpenOptions::new()
			.write(true)
			.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
			.open(file)
			.map_err(map_update_io)?;
		ensure_regular_unlinked(&handle.metadata().map_err(map_io)?)?;
		handle.set_len(0).map_err(map_io)?;
		handle.write_all(bytes).map_err(map_io)?;
		handle.sync_all().map_err(map_io)
	}
}

impl ManagedSkillAuthority for ManagedSkills {
	fn mutate(&self, request: MutationRequest<'_>) -> Result<MutationOutcome, AuthorityError> {
		let action = request.action;
		let (name, lock) = self.serialize_name(request.name)?;
		let guard = lock.lock.lock();
		let outcome = self.mutate_locked(&name, request);
		drop(guard);
		drop(lock);
		if outcome.is_ok() {
			self.notify_changed(action, name.as_str());
		}
		outcome
	}
}

#[must_use]
struct NameLock<'a> {
	owner: &'a ManagedSkills,
	name:  Str,
	lock:  Arc<Mutex<()>>,
}

impl Drop for NameLock<'_> {
	fn drop(&mut self) {
		let mut locks = self.owner.mutation_locks.lock();
		if Arc::strong_count(&self.lock) == 2
			&& locks
				.get(&self.name)
				.is_some_and(|current| Arc::ptr_eq(current, &self.lock))
		{
			locks.remove(&self.name);
		}
	}
}

fn write_exclusive(path: &Path, bytes: &[u8]) -> Result<(), AuthorityError> {
	let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
		Ok(file) => file,
		Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
			return Err(AuthorityError::AlreadyExists);
		},
		Err(error) => return Err(map_io(error)),
	};
	file.write_all(bytes).map_err(map_io)?;
	file.sync_all().map_err(map_io)
}

fn ensure_directory(metadata: &Metadata) -> Result<(), AuthorityError> {
	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		Err(AuthorityError::UnsafePath)
	} else {
		Ok(())
	}
}

fn ensure_regular_unlinked(metadata: &Metadata) -> Result<(), AuthorityError> {
	if metadata.file_type().is_symlink() || !metadata.is_file() || link_count(metadata) > 1 {
		Err(AuthorityError::UnsafePath)
	} else {
		Ok(())
	}
}

#[cfg(unix)]
fn link_count(metadata: &Metadata) -> u64 {
	use std::os::unix::fs::MetadataExt as _;
	metadata.nlink()
}

#[cfg(windows)]
fn link_count(metadata: &Metadata) -> u64 {
	use std::os::windows::fs::MetadataExt as _;
	u64::from(metadata.number_of_links())
}

fn map_update_io(error: io::Error) -> AuthorityError {
	if error.kind() == io::ErrorKind::NotFound {
		AuthorityError::NotFound
	} else {
		map_io(error)
	}
}

fn map_io(_: io::Error) -> AuthorityError {
	AuthorityError::Io
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn serializes_mutations_and_refuses_links_and_authored_shadows() {
		let tree = tempfile::tempdir().unwrap();
		let root = tree.path().join("managed-skills");
		let authority = ManagedSkills::new(
			root.clone(),
			BTreeSet::from([Str::from("authored")]),
			Arc::new(HookGate::channel().0),
		);
		let shadowed = authority.mutate(MutationRequest {
			action:      Action::Create,
			name:        "authored",
			description: Some("when useful"),
			body:        Some("body"),
		});
		assert_eq!(shadowed, Err(AuthorityError::AuthoredShadow));
		let created = authority
			.mutate(MutationRequest {
				action:      Action::Create,
				name:        "new-skill",
				description: Some("when useful"),
				body:        Some("body"),
			})
			.unwrap();
		assert_eq!(created.revision, 1);
		assert!(root.join("new-skill/SKILL.md").is_file());
	}
}
