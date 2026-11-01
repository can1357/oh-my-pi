//! Implements a shell variable environment.

use std::{
	borrow::Cow,
	collections::{HashMap, hash_map},
};

use crate::{
	ExecutionParameters, Shell, error, extensions,
	variables::{self, ShellValue, ShellValueUnsetType, ShellVariable},
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
}

impl Default for ShellEnvironment {
	fn default() -> Self {
		Self::new()
	}
}

impl Drop for ShellEnvironment {
	/// A subshell's environment is a copy of every variable it inherited, and
	/// it is let go of when the subshell ends: `( : )` in a shell holding a
	/// million-element array held the worker 28 ms, and 66 ms under load,
	/// freeing that copy. So the variables are freed where that cannot hold
	/// the worker ([`crate::variables::free_off_worker`]).
	fn drop(&mut self) {
		let elements = self.scopes.iter().map(|(_, map)| map.element_count()).sum();
		crate::variables::free_off_worker(std::mem::take(&mut self.scopes), elements);
	}
}

impl ShellEnvironment {
	/// Returns a new shell environment.
	pub fn new() -> Self {
		Self {
			scopes: vec![(EnvironmentScope::Global, ShellVariableMap::default())],
			export_variables_on_modification: false,
			entry_count: 0,
		}
	}

