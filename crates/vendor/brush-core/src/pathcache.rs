//! Path cache

use std::path::PathBuf;

use crate::variables;

/// A cache of paths associated with names.
#[derive(Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct PathCache {
	/// The cache itself.
	cache: std::collections::HashMap<String, PathBuf>,
}

impl PathCache {
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

	/// Projects the cache into a shell value: an associative array from each
	/// name to its path.
	pub fn to_value(&self) -> variables::ShellValue {
		variables::ShellValue::AssociativeArray(
			self.cache
				.iter()
				.map(|(name, path)| (name.to_owned(), path.to_string_lossy().to_string()))
				.collect(),
		)
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
