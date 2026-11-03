//! Implements a shell variable environment.

use std::{
	borrow::Cow,
	collections::{BTreeMap, HashMap, hash_map},
	sync::Arc,
};

use crate::{
	Shell, alias_expansion, error, extensions,
	variables::{self, AssignmentHook, ShellValue, ShellValueUnsetType, ShellVariable},
};

/// Represents the policy for looking up variables in a shell environment.
#[derive(Clone, Copy)]
pub enum EnvironmentLookup {
	/// Look anywhere.
	Anywhere,
	/// Look only in the global scope.
	OnlyInGlobal,
	/// Look only in the current local scope.    
	OnlyInCurrentLocal,
	/// Look only in local scopes.
	OnlyInLocal,
}

/// Represents a shell environment scope.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum EnvironmentScope {
	/// Scope local to a function instance
	Local,
	/// Globals
	Global,
	/// Transient overrides for a command invocation
	Command,
}

impl std::fmt::Display for EnvironmentScope {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Local => write!(f, "local"),
			Self::Global => write!(f, "global"),
			Self::Command => write!(f, "command"),
		}
	}
}

/// A guard that pushes a scope onto a shell environment and pops it when
/// dropped.
pub(crate) struct ScopeGuard<'a, SE: extensions::ShellExtensions> {
	scope_type: EnvironmentScope,
	shell:      &'a mut crate::Shell<SE>,
	detached:   bool,
}

impl<'a, SE: extensions::ShellExtensions> ScopeGuard<'a, SE> {
	/// Creates a new scope guard, pushing the given scope type onto the
	/// environment.
	///
	/// # Arguments
	///
	/// * `shell` - The shell whose environment to modify.
	/// * `scope_type` - The type of scope to push.
	pub fn new(shell: &'a mut crate::Shell<SE>, scope_type: EnvironmentScope) -> Self {
		shell.env_mut().push_scope(scope_type);
		Self { scope_type, shell, detached: false }
	}

	/// Returns a mutable reference to the shell.
	pub const fn shell(&mut self) -> &mut crate::Shell<SE> {
		self.shell
	}

	/// Detaches the guard, preventing it from popping the scope on drop.
	pub const fn detach(&mut self) {
		self.detached = true;
	}
}

impl<SE: extensions::ShellExtensions> Drop for ScopeGuard<'_, SE> {
	fn drop(&mut self) {
		if !self.detached {
			let _ = self.shell.env_mut().pop_scope(self.scope_type);
		}
	}
}

/// Represents the shell variable environment, composed of a stack of scopes.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct ShellEnvironment {
	/// Stack of scopes, with the top of the stack being the current scope.
	scopes: Vec<(EnvironmentScope, ShellVariableMap)>,
	/// Whether or not to auto-export variables on creation or modification.
	export_variables_on_modification: bool,
	/// Count of total entries (may include duplicates with shadowed variables).
	entry_count: usize,
	/// The shell's aliases, shared with the readers that read input with them
	/// until the shell changes them. They live with the variables because an
	/// assignment to `BASH_ALIASES` defines aliases (see
	/// [`ShellEnvironment::run_assignment_hooks`]).
	aliases: brush_parser::AliasTable,
	/// Names that assignments to `BASH_ALIASES` gave and Bash rejects as alias
	/// names, kept for the shell to report.
	rejected_alias_names: Vec<String>,
}

impl Default for ShellEnvironment {
	fn default() -> Self {
		Self::new()
	}
}

impl ShellEnvironment {
	/// Returns a new shell environment.
	pub fn new() -> Self {
		Self {
			scopes: vec![(EnvironmentScope::Global, ShellVariableMap::default())],
			export_variables_on_modification: false,
			entry_count: 0,
			aliases: brush_parser::AliasTable::default(),
			rejected_alias_names: vec![],
		}
	}

	/// Pushes a new scope of the given type onto the environment's scope stack.
	///
	/// # Arguments
	///
	/// * `scope_type` - The type of scope to push.
	pub fn push_scope(&mut self, scope_type: EnvironmentScope) {
		self.scopes.push((scope_type, ShellVariableMap::default()));
	}