	/// A copy of this environment for a subshell, every variable copied with
	/// [`ShellVariable::clone_divided`] under one budget, so that neither a
	/// large value nor a great many small ones is copied in one step.
	///
	/// # Errors
	///
	/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part
	/// way, discarding the copy.
	pub(crate) async fn clone_divided(
		&self,
		params: &crate::ExecutionParameters,
	) -> Result<Self, error::Error> {
		let mut budget = crate::interp::ElementBudget::new();
		let mut scopes = Vec::with_capacity(self.scopes.len());
		for (scope, map) in &self.scopes {
			scopes.push((*scope, map.clone_divided(params, &mut budget).await?));
		}
		Ok(Self {
			scopes,
			export_variables_on_modification: self.export_variables_on_modification,
			entry_count: self.entry_count,
		})
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
			Some((actual_scope_type, map)) if actual_scope_type == expected_scope_type => {
				// A function's locals are freed when it returns, and one of
				// them can be an array of any size.
				let elements = map.element_count();
				crate::variables::free_off_worker(map, elements);
				Ok(())
			},
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

	/// The variables [`Self::iter_exported`] yields, found a step at a time.
	///
	/// Finding them looks at every variable of every scope, exported or not,
	/// so the walk is as long as the environment: before an external command,
	/// a million unexported variables held the worker 12.7 ms, and a hundred
	/// thousand exported ones 90.8 ms with the copies made of them, in a walk
	/// and a map built in one step. Each variable looked at is one step of an
	/// [`crate::interp::ElementBudget`]. Shadowing is resolved as
	/// [`Self::iter_exported`] resolves it, the innermost exported variable of
	/// each name winning ([`Self::innermost_divided`]).
	///
	/// # Errors
	///
	/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part
	/// way.
	pub async fn exported_divided(
		&self,
		params: &crate::ExecutionParameters,
	) -> Result<Vec<(&String, &ShellVariable)>, error::Error> {
		self.innermost_divided(params, ShellVariable::is_exported).await
	}

	/// The variables [`Self::iter`] yields — the innermost variable of each
	/// name — found a step at a time, as [`Self::exported_divided`] finds the
	/// exported ones.
	///
	/// # Errors
	///
	/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part
	/// way.
	pub async fn visible_divided(
		&self,
		params: &crate::ExecutionParameters,
	) -> Result<Vec<(&String, &ShellVariable)>, error::Error> {
		self.innermost_divided(params, |_| true).await
	}

	/// The innermost variable of each name among those `counts` accepts,
	/// every variable looked at one step of an
	/// [`crate::interp::ElementBudget`].
	///
	/// **A name is hashed only when it can shadow or be shadowed, and then a
	/// stride at a time.** The walk goes from the innermost scope out and
	/// keeps the names found, keyed by their hash
	/// ([`crate::interp::hash_in_strides`]). Three earlier versions held the
	/// worker. A set that grew as it filled rehashed all of it in one step:
	/// 249 ms at a million exported variables. Looking each name up in every
	/// scope inside its own hashed a 1 MiB exported name once per scope: 16
	/// nested shell functions held `/usr/bin/true` 6.2 ms under load, against
	/// 1.7 at the base. A set keyed by the name itself hashed a 64 MiB exported
	/// name in one call: 10.1 ms quiet and 28.8 loaded, where the lookup before
	/// it never hashed that name at all. The map is sized before the walk, so
	/// it never grows. A name in the outermost scope is never added, since no
	/// scope is left outside it, and is not hashed while no name has been
	/// added, since then nothing can shadow it.
	async fn innermost_divided(
		&self,
		params: &crate::ExecutionParameters,
		counts: fn(&ShellVariable) -> bool,
	) -> Result<Vec<(&String, &ShellVariable)>, error::Error> {
		let mut budget = crate::interp::ElementBudget::new();
		let mut found = Vec::new();
		let state = std::hash::RandomState::new();
		// The names found so far, by hash; only an inner scope's are added.
		let inner_variables = self.scopes.iter().skip(1).map(|(_, map)| map.variables.len()).sum();
		let mut seen: HashMap<u64, Vec<&String>> = HashMap::with_capacity(inner_variables);
		for (depth, (_, var_map)) in self.scopes.iter().enumerate().rev() {
			let outermost = depth == 0;
			for (name, var) in var_map.iter() {
				let due = budget.charge(0);
				if due > 0 {
					crate::interp::loop_checkpoints(params, due).await?;
				}
				if !counts(var) {
					continue;
				}
				if outermost && seen.is_empty() {
					found.push((name, var));
					continue;
				}
				let hash = crate::interp::hash_in_strides(params, &mut budget, &state, name).await?;
				if seen.get(&hash).is_some_and(|names| names.iter().any(|seen_name| *seen_name == name)) {
					continue;
				}
				if !outermost {
					seen.entry(hash).or_default().push(name);
				}
				found.push((name, var));
			}
		}
		Ok(found)
	}

	/// An environment holding `variables` in its one, global scope, for a
	/// caller that built them a step at a time: the map is taken as it is,
	/// not copied or rehashed.
	pub fn with_globals(variables: ShellVariableMap) -> Self {
		let entry_count = variables.variables.len();
		Self {
			scopes: vec![(EnvironmentScope::Global, variables)],
			export_variables_on_modification: false,
			entry_count,
		}
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
	/// An array literal spends a checkpoint on each element (see
	/// [`ShellVariable::assign`]); [`Self::update_or_add_scalar`] assigns a
	/// scalar without a run.
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
	/// * `params` - The execution parameters of the run doing the update.
	pub async fn update_or_add<N: Into<String>>(
		&mut self,
		name: N,
		value: variables::ShellValueLiteral,
		updater: impl Fn(&mut ShellVariable) -> Result<(), error::Error>,
		lookup_policy: EnvironmentLookup,
		scope_if_creating: EnvironmentScope,
		params: &ExecutionParameters,
	) -> Result<(), error::Error> {
		let name = name.into();

		let auto_export = self.export_variables_on_modification;
		if let Some(var) = self.get_mut_using_policy(&name, lookup_policy) {
			var.assign(value, false, params).await?;
			if auto_export {
				var.export();
			}
			updater(var)
		} else {
			let mut var = ShellVariable::new(ShellValue::Unset(ShellValueUnsetType::Untyped));
			var.assign(value, false, params).await?;
			if auto_export {
				var.export();
			}
			updater(&mut var)?;

			self.add(name, var, scope_if_creating)
		}
	}

	/// Update a variable in the environment with a scalar, or add it if it
	/// doesn't already exist.
	///
	/// Nothing in a scalar's assignment grows with how many elements the
	/// variable holds (see [`ShellVariable::assign_scalar`]), so this takes no
	/// run: arithmetic and the shell's own bookkeeping use it.
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
	pub fn update_or_add_scalar<N: Into<String>>(
		&mut self,
		name: N,
		value: String,
		updater: impl Fn(&mut ShellVariable) -> Result<(), error::Error>,
		lookup_policy: EnvironmentLookup,
		scope_if_creating: EnvironmentScope,
	) -> Result<(), error::Error> {
		let name = name.into();

		let auto_export = self.export_variables_on_modification;
		if let Some(var) = self.get_mut_using_policy(&name, lookup_policy) {
			var.assign_scalar(value, false)?;
			if auto_export {
				var.export();
			}
			updater(var)
		} else {
			let mut var = ShellVariable::new(ShellValue::Unset(ShellValueUnsetType::Untyped));
			var.assign_scalar(value, false)?;
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
			var.assign_at_index(index, value, false)?;
			updater(var)
		} else {
			let mut var = ShellVariable::new(ShellValue::indexed_array_with_element(&index, value)?);
			updater(&mut var)?;

			self.add(name, var, scope_if_creating)
		}
	}

	/// [`Self::update_or_add_array_element`] for a caller that has a run to
	/// cancel.
	///
	/// One element can be any size, so its assignment is divided: see
	/// [`ShellVariable::assign_at_index_divided`].
	///
	/// # Errors
	///
	/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part
	/// way, leaving the variable as it was.
	pub async fn update_or_add_array_element_divided<N: Into<String>>(
		&mut self,
		name: N,
		index: String,
		value: String,
		updater: impl Fn(&mut ShellVariable) -> Result<(), error::Error>,
		lookup_policy: EnvironmentLookup,
		scope_if_creating: EnvironmentScope,
		params: &ExecutionParameters,
	) -> Result<(), error::Error> {
		let name = name.into();

		if let Some(var) = self.get_mut_using_policy(&name, lookup_policy) {
			var.assign_at_index_divided(index, value, false, params).await?;
			updater(var)
		} else {
			let mut var = ShellVariable::new(ShellValue::indexed_array_with_element(&index, value)?);
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
///
/// **Each variable is kept with the hash of its name**, so that nothing
/// after the insertion that computed it reads the name to hash it again: a
/// copy ([`Self::clone_divided`]) places every variable by the hash it
/// already has, and so does the table when it grows. A copy that inserted
/// each name into a new `HashMap` hashed every name in one call: an exported
/// variable whose name is 64 MiB long held the worker 11.4 ms on
/// `env -i /usr/bin/true`, and as long on every pipeline stage, subshell and
/// command substitution, 40 ms at 256 MiB. A copy keeps the original's keys,
/// as `HashMap::clone` keeps its hasher, so the hashes stay valid in it.
#[derive(Clone, Debug, Default)]
pub struct ShellVariableMap {
	/// The keys every name in this map is hashed with.
	state:     std::hash::RandomState,
	/// The variables, each beside its name and that name's hash.
	variables: hashbrown::HashTable<Slot>,
}

/// One variable of a [`ShellVariableMap`].
#[derive(Clone, Debug)]
struct Slot {
	/// The hash of `name` under the map's keys.
	hash:     u64,
	name:     String,
	variable: ShellVariable,
}

impl Slot {
	/// Whether this is the slot of `name`, whose hash is `hash`. The hash is
	/// compared first: two names of one length differ in their hashes far
	/// more cheaply than in their bytes.
	fn holds(&self, hash: u64, name: &str) -> bool {
		self.hash == hash && self.name == name
	}
}

impl ShellVariableMap {
	/// An empty map with room for `capacity` variables, for a caller that
	/// knows how many it will add: the table never grows while they go in.
	pub fn with_capacity(capacity: usize) -> Self {
		Self {
			state:     std::hash::RandomState::new(),
			variables: hashbrown::HashTable::with_capacity(capacity),
		}
	}

	//
	// Iterators/Getters
	//

	/// Returns an iterator over all the variables in the map.
	pub fn iter(&self) -> impl Iterator<Item = (&String, &ShellVariable)> {
		self.variables.iter().map(|slot| (&slot.name, &slot.variable))
	}

	/// How many allocations freeing this scope frees: each variable's name,
	/// and each element of its value.
	fn element_count(&self) -> usize {
		self.variables.iter().map(|slot| 1 + slot.variable.value().element_count()).sum()
	}

	/// The hash of `name` under this map's keys, in one step: the name of a
	/// lookup or a plain assignment, which the shell has just read in full.
	fn hash(&self, name: &str) -> u64 {
		crate::interp::hash_in_one_step(&self.state, name)
	}

	/// [`ShellEnvironment::clone_divided`] for one scope. Each variable is
	/// placed by the hash it was stored with; no name is hashed.
	async fn clone_divided(
		&self,
		params: &crate::ExecutionParameters,
		budget: &mut crate::interp::ElementBudget,
	) -> Result<Self, error::Error> {
		let mut variables = hashbrown::HashTable::with_capacity(self.variables.len());
		for slot in self.variables.iter() {
			let name = crate::variables::clone_charged(params, budget, &slot.name).await?;
			let variable = slot.variable.clone_divided(params, budget).await?;
			variables.insert_unique(slot.hash, Slot { hash: slot.hash, name, variable }, |slot| slot.hash);
		}
		Ok(Self { state: self.state.clone(), variables })
	}

	/// Tries to retrieve an immutable reference to the variable with the given
	/// name.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to retrieve.
	pub fn get(&self, name: &str) -> Option<&ShellVariable> {
		let hash = self.hash(name);
		self.variables.find(hash, |slot| slot.holds(hash, name)).map(|slot| &slot.variable)
	}

	/// Tries to retrieve a mutable reference to the variable with the given
	/// name.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to retrieve.
	pub fn get_mut(&mut self, name: &str) -> Option<&mut ShellVariable> {
		let hash = self.hash(name);
		self.variables.find_mut(hash, |slot| slot.holds(hash, name)).map(|slot| &mut slot.variable)
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
		let hash = self.hash(name);
		let slot = self.variables.find_entry(hash, |slot| slot.holds(hash, name)).ok()?;
		Some(slot.remove().0.variable)
	}

	/// Sets a variable in the map.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to set.
	/// * `var` - The variable to set.
	pub fn set<N: Into<String>>(&mut self, name: N, var: ShellVariable) -> Option<ShellVariable> {
		let name = name.into();
		let hash = self.hash(&name);
		self.set_hashed(hash, name, var)
	}

	/// [`Self::set`] for a caller with a run, whose name can be any length:
	/// the name is hashed a stride at a time, each stride a step of `budget`
	/// ([`crate::interp::hash_in_strides`]).
	///
	/// # Errors
	///
	/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part
	/// way, leaving the map as it was.
	pub async fn set_divided(
		&mut self,
		params: &crate::ExecutionParameters,
		budget: &mut crate::interp::ElementBudget,
		name: String,
		var: ShellVariable,
	) -> Result<Option<ShellVariable>, error::Error> {
		let hash = crate::interp::hash_in_strides(params, budget, &self.state, &name).await?;
		Ok(self.set_hashed(hash, name, var))
	}

	/// Sets `name`, whose hash is `hash`, to `var`. A variable already there
	/// keeps its name and gives up its value, as `HashMap::insert` does.
	fn set_hashed(&mut self, hash: u64, name: String, var: ShellVariable) -> Option<ShellVariable> {
		match self.variables.entry(hash, |slot| slot.holds(hash, &name), |slot| slot.hash) {
			hashbrown::hash_table::Entry::Occupied(mut slot) => {
				Some(std::mem::replace(&mut slot.get_mut().variable, var))
			},
			hashbrown::hash_table::Entry::Vacant(slot) => {
				slot.insert(Slot { hash, name, variable: var });
				None
			},
		}
	}
}

/// Written as the map of names to variables it holds, in the shape the
/// derived implementation gave the `HashMap` this map used to be.
#[cfg(feature = "serde")]
impl serde::Serialize for ShellVariableMap {
	fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		struct Variables<'a>(&'a ShellVariableMap);

		impl serde::Serialize for Variables<'_> {
			fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
				serializer.collect_map(self.0.iter())
			}
		}

		use serde::ser::SerializeStruct as _;
		let mut map = serializer.serialize_struct("ShellVariableMap", 1)?;
		map.serialize_field("variables", &Variables(self))?;
		map.end()
	}
}

/// Read from the shape [`ShellVariableMap`]'s `Serialize` writes, every name
/// hashed under new keys.
#[cfg(feature = "serde")]
impl<'de> serde::Deserialize<'de> for ShellVariableMap {
	fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		#[derive(serde::Deserialize)]
		#[serde(rename = "ShellVariableMap")]
		struct Written {
			variables: HashMap<String, ShellVariable>,
		}

		let written = Written::deserialize(deserializer)?;
		let mut map = Self::with_capacity(written.variables.len());
		for (name, variable) in written.variables {
			map.set(name, variable);
		}
		Ok(map)
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
