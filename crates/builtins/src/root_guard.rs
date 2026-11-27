//! Refusal of whole-disk walks.
//!
//! The recursive search utilities (`find`, `grep -r`, `rg`, `fd`, `ast-grep`)
//! decline a starting point that names a filesystem root: a walk of `/` visits
//! every file on the machine and runs for hours, and is almost always a
//! mistake for "search here". A walk capped at [`SHALLOW_DEPTH`] or an explicit
//! opt-in flag still goes ahead.
//!
//! ```ignore
//! if !cli.allow_root {
//! 	root_guard::check(roots, cli.max_depth, FLAGS)?;
//! }
//! ```

use std::{
	error::Error,
	fmt,
	path::{Path, PathBuf},
};

/// Deepest walk below a filesystem root allowed without the opt-in: the
/// root's entries and theirs list quickly, while each further level
/// approaches a full disk scan.
pub(crate) const SHALLOW_DEPTH: usize = 2;

/// How a utility spells the options a [`Refusal`] points to.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Flags {
	/// Option that permits the walk (`-allow-root`, `--allow-root`).
	pub allow: &'static str,
	/// Option capping the walk depth (`-maxdepth`, `--max-depth`), when the
	/// utility has one.
	pub depth: Option<&'static str>,
}

/// A declined walk; displays as the diagnostic explaining why and what to run
/// instead, for the utility to print under its own prefix.
#[derive(Debug)]
pub(crate) struct Refusal {
	root:  PathBuf,
	flags: Flags,
}

impl fmt::Display for Refusal {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(
			f,
			"refusing to search the filesystem root '{}'.\n\
			 You most likely did not mean this. Never search a full disk: walking every file on the \
			 machine can take hours to days.\n\
			 Search the directory you actually need instead: the current directory (`.`), the \
			 project root, or a specific subdirectory.",
			self.root.display()
		)?;
		if let Some(depth) = self.flags.depth {
			write!(f, "\nA shallow look at the root is allowed: up to `{depth} {SHALLOW_DEPTH}`.")?;
		}
		write!(f, "\nPass {} only when a whole-disk search was explicitly requested.", self.flags.allow)
	}
}

impl Error for Refusal {}

/// Declines the walk when one of the resolved `roots` names a filesystem root
/// (`/`, `/usr/..`, `C:\`) and `max_depth` does not cap it at
/// [`SHALLOW_DEPTH`]. Callers skip the check when their opt-in flag is set.
///
/// `..` is resolved lexically, so `/tmp/..` counts as `/` even where `/tmp`
/// is a symlink. URL providers (`scheme://`) are never whole disks.
///
/// # Errors
/// The [`Refusal`] for the first root found.
pub(crate) fn check(
	roots: impl IntoIterator<Item = impl AsRef<Path>>,
	max_depth: Option<usize>,
	flags: Flags,
) -> Result<(), Refusal> {
	if max_depth.is_some_and(|depth| depth <= SHALLOW_DEPTH) {
		return Ok(());
	}
	match roots.into_iter().find_map(|root| filesystem_root(root.as_ref())) {
		Some(root) => Err(Refusal { root, flags }),
		None => Ok(()),
	}
}

/// The filesystem root `resolved` names, if it names one.
fn filesystem_root(resolved: &Path) -> Option<PathBuf> {
	if omp_vfs::is_virtual_path(resolved) {
		return None;
	}
	let normalized = omp_vfs::normalize_lexically(resolved);
	(normalized.has_root() && normalized.parent().is_none()).then_some(normalized)
}

#[cfg(test)]
mod tests {
	use super::*;

	const FLAGS: Flags = Flags { allow: "--allow-root", depth: Some("--max-depth") };

	fn refused(root: &str, max_depth: Option<usize>) -> bool {
		check([root], max_depth, FLAGS).is_err()
	}

	#[cfg(unix)]
	#[test]
	fn refuses_every_spelling_of_the_root_and_nothing_below_it() {
		for root in ["/", "//", "/usr/..", "/./"] {
			assert!(refused(root, None), "{root}");
		}
		for path in ["/usr", "/usr/../tmp", "local://", "ssh://host/"] {
			assert!(!refused(path, None), "{path}");
		}
	}

	#[cfg(unix)]
	#[test]
	fn depth_cap_at_two_permits_the_walk() {
		assert!(!refused("/", Some(SHALLOW_DEPTH)));
		assert!(refused("/", Some(SHALLOW_DEPTH + 1)));
	}
}
