//! Path cache

use std::{path::PathBuf, sync::LazyLock};

use crate::{error, variables};

/// A cache of paths associated with names.
#[derive(Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct PathCache {
	/// The cache itself.
	cache:           std::collections::HashMap<String, PathBuf>,
	/// The environment's `PATH` generation
	/// ([`crate::env::ShellEnvironment::path_generation`]) the entries were
	/// found under.
	path_generation: u64,
}

impl PathCache {
	/// An empty cache, which a reader gets in place of one whose entries were
	/// found under an earlier `PATH`.
	pub(crate) fn empty() -> &'static Self {
		static EMPTY: LazyLock<PathCache> = LazyLock::new(PathCache::default);
		&EMPTY
	}

	/// Whether the entries were found under the `PATH` generation `generation`.
	pub(crate) const fn is_current(&self, generation: u64) -> bool {
		self.path_generation == generation
	}

	/// Forgets every entry found under a `PATH` generation other than
	/// `generation`, the way bash empties its hash table whenever `PATH` is
	/// assigned.
	pub(crate) fn forget_unless_current(&mut self, generation: u64) {
		if self.path_generation != generation {
			self.cache.clear();
			self.path_generation = generation;
		}
	}

	/// Clears all elements from the cache.
	pub fn reset(&mut self) {
		self.cache.clear();
	}

	/// Returns the path associated with the given name.
	///
	/// # Arguments
	///
	/// * `name` - The name to lookup.
	pub fn get<S: AsRef<str>>(&self, name: S) -> Option<PathBuf> {
		self.cache.get(name.as_ref()).cloned()
	}

	/// Sets the path associated with the given name.
	///
	/// # Arguments
	///
	/// * `name` - The name to set.
	/// * `path` - The path to associate with the name.
	pub fn set<T: Into<String>>(&mut self, name: T, path: PathBuf) {
		self.cache.insert(name.into(), path);
	}

	/// Projects the cache into a shell value.
	pub fn to_value(&self) -> Result<variables::ShellValue, error::Error> {
		let pairs = self
			.cache
			.iter()
			.map(|(k, v)| (Some(k.to_owned()), v.to_string_lossy().to_string()))
			.collect::<Vec<_>>();

		variables::ShellValue::associative_array_from_literals(variables::ArrayLiteral(pairs))
	}

	/// Removes the path associated with the given name, if there is one.
	/// Returns whether or not an entry was removed.
	///
	/// # Arguments
	///
	/// * `name` - The name to remove.
	pub fn unset<S: AsRef<str>>(&mut self, name: S) -> bool {
		self.cache.remove(name.as_ref()).is_some()
	}
}
