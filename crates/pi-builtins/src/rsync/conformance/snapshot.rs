//! What a run left on disk: every entry under the work directory (the
//! destination, the source for `--remove-source-files`, backup dirs, alternate
//! bases, log files) with the attributes rsync can affect.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use super::normalize::normalize;

/// The name of log files the scenarios write (normalized before comparison).
const LOG_FILE: &str = "rsync.log";

/// An mtime as the comparison sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MtimeClass {
	/// Set to "now" by the run (within the run's window): not preserved, so
	/// the exact value is timing.
	Fresh,
	/// Anything else: a pinned fixture time or a preserved one, compared to
	/// the nanosecond.
	Exact(i64, i64),
	/// A log file, whose mtime is always fresh.
	Log,
}

#[derive(Debug, PartialEq, Eq)]
struct Entry {
	/// `S_IFMT` bits.
	kind: u32,
	/// Permission bits including setuid/setgid/sticky.
	mode: u32,
	uid: u32,
	gid: u32,
	mtime: MtimeClass,
	/// File contents (normalized for log files) or symlink target.
	data: Vec<u8>,
}

/// One tree's state.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Snapshot {
	entries: BTreeMap<Vec<u8>, Entry>,
	/// Paths sharing an inode, per inode (sorted), for every multiply-linked
	/// regular file.
	link_groups: Vec<Vec<Vec<u8>>>,
}

impl Snapshot {
	/// Records `w` after a run that started at `start` and ended at `end`
	/// (Unix nanoseconds).
	pub(super) fn take(w: &Path, start: i128, end: i128) -> Self {
		let mut snap = Self { entries: BTreeMap::new(), link_groups: Vec::new() };
		let mut inodes: HashMap<(u64, u64), Vec<Vec<u8>>> = HashMap::new();
		let window = ((start / 1_000_000_000) as i64, (end / 1_000_000_000) as i64);
		walk(w, w, start, end, window, &mut snap.entries, &mut inodes);
		snap.link_groups = inodes
			.into_values()
			.map(|mut group| {
				group.sort();
				group
			})
			.collect();
		snap.link_groups.sort();
		snap
	}

	/// Human-readable differences from `theirs` (empty when equal).
	pub(super) fn diff(&self, theirs: &Self) -> String {
		let mut report = String::new();
		let keys: std::collections::BTreeSet<&Vec<u8>> =
			self.entries.keys().chain(theirs.entries.keys()).collect();
		for key in keys {
			let name = String::from_utf8_lossy(key);
			match (self.entries.get(key), theirs.entries.get(key)) {
				(Some(_), None) => writeln!(report, "  {name}: only in ours").unwrap(),
				(None, Some(_)) => writeln!(report, "  {name}: only in reference").unwrap(),
				(Some(a), Some(b)) if a != b => {
					let mut what = Vec::new();
					if a.kind != b.kind {
						what.push(format!("type {:o} vs {:o}", a.kind, b.kind));
					}
					if a.mode != b.mode {
						what.push(format!("mode {:04o} vs {:04o}", a.mode, b.mode));
					}
					if (a.uid, a.gid) != (b.uid, b.gid) {
						what.push(format!("owner {}:{} vs {}:{}", a.uid, a.gid, b.uid, b.gid));
					}
					if a.mtime != b.mtime {
						what.push(format!("mtime {:?} vs {:?}", a.mtime, b.mtime));
					}
					if a.data != b.data {
						let at = a.data.iter().zip(&b.data).position(|(x, y)| x != y);
						what.push(format!(
							"data differs (len {} vs {}, first difference at {})",
							a.data.len(),
							b.data.len(),
							at.map_or_else(|| "the shorter end".to_owned(), |at| at.to_string())
						));
						if a.data.len() < 4096 && b.data.len() < 4096 {
							what.push(format!(
								"ours {:?} vs reference {:?}",
								String::from_utf8_lossy(&a.data),
								String::from_utf8_lossy(&b.data)
							));
						}
					}
					writeln!(report, "  {name}: {}", what.join("; ")).unwrap();
				}
				_ => {}
			}
		}
		if self.link_groups != theirs.link_groups {
			let show = |groups: &[Vec<Vec<u8>>]| {
				groups
					.iter()
					.map(|g| g.iter().map(|p| String::from_utf8_lossy(p).into_owned()).collect::<Vec<_>>().join("="))
					.collect::<Vec<_>>()
					.join(", ")
			};
			writeln!(
				report,
				"  hard links: ours [{}] vs reference [{}]",
				show(&self.link_groups),
				show(&theirs.link_groups)
			)
			.unwrap();
		}
		report
	}
}

fn walk(
	w: &Path,
	dir: &Path,
	start: i128,
	end: i128,
	window: (i64, i64),
	entries: &mut BTreeMap<Vec<u8>, Entry>,
	inodes: &mut HashMap<(u64, u64), Vec<Vec<u8>>>,
) {
	for item in fs::read_dir(dir).unwrap() {
		let path = item.unwrap().path();
		let rel = path.strip_prefix(w).unwrap().as_os_str().as_bytes().to_vec();
		let meta = fs::symlink_metadata(&path).unwrap();
		let ns = i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec());
		let fresh = (start - 2_000_000_000..=end + 2_000_000_000).contains(&ns);
		let mut mtime = if fresh { MtimeClass::Fresh } else { MtimeClass::Exact(meta.mtime(), meta.mtime_nsec()) };
		let file_type = meta.file_type();
		let data = if file_type.is_file() {
			let content = fs::read(&path).unwrap();
			if meta.nlink() > 1 {
				inodes.entry((meta.dev(), meta.ino())).or_default().push(rel.clone());
			}
			if path.file_name().is_some_and(|n| n == LOG_FILE) {
				mtime = MtimeClass::Log;
				normalize(&content, w.as_os_str().as_bytes(), window)
			} else {
				content
			}
		} else if file_type.is_symlink() {
			fs::read_link(&path).unwrap().into_os_string().into_encoded_bytes()
		} else {
			Vec::new()
		};
		entries.insert(rel, Entry {
			kind: meta.mode() & 0o170_000,
			mode: meta.mode() & 0o7777,
			uid: meta.uid(),
			gid: meta.gid(),
			mtime,
			data,
		});
		if file_type.is_dir() {
			walk(w, &path, start, end, window, entries, inodes);
		}
	}
}