	/// Pops the top-most scope off the environment's scope stack.
	///
	/// # Arguments
	///
	/// * `expected_scope_type` - The type of scope that is expected to be atop
	///   the stack.
	pub fn pop_scope(&mut self, expected_scope_type: EnvironmentScope) -> Result<(), error::Error> {
		// TODO(env): Should we panic instead on failure? It's effectively a broken
		// invariant.
		match self.scopes.pop() {
			Some((actual_scope_type, _)) if actual_scope_type == expected_scope_type => Ok(()),
			Some((actual_scope_type, _)) => Err(
				error::ErrorKind::UnexpectedScopeType {
					expected: expected_scope_type,
					actual:   actual_scope_type,
				}
				.into(),
			),
			None => Err(error::ErrorKind::MissingScope.into()),
		}
	}

	//
	// Aliases
	//

	/// Returns the shell's aliases.
	pub fn aliases(&self) -> &HashMap<String, String> {
		&self.aliases
	}

	/// Returns a mutable reference to the shell's aliases.
	pub fn aliases_mut(&mut self) -> &mut HashMap<String, String> {
		Arc::make_mut(&mut self.aliases)
	}

	/// Returns the alias table, shared until the shell changes it.
	pub fn alias_table(&self) -> brush_parser::AliasTable {
		Arc::clone(&self.aliases)
	}

	fn alias_elements(&self) -> BTreeMap<String, String> {
		self.aliases
			.iter()
			.map(|(name, value)| (name.clone(), value.clone()))
			.collect()
	}

	/// The value `BASH_ALIASES` reads while it is the view of the alias table:
	/// an associative array of the aliases. As in Bash, reading it refreshes
	/// the variable's stored copy (see [`AssignmentHook`]).
	pub fn alias_table_view(&self) -> ShellValue {
		let elements = self.alias_elements();
		if let Some(var) = self.hooked_variable(AssignmentHook::AliasTable) {
			var.refresh_stored_copy(elements.clone());
		}
		ShellValue::AssociativeArray(elements)
	}

	/// The global variable that carries `hook`, while it does.
	fn hooked_variable(&self, hook: AssignmentHook) -> Option<&ShellVariable> {
		let name = match hook {
			AssignmentHook::AliasTable => "BASH_ALIASES",
		};
		self.get_using_policy(name, EnvironmentLookup::OnlyInGlobal)
			.filter(|var| var.assignment_hook() == Some(hook))
	}

	fn hooked_variable_mut(&mut self, hook: AssignmentHook) -> Option<&mut ShellVariable> {
		let name = match hook {
			AssignmentHook::AliasTable => "BASH_ALIASES",
		};
		self.get_mut_using_policy(name, EnvironmentLookup::OnlyInGlobal)
			.filter(|var| var.assignment_hook() == Some(hook))
	}

	/// Looks `name` up as Bash does before it assigns to an element of a
	/// variable, assigns a list to it or declares it: a hooked variable's
	/// stored copy is refreshed first, so an append reads the current aliases.
	/// (An assignment of a single value to the variable's name does not look it
	/// up this way, so its append reads the stored copy as it was.)
	pub fn refresh_hooked_variable(&self, name: &str) {
		if let Some((_, var)) = self.get(name)
			&& var.assignment_hook() == Some(AssignmentHook::AliasTable)
		{
			var.refresh_stored_copy(self.alias_elements());
		}
	}

	/// Acts on the elements assigned to hooked variables, as Bash's assignment
	/// functions do: each element assigned to `BASH_ALIASES` defines an alias
	/// named by its key. A key Bash rejects as an alias name defines none; it
	/// is kept for the shell to report ([`Self::take_rejected_alias_names`]).
	/// The variable's stored copy then becomes the alias table, as in Bash.
	pub fn run_assignment_hooks(&mut self) {
		let Some(var) = self.hooked_variable_mut(AssignmentHook::AliasTable) else {
			return;
		};
		let assigned = var.take_hooked_assignments();
		if assigned.is_empty() {
			return;
		}
		let aliases = Arc::make_mut(&mut self.aliases);
		for (name, value) in assigned {
			if alias_expansion::is_legal_alias_name(&name) {
				aliases.insert(name, value);
			} else {
				self.rejected_alias_names.push(name);
			}
		}
		let elements = self.alias_elements();
		if let Some(var) = self.hooked_variable(AssignmentHook::AliasTable) {
			var.refresh_stored_copy(elements);
		}
	}

