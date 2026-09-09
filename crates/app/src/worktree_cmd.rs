//! Environment-owned worktree discovery and maintenance commands.

#[cfg(not(any(unix, windows)))]
use std::process;
use std::{
	collections::BTreeSet,
	ffi, fs, io,
	path::{Path, PathBuf},
};

use miette::IntoDiagnostic as _;
use serde::{Deserialize, Serialize};

use crate::cli::{WorktreeArgs, WorktreeCommand};

/// Current isolation-owner marker written by workspace operations.
const ISOLATION_OWNER_FILE: &str = ".omp-isolation-owner";
/// Legacy isolation-owner marker recognized during cleanup.
const LEGACY_ISOLATION_OWNER_FILE: &str = ".omp-isolation-owner.json";

/// Owner metadata parsed from an isolation marker file.
#[derive(Debug, Deserialize)]
struct IsolationOwner {
	pid: u32,
}

/// Classification facts derived for a directory without a durable record.
struct Classification {
	class:       &'static str,
	orphan:      bool,
	owner_pid:   Option<u32>,
	source_root: Option<PathBuf>,
	branch:      Option<String>,
	parent_repo: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct DurableRecord {
	version:     u8,
	id:          String,
	root:        PathBuf,
	branch:      Option<String>,
	owner_pid:   u32,
	class:       String,
	source_root: PathBuf,
}

/// One classified worktree found in a current or legacy layout.
#[derive(Clone, Debug, Serialize)]
pub struct WorktreeRow {
	/// Stable Environment identity.
	pub id:          String,
	/// Absolute worktree path.
	pub path:        PathBuf,
	/// `pr-checkout`, `task-isolation`, `empty`, or `stray`.
	pub class:       &'static str,
	/// Whether the recorded owner no longer exists.
	pub orphan:      bool,
	/// Recorded owner process, when metadata is valid.
	pub owner_pid:   Option<u32>,
	/// Source workspace, when metadata is valid.
	pub source_root: Option<PathBuf>,
	/// Internal branch disposition, when one was produced.
	pub branch:      Option<String>,
	/// Containing repository for validated PR checkouts.
	#[serde(skip)]
	pub parent_repo: Option<PathBuf>,
	/// Whether a clear operation removed this worktree.
	pub removed:     Option<bool>,
	/// Failure detail when removal or pruning failed.
	pub error:       Option<String>,
	#[serde(skip)]
	record_path:     Option<PathBuf>,
	#[serde(skip)]
	managed_root:    PathBuf,
	#[serde(skip)]
	record_valid:    bool,
}

fn configured_base(data_dir: &Path) -> io::Result<PathBuf> {
	let settings = omp_driver::settings::current().map_err(io::Error::other)?;
	Ok(omp_env::project_state::worktree_base(data_dir, settings.worktree.base.as_deref()))
}

pub(crate) fn run(data_dir: &Path, args: &WorktreeArgs) -> miette::Result<()> {
	let rows = discover(data_dir).into_diagnostic()?;
	match &args.command {
		WorktreeCommand::List { json, all } => {
			let rows = rows
				.into_iter()
				.filter(|row| *all || row.class != "stray")
				.collect::<Vec<_>>();
			print_rows(&rows, *json).into_diagnostic()
		},
		WorktreeCommand::Clear { all, dry_run, json } => {
			let mut selected = rows
				.into_iter()
				.filter(|row| *all || row.orphan)
				.collect::<Vec<_>>();
			if !dry_run {
				let mut parents_to_prune = BTreeSet::new();
				for row in &mut selected {
					match remove_worktree(row) {
						Ok(parent) => {
							row.removed = Some(true);
							if let Some(parent) = parent {
								parents_to_prune.insert(parent);
							}
						},
						Err(error) => {
							row.removed = Some(false);
							row.error = Some(error.to_string());
						},
					}
				}
				for parent in parents_to_prune {
					if let Err(error) = prune_git_worktrees(&parent) {
						for row in &mut selected {
							if row.parent_repo.as_ref() == Some(&parent) {
								row.removed = Some(false);
								row.error = Some(error.to_string());
							}
						}
					}
				}
			}
			print_rows(&selected, *json).into_diagnostic()
		},
	}
}

fn discover(data_dir: &Path) -> io::Result<Vec<WorktreeRow>> {
	let mut roots = Vec::new();
	let base = configured_base(data_dir)?;
	if base.is_dir() {
		for entry in fs::read_dir(&base)? {
			let entry = entry?;
			if entry.file_type()?.is_dir() {
				roots.push(entry.path());
			}
		}
	}
	let legacy_projects = data_dir.join("projects");
	if legacy_projects.is_dir() {
		for entry in fs::read_dir(legacy_projects)? {
			let legacy = entry?.path().join("workspace-ops");
			if legacy.is_dir() && !roots.contains(&legacy) {
				roots.push(legacy);
			}
		}
	}
	let mut rows = Vec::new();
	for root in roots {
		discover_root(&root, &mut rows)?;
	}
	rows.sort_by(|left, right| left.path.cmp(&right.path));
	Ok(rows)
}

fn discover_root(root: &Path, rows: &mut Vec<WorktreeRow>) -> io::Result<()> {
	let managed_root = fs::canonicalize(root)?;
	let records_dir = managed_root.join(".records");
	if records_dir.is_dir() {
		for entry in fs::read_dir(&records_dir)? {
			let entry = entry?;
			if !entry.file_type()?.is_file() {
				continue;
			}
			let record_path = entry.path();
			let record = fs::read(&record_path).and_then(|bytes| {
				serde_json::from_slice::<DurableRecord>(&bytes)
					.map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
			});
			let Ok(record) = record else {
				rows.push(stray_record(record_path, managed_root.clone()));
				continue;
			};
			let class = match (record.version, record.class.as_str()) {
				(1, "pr-checkout") => Some("pr-checkout"),
				(1, "task-isolation") => Some("task-isolation"),
				_ => None,
			};
			let canonical_path = fs::canonicalize(&record.root).ok();
			let valid = safe_component(&record.id)
				&& entry.file_name() == ffi::OsStr::new(&format!("{}.json", record.id))
				&& canonical_path.as_ref().is_some_and(|path| {
					path.parent() == Some(managed_root.as_path())
						&& path.file_name() == Some(ffi::OsStr::new(&record.id))
				}) && class.is_some();
			if !valid {
				rows.push(stray_record(record_path, managed_root.clone()));
				continue;
			}
			rows.push(WorktreeRow {
				id:           record.id,
				path:         canonical_path.expect("validated canonical worktree"),
				class:        class.expect("validated record class"),
				orphan:       !process_is_live(record.owner_pid),
				owner_pid:    Some(record.owner_pid),
				source_root:  Some(record.source_root),
				branch:       record.branch,
				parent_repo:  None,
				removed:      None,
				error:        None,
				record_path:  Some(record_path),
				managed_root: managed_root.clone(),
				record_valid: true,
			});
		}
	}
	for entry in fs::read_dir(&managed_root)? {
		let entry = entry?;
		let name = entry.file_name();
		if name.to_string_lossy().starts_with('.') || !entry.file_type()?.is_dir() {
			continue;
		}
		let path = fs::canonicalize(entry.path())?;
		if rows.iter().any(|row| row.path == path) {
			continue;
		}
		let classified = classify_unregistered(&path)?;
		rows.push(WorktreeRow {
			id: name.to_string_lossy().into_owned(),
			path,
			class: classified.class,
			orphan: classified.orphan,
			owner_pid: classified.owner_pid,
			source_root: classified.source_root,
			branch: classified.branch,
			parent_repo: classified.parent_repo,
			removed: None,
			error: None,
			record_path: None,
			managed_root: managed_root.clone(),
			record_valid: false,
		});
	}
	Ok(())
}

fn stray_record(record_path: PathBuf, managed_root: PathBuf) -> WorktreeRow {
	WorktreeRow {
		id: record_path
			.file_name()
			.map_or_else(String::new, |name| name.to_string_lossy().into_owned()),
		path: record_path.clone(),
		class: "stray",
		orphan: true,
		owner_pid: None,
		source_root: None,
		branch: None,
		parent_repo: None,
		removed: None,
		error: None,
		record_path: Some(record_path),
		managed_root,
		record_valid: false,
	}
}

fn classify_unregistered(path: &Path) -> io::Result<Classification> {
	if fs::read_dir(path)?.next().is_none() {
		return Ok(Classification {
			class:       "empty",
			orphan:      true,
			owner_pid:   None,
			source_root: None,
			branch:      None,
			parent_repo: None,
		});
	}
	let owner = read_isolation_owner(path);
	let has_mount = ["m", "merged"]
		.into_iter()
		.any(|name| path.join(name).is_dir());
	if owner.is_some() || has_mount {
		let owner_pid = owner.as_ref().map(|owner| owner.pid);
		return Ok(Classification {
			class: "task-isolation",
			orphan: owner_pid.is_none_or(|pid| !process_is_live(pid)),
			owner_pid,
			source_root: None,
			branch: None,
			parent_repo: None,
		});
	}
	if path.join(".git").is_file()
		&& let Some((parent_repo, branch)) = validate_pr_checkout(path)
	{
		return Ok(Classification {
			class:       "pr-checkout",
			orphan:      false,
			owner_pid:   None,
			source_root: None,
			branch:      Some(branch),
			parent_repo: Some(parent_repo),
		});
	}
	Ok(Classification {
		class:       "stray",
		orphan:      true,
		owner_pid:   None,
		source_root: None,
		branch:      None,
		parent_repo: None,
	})
}

fn read_isolation_owner(path: &Path) -> Option<IsolationOwner> {
	[ISOLATION_OWNER_FILE, LEGACY_ISOLATION_OWNER_FILE]
		.into_iter()
		.find_map(|name| {
			fs::read(path.join(name))
				.ok()
				.and_then(|bytes| serde_json::from_slice::<IsolationOwner>(&bytes).ok())
				.filter(|owner| owner.pid != 0)
		})
}

fn validate_pr_checkout(path: &Path) -> Option<(PathBuf, String)> {
	let Ok(pointer) = fs::read_to_string(path.join(".git")) else {
		return None;
	};
	let Some(raw_gitdir) = pointer
		.lines()
		.find_map(|line| line.strip_prefix("gitdir:"))
	else {
		return None;
	};
	let raw_gitdir = raw_gitdir.trim();
	if raw_gitdir.is_empty() {
		return None;
	}
	let gitdir = PathBuf::from(raw_gitdir);
	let gitdir = if gitdir.is_absolute() {
		gitdir
	} else {
		path.join(gitdir)
	};
	let Ok(gitdir) = fs::canonicalize(gitdir) else {
		return None;
	};
	if !gitdir.is_dir() {
		return None;
	}
	let Ok(commondir) = fs::read_to_string(gitdir.join("commondir")) else {
		return None;
	};
	let commondir = commondir.trim();
	if commondir.is_empty() {
		return None;
	}
	let commondir = PathBuf::from(commondir);
	let commondir = if commondir.is_absolute() {
		commondir
	} else {
		gitdir.join(commondir)
	};
	let Ok(commondir) = fs::canonicalize(commondir) else {
		return None;
	};
	if !commondir.is_dir() || commondir.file_name().is_none_or(|name| name != ".git") {
		return None;
	}
	let Some(parent_repo) = commondir.parent() else {
		return None;
	};
	if !parent_repo.is_dir() {
		return None;
	}
	let Ok(head) = fs::read_to_string(gitdir.join("HEAD")) else {
		return None;
	};
	let Some(branch) = head
		.trim()
		.strip_prefix("ref: refs/heads/")
		.filter(|branch| !branch.is_empty())
	else {
		return None;
	};
	Some((parent_repo.to_path_buf(), branch.to_owned()))
}

fn remove_worktree(row: &WorktreeRow) -> io::Result<Option<PathBuf>> {
	let target = validated_mutation_path(row)?;
	let mut parent_to_prune = row.parent_repo.clone();
	if let Some(path) = target.as_deref() {
		if let Some(parent) = &row.parent_repo
			&& row.class == "pr-checkout"
		{
			match omp_vcs::git::GitRepo::discover(parent)
				.and_then(|repo| repo.map_or(Ok(false), |repo| repo.worktree_remove(path, true)))
			{
				Ok(true) => {},
				Ok(false) | Err(_) => {
					remove_path(path)?;
					parent_to_prune = Some(parent.clone());
				},
			}
		} else {
			remove_path(path)?;
		}
	}
	if row.record_valid
		&& let Some(record) = &row.record_path
	{
		let branch = row.managed_root.join(".branches").join(&row.id);
		match fs::remove_file(branch) {
			Ok(()) => {},
			Err(error) if error.kind() == io::ErrorKind::NotFound => {},
			Err(error) => return Err(error),
		}
		prune_empty(&row.managed_root.join(".branches"))?;
		validate_record_path(record, &row.managed_root, Some(&row.id))?;
	}
	if let Some(record) = &row.record_path {
		validate_record_path(record, &row.managed_root, row.record_valid.then_some(row.id.as_str()))?;
		match fs::remove_file(record) {
			Ok(()) => {},
			Err(error) if error.kind() == io::ErrorKind::NotFound => {},
			Err(error) => return Err(error),
		}
		prune_empty(&row.managed_root.join(".records"))?;
	}
	if let Some(path) = target
		&& let Some(parent) = path.parent()
	{
		prune_empty(parent)?;
	}
	Ok(parent_to_prune)
}

fn validated_mutation_path(row: &WorktreeRow) -> io::Result<Option<PathBuf>> {
	let managed_root = fs::canonicalize(&row.managed_root)?;
	if !row.record_valid && row.record_path.as_ref() == Some(&row.path) {
		if let Some(record) = &row.record_path {
			validate_record_path(record, &managed_root, None)?;
		}
		return Ok(None);
	}
	if !safe_component(&row.id) {
		return Err(io::Error::other("worktree id is not a safe path component"));
	}
	let path = fs::canonicalize(&row.path)?;
	if path.parent() != Some(managed_root.as_path())
		|| path.file_name() != Some(ffi::OsStr::new(&row.id))
	{
		return Err(io::Error::other("worktree deletion target is outside the managed root"));
	}
	if row.record_valid {
		let record = row
			.record_path
			.as_deref()
			.ok_or_else(|| io::Error::other("registered worktree has no durable record"))?;
		validate_record_path(record, &managed_root, Some(&row.id))?;
	}
	Ok(Some(path))
}

fn validate_record_path(record: &Path, managed_root: &Path, id: Option<&str>) -> io::Result<()> {
	let records = fs::canonicalize(managed_root.join(".records"))?;
	let record = fs::canonicalize(record)?;
	let expected_name = id.map(|id| format!("{id}.json"));
	if record.parent() != Some(records.as_path())
		|| expected_name
			.as_deref()
			.is_some_and(|name| record.file_name() != Some(ffi::OsStr::new(name)))
	{
		return Err(io::Error::other("worktree record is outside the managed record directory"));
	}
	Ok(())
}

fn safe_component(value: &str) -> bool {
	!value.is_empty()
		&& !value.starts_with('.')
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn remove_path(path: &Path) -> io::Result<()> {
	if path.is_dir() {
		fs::remove_dir_all(path)
	} else if path.exists() {
		fs::remove_file(path)
	} else {
		Ok(())
	}
}

fn prune_git_worktrees(parent: &Path) -> io::Result<()> {
	let Some(repo) = omp_vcs::git::GitRepo::discover(parent).map_err(io::Error::other)? else {
		return Err(io::Error::other("git worktree prune failed"));
	};
	repo.worktree_prune().map_err(io::Error::other)
}

fn prune_empty(path: &Path) -> io::Result<()> {
	if path.is_dir() && fs::read_dir(path)?.next().is_none() {
		fs::remove_dir(path)?;
	}
	Ok(())
}

fn print_rows(rows: &[WorktreeRow], json: bool) -> io::Result<()> {
	use io::Write as _;
	let stdout = io::stdout();
	let mut output = stdout.lock();
	if json {
		serde_json::to_writer_pretty(&mut output, rows).map_err(io::Error::other)?;
		writeln!(output)?;
		return Ok(());
	}
	for row in rows {
		let status = if row.orphan { "orphan" } else { "live" };
		writeln!(output, "{}\t{}\t{}\t{}", row.id, row.class, status, row.path.display())?;
		if let Some(error) = &row.error {
			writeln!(output, "\tfailed: {error}")?;
		}
	}
	Ok(())
}

#[cfg(unix)]
fn process_is_live(pid: u32) -> bool {
	let Ok(pid) = i32::try_from(pid) else {
		return false;
	};
	// SAFETY: signal zero performs only a process-existence/permission probe.
	unsafe {
		libc::kill(pid, 0) == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
	}
}

#[cfg(windows)]
fn process_is_live(pid: u32) -> bool {
	use windows_sys::Win32::{
		Foundation::CloseHandle,
		System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
	};
	// SAFETY: the returned process handle is checked and immediately closed.
	let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
	if handle.is_null() {
		false
	} else {
		// SAFETY: `handle` is a live owned process handle.
		unsafe { CloseHandle(handle) };
		true
	}
}

#[cfg(not(any(unix, windows)))]
fn process_is_live(pid: u32) -> bool {
	pid == process::id()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn classifies_empty_pr_and_stray_layouts() {
		let root = tempfile::tempdir().expect("root");
		let empty = root.path().join("empty");
		fs::create_dir(&empty).expect("empty");
		assert_eq!(classify_unregistered(&empty).unwrap().class, "empty");
		let pr = root.path().join("pr-42");
		fs::create_dir(&pr).expect("pr");
		fs::write(pr.join("file"), b"x").expect("file");
		assert_eq!(classify_unregistered(&pr).unwrap().class, "stray");
		let stray = root.path().join("other");
		fs::create_dir(&stray).expect("stray");
		fs::write(stray.join("file"), b"x").expect("file");
		assert_eq!(classify_unregistered(&stray).unwrap().class, "stray");
	}

	#[test]
	fn corrupt_record_cannot_delete_outside_managed_root() {
		let container = tempfile::tempdir().expect("container");
		let managed = container.path().join("managed");
		let victim = container.path().join("victim");
		fs::create_dir_all(managed.join(".records")).expect("records");
		fs::create_dir(&victim).expect("victim");
		fs::write(victim.join("keep"), b"safe").expect("victim file");
		let record = managed.join(".records/evil.json");
		fs::write(
			&record,
			serde_json::to_vec(&serde_json::json!({
				"version": 1,
				"id": "../../victim",
				"root": victim,
				"branch": "../../victim",
				"owner_pid": u32::MAX,
				"class": "task-isolation",
				"source_root": container.path(),
			}))
			.expect("record json"),
		)
		.expect("record");
		let mut rows = Vec::new();
		discover_root(&managed, &mut rows).expect("discovery");
		assert_eq!(rows.len(), 1);
		assert_eq!(rows[0].class, "stray");
		remove_worktree(&rows[0]).expect("quarantine corrupt record");
		assert!(victim.join("keep").is_file());
		assert!(!record.exists());
	}
}
