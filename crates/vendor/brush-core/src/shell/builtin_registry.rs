//! Builtin command management for shell instances.

use std::collections::HashMap;

use crate::{builtins, extensions};

impl<SE: extensions::ShellExtensions> crate::Shell<SE> {
	/// Register a builtin to the shell's environment, replacing any existing
	/// registration with the same name.
	///
	/// # Arguments
	///
	/// * `name` - The in-shell name of the builtin.
	/// * `registration` - The registration handle for the builtin.
	pub fn register_builtin<S: Into<String>>(
		&mut self,
		name: S,
		registration: builtins::Registration<SE>,
	) {
		self.builtins.insert(name.into(), registration);
	}

	/// Register a builtin only if no builtin with that name is already
	/// registered.
	///
	/// # Arguments
	///
	/// * `name` - The in-shell name of the builtin.
	/// * `registration` - The registration handle for the builtin.
	pub fn register_builtin_if_unset<S: Into<String>>(
		&mut self,
		name: S,
		registration: builtins::Registration<SE>,
	) {
		self.builtins.entry(name.into()).or_insert(registration);
	}

	/// Tries to retrieve a mutable reference to an existing builtin
	/// registration. Returns `None` if no such registration exists.
	///
	/// # Arguments
	///
	/// * `name` - The name of the builtin to lookup.
	pub fn builtin_mut(&mut self, name: &str) -> Option<&mut builtins::Registration<SE>> {
		self.builtins.get_mut(name)
	}

	/// Returns the registered builtins for the shell.
	pub const fn builtins(&self) -> &HashMap<String, builtins::Registration<SE>> {
		&self.builtins
	}
}