	/// Takes the names that assignments to `BASH_ALIASES` gave and Bash rejects
	/// as alias names (see [`Self::run_assignment_hooks`]).
	pub fn take_rejected_alias_names(&mut self) -> Vec<String> {
		std::mem::take(&mut self.rejected_alias_names)
	}

	//
	// Iterators/Getters
	//

	/// Returns an iterator over all exported variables defined in the variable.
	pub fn iter_exported(&self) -> impl Iterator<Item = (&String, &ShellVariable)> {
		// We won't actually need to store all entries, but we expect it should be
		// within the same order.
		let mut visible_vars: HashMap<&String, &ShellVariable> =
			HashMap::with_capacity(self.entry_count);

		for (_, var_map) in self.scopes.iter().rev() {
			for (name, var) in var_map.iter().filter(|(_, v)| v.is_exported()) {
				// Only insert the variable if it hasn't been seen yet.
				if let hash_map::Entry::Vacant(entry) = visible_vars.entry(name) {
					entry.insert(var);
				}
			}
		}

		visible_vars.into_iter()
	}

	/// Returns an iterator over all the variables defined in the environment.
	pub fn iter(&self) -> impl Iterator<Item = (&String, &ShellVariable)> {
		self.iter_using_policy(EnvironmentLookup::Anywhere)
	}

	/// Returns an iterator over all the variables defined in the environment,
	/// using the given lookup policy.
	///
	/// # Arguments
	///
	/// * `lookup_policy` - The policy to use when looking up variables.
	pub fn iter_using_policy(
		&self,
		lookup_policy: EnvironmentLookup,
	) -> impl Iterator<Item = (&String, &ShellVariable)> {
		// We won't actually need to store all entries, but we expect it should be
		// within the same order.
		let mut visible_vars: HashMap<&String, &ShellVariable> =
			HashMap::with_capacity(self.entry_count);

		let mut local_count = 0;
		for (scope_type, var_map) in self.scopes.iter().rev() {
			if matches!(scope_type, EnvironmentScope::Local) {
				local_count += 1;
			}

			match lookup_policy {
				EnvironmentLookup::Anywhere => (),
				EnvironmentLookup::OnlyInGlobal => {
					if !matches!(scope_type, EnvironmentScope::Global) {
						continue;
					}
				},
				EnvironmentLookup::OnlyInCurrentLocal => {
					if !(matches!(scope_type, EnvironmentScope::Local) && local_count == 1) {
						continue;
					}
				},
				EnvironmentLookup::OnlyInLocal => {
					if !matches!(scope_type, EnvironmentScope::Local) {
						continue;
					}
				},
			}

			for (name, var) in var_map.iter() {
				// Only insert the variable if it hasn't been seen yet.
				if let hash_map::Entry::Vacant(entry) = visible_vars.entry(name) {
					entry.insert(var);
				}
			}

			if matches!(scope_type, EnvironmentScope::Local)
				&& matches!(lookup_policy, EnvironmentLookup::OnlyInCurrentLocal)
			{
				break;
			}
		}

		visible_vars.into_iter()
	}

	/// Tries to retrieve an immutable reference to the variable with the given
	/// name in the environment.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to retrieve.
	pub fn get<S: AsRef<str>>(&self, name: S) -> Option<(EnvironmentScope, &ShellVariable)> {
		// Look through scopes, from the top of the stack on down.
		for (scope_type, map) in self.scopes.iter().rev() {
			if let Some(var) = map.get(name.as_ref()) {
				return Some((*scope_type, var));
			}
		}

		None
	}

	/// Tries to retrieve a mutable reference to the variable with the given name
	/// in the environment.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to retrieve.
	pub fn get_mut<S: AsRef<str>>(
		&mut self,
		name: S,
	) -> Option<(EnvironmentScope, &mut ShellVariable)> {
		// Look through scopes, from the top of the stack on down.
		for (scope_type, map) in self.scopes.iter_mut().rev() {
			if let Some(var) = map.get_mut(name.as_ref()) {
				return Some((*scope_type, var));
			}
		}

		None
	}

	/// Tries to retrieve the string value of the variable with the given name in
	/// the environment.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to retrieve.
	/// * `shell` - The shell owning the environment.
	pub fn get_str<S: AsRef<str>, SE: extensions::ShellExtensions>(
		&self,
		name: S,
		shell: &Shell<SE>,
	) -> Option<Cow<'_, str>> {
		self
			.get(name.as_ref())
			.map(|(_, v)| v.value().to_cow_str(shell))
	}

	/// Checks if a variable of the given name is set in the environment.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to check.
	pub fn is_set<S: AsRef<str>>(&self, name: S) -> bool {
		if let Some((_, var)) = self.get(name) {
			!matches!(var.value(), ShellValue::Unset(_))
		} else {
			false
		}
	}

	//
	// Setters
	//

	/// Tries to unset the variable with the given name in the environment,
	/// returning whether or not such a variable existed.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to unset.
	pub fn unset(&mut self, name: &str) -> Result<Option<ShellVariable>, error::Error> {
		let mut local_count = 0;
		for (scope_type, map) in self.scopes.iter_mut().rev() {
			if matches!(scope_type, EnvironmentScope::Local) {
				local_count += 1;
			}

			let unset_result = Self::try_unset_in_map(map, name)?;

			if unset_result.is_some() {
				// If we end up finding a local in the top-most local frame, then we replace
				// it with a placeholder.
				if matches!(scope_type, EnvironmentScope::Local) && local_count == 1 {
					map.set(name, ShellVariable::new(ShellValue::Unset(ShellValueUnsetType::Untyped)));
				} else if self.entry_count > 0 {
					// Entry count should never be 0 here, but we're being defensive.
					self.entry_count -= 1;
				}

				return Ok(unset_result);
			}
		}

		Ok(None)
	}

	/// Tries to unset an array element from the environment, using the given
	/// name and element index for lookup. Returns whether or not an element was
	/// unset.
	///
	/// # Arguments
	///
	/// * `name` - The name of the array variable to unset an element from.
	/// * `index` - The index of the element to unset.
	pub fn unset_index(&mut self, name: &str, index: &str) -> Result<bool, error::Error> {
		// Bash looks the variable up first, which refreshes a hooked variable's
		// stored copy; the element then leaves that copy only.
		self.refresh_hooked_variable(name);
		if let Some((_, var)) = self.get_mut(name) {
			var.unset_index(index)
		} else {
			Ok(false)
		}
	}

	fn try_unset_in_map(
		map: &mut ShellVariableMap,
		name: &str,
	) -> Result<Option<ShellVariable>, error::Error> {
		match map.get(name).map(|v| v.is_readonly()) {
			Some(true) => Err(error::ErrorKind::ReadonlyVariable.into()),
			Some(false) => Ok(map.unset(name)),
			None => Ok(None),
		}
	}

	/// Tries to retrieve an immutable reference to a variable from the
	/// environment, using the given name and lookup policy.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to retrieve.
	/// * `lookup_policy` - The policy to use when looking up the variable.
	pub fn get_using_policy<N: AsRef<str>>(
		&self,
		name: N,
		lookup_policy: EnvironmentLookup,
	) -> Option<&ShellVariable> {
		let mut local_count = 0;
		for (scope_type, var_map) in self.scopes.iter().rev() {
			if matches!(scope_type, EnvironmentScope::Local) {
				local_count += 1;
			}

			match lookup_policy {
				EnvironmentLookup::Anywhere => (),
				EnvironmentLookup::OnlyInGlobal => {
					if !matches!(scope_type, EnvironmentScope::Global) {
						continue;
					}
				},
				EnvironmentLookup::OnlyInCurrentLocal => {
					if !(matches!(scope_type, EnvironmentScope::Local) && local_count == 1) {
						continue;
					}
				},
				EnvironmentLookup::OnlyInLocal => {
					if !matches!(scope_type, EnvironmentScope::Local) {
						continue;
					}
				},
			}

			if let Some(var) = var_map.get(name.as_ref()) {
				return Some(var);
			}

			if matches!(scope_type, EnvironmentScope::Local)
				&& matches!(lookup_policy, EnvironmentLookup::OnlyInCurrentLocal)
			{
				break;
			}
		}

		None
	}

	/// Tries to retrieve a mutable reference to a variable from the environment,
	/// using the given name and lookup policy.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to retrieve.
	/// * `lookup_policy` - The policy to use when looking up the variable.
	pub fn get_mut_using_policy<N: AsRef<str>>(
		&mut self,
		name: N,
		lookup_policy: EnvironmentLookup,
	) -> Option<&mut ShellVariable> {
		let mut local_count = 0;
		for (scope_type, var_map) in self.scopes.iter_mut().rev() {
			if matches!(scope_type, EnvironmentScope::Local) {
				local_count += 1;
			}

			match lookup_policy {
				EnvironmentLookup::Anywhere => (),
				EnvironmentLookup::OnlyInGlobal => {
					if !matches!(scope_type, EnvironmentScope::Global) {
						continue;
					}
				},
				EnvironmentLookup::OnlyInCurrentLocal => {
					if !(matches!(scope_type, EnvironmentScope::Local) && local_count == 1) {
						continue;
					}
				},
				EnvironmentLookup::OnlyInLocal => {
					if !matches!(scope_type, EnvironmentScope::Local) {
						continue;
					}
				},
			}

			if let Some(var) = var_map.get_mut(name.as_ref()) {
				return Some(var);
			}

			if matches!(scope_type, EnvironmentScope::Local)
				&& matches!(lookup_policy, EnvironmentLookup::OnlyInCurrentLocal)
			{
				break;
			}
		}

		None
	}

	/// Update a variable in the environment, or add it if it doesn't already
	/// exist.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to update or add.
	/// * `value` - The value to assign to the variable.
	/// * `updater` - A function to call to update the variable after assigning
	///   the value.
	/// * `lookup_policy` - The policy to use when looking up the variable.
	/// * `scope_if_creating` - The scope to create the variable in if it doesn't
	///   already exist.
	pub fn update_or_add<N: Into<String>>(
		&mut self,
		name: N,
		value: variables::ShellValueLiteral,
		updater: impl Fn(&mut ShellVariable) -> Result<(), error::Error>,
		lookup_policy: EnvironmentLookup,
		scope_if_creating: EnvironmentScope,
	) -> Result<(), error::Error> {
		let name = name.into();

		let auto_export = self.export_variables_on_modification;
		if let Some(var) = self.get_mut_using_policy(&name, lookup_policy) {
			let assigned = var.assign(value, false);
			if assigned.is_ok() && auto_export {
				var.export();
			}
			let updated = assigned.and_then(|()| updater(var));
			self.run_assignment_hooks();
			updated
		} else {
			let mut var = ShellVariable::new(ShellValue::Unset(ShellValueUnsetType::Untyped));
			var.assign(value, false)?;
			if auto_export {
				var.export();
			}
			updater(&mut var)?;

			self.add(name, var, scope_if_creating)
		}
	}

	/// Update an array element in the environment, or add it if it doesn't
	/// already exist.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to update or add.
	/// * `index` - The index of the element to update or add.
	/// * `value` - The value to assign to the variable.
	/// * `updater` - A function to call to update the variable after assigning
	///   the value.
	/// * `lookup_policy` - The policy to use when looking up the variable.
	/// * `scope_if_creating` - The scope to create the variable in if it doesn't
	///   already exist.
	pub fn update_or_add_array_element<N: Into<String>>(
		&mut self,
		name: N,
		index: String,
		value: String,
		updater: impl Fn(&mut ShellVariable) -> Result<(), error::Error>,
		lookup_policy: EnvironmentLookup,
		scope_if_creating: EnvironmentScope,
	) -> Result<(), error::Error> {
		let name = name.into();

		if let Some(var) = self.get_mut_using_policy(&name, lookup_policy) {
			let updated = var.assign_at_index(index, value, false).and_then(|()| updater(var));
			self.run_assignment_hooks();
			updated
		} else {
			let mut var = ShellVariable::new(ShellValue::Unset(ShellValueUnsetType::Untyped));
			var.assign(
				variables::ShellValueLiteral::Array(variables::ArrayLiteral(vec![(
					Some(index),
					value,
				)])),
				false,
			)?;
			updater(&mut var)?;

			self.add(name, var, scope_if_creating)
		}
	}

	/// Adds a variable to the environment.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to add.
	/// * `var` - The variable to add.
	/// * `target_scope` - The scope to add the variable to.
	pub fn add<N: Into<String>>(
		&mut self,
		name: N,
		mut var: ShellVariable,
		target_scope: EnvironmentScope,
	) -> Result<(), error::Error> {
		if self.export_variables_on_modification {
			var.export();
		}

		for (scope_type, map) in self.scopes.iter_mut().rev() {
			if *scope_type == target_scope {
				let prev_var = map.set(name, var);
				if prev_var.is_none() {
					self.entry_count += 1;
				}

				return Ok(());
			}
		}

		Err(error::ErrorKind::MissingScopeForNewVariable.into())
	}

	/// Sets a global variable in the environment.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to set.
	/// * `var` - The variable to set.
	pub fn set_global<N: Into<String>>(
		&mut self,
		name: N,
		var: ShellVariable,
	) -> Result<(), error::Error> {
		self.add(name, var, EnvironmentScope::Global)
	}
}

/// Represents a map from names to shell variables.
#[derive(Clone, Debug, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct ShellVariableMap {
	variables: HashMap<String, ShellVariable>,
}

impl ShellVariableMap {
	//
	// Iterators/Getters
	//

	/// Returns an iterator over all the variables in the map.
	pub fn iter(&self) -> impl Iterator<Item = (&String, &ShellVariable)> {
		self.variables.iter()
	}

	/// Tries to retrieve an immutable reference to the variable with the given
	/// name.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to retrieve.
	pub fn get(&self, name: &str) -> Option<&ShellVariable> {
		self.variables.get(name)
	}

	/// Tries to retrieve a mutable reference to the variable with the given
	/// name.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to retrieve.
	pub fn get_mut(&mut self, name: &str) -> Option<&mut ShellVariable> {
		self.variables.get_mut(name)
	}

	//
	// Setters
	//

	/// Tries to unset the variable with the given name, returning the removed
	/// variable or None if it was not already set.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to unset.
	pub fn unset(&mut self, name: &str) -> Option<ShellVariable> {
		self.variables.remove(name)
	}

	/// Sets a variable in the map.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to set.
	/// * `var` - The variable to set.
	pub fn set<N: Into<String>>(&mut self, name: N, var: ShellVariable) -> Option<ShellVariable> {
		self.variables.insert(name.into(), var)
	}
}

/// Checks if the given name is a valid variable name.
pub fn valid_variable_name(s: &str) -> bool {
	let mut cs = s.chars();
	match cs.next() {
		Some(c) if c.is_ascii_alphabetic() || c == '_' => {
			cs.all(|c| c.is_ascii_alphanumeric() || c == '_')
		},
		Some(_) | None => false,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_valid_variable_name() {
		assert!(!valid_variable_name(""));
		assert!(!valid_variable_name("1"));
		assert!(!valid_variable_name(" a"));
		assert!(!valid_variable_name(" "));

		assert!(valid_variable_name("_"));
		assert!(valid_variable_name("_a"));
		assert!(valid_variable_name("_1"));
		assert!(valid_variable_name("_a1"));
		assert!(valid_variable_name("a"));
		assert!(valid_variable_name("A"));
		assert!(valid_variable_name("a1"));
		assert!(valid_variable_name("A1"));
	}
}
