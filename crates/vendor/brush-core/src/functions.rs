//! Structures for managing function registrations and calls.

use std::{collections::HashMap, sync::Arc};

/// An environment for defined, named functions.
#[derive(Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct FunctionEnv {
	functions: HashMap<String, Registration>,
}

impl FunctionEnv {
	/// Tries to retrieve the registration for a function by name.
	///
	/// # Arguments
	///
	/// * `name` - The name of the function to retrieve.
	pub fn get(&self, name: &str) -> Option<&Registration> {
		self.functions.get(name)
	}

	/// Tries to retrieve a mutable reference to the registration for a
	/// function by name.
	///
	/// # Arguments
	///
	/// * `name` - The name of the function to retrieve.
	pub fn get_mut(&mut self, name: &str) -> Option<&mut Registration> {
		self.functions.get_mut(name)
	}

	/// Unregisters a function from the environment.
	///
	/// # Arguments
	///
	/// * `name` - The name of the function to remove.
	pub fn remove(&mut self, name: &str) -> Option<Registration> {
		self.functions.remove(name)
	}

	/// Updates a function registration in this environment.
	///
	/// # Arguments
	///
	/// * `name` - The name of the function to update.
	/// * `registration` - The new registration for the function.
	pub fn update(&mut self, name: String, registration: Registration) {
		self.functions.insert(name, registration);
	}

	/// Clear all functions in this environment.
	pub fn clear(&mut self) {
		self.functions.clear();
	}

	/// Returns an iterator over the functions registered in this environment.
	pub fn iter(&self) -> impl Iterator<Item = (&String, &Registration)> {
		self.functions.iter()
	}
}

/// Encapsulates a registration for a defined function.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Registration {
	/// The parsed definition of the function.
	definition:  Arc<brush_parser::ast::FunctionDefinition>,
	/// The source info for the function definition.
	source_info: crate::SourceInfo,
	/// Whether or not this function definition should be exported to children.
	exported:    bool,
}

impl From<brush_parser::ast::FunctionDefinition> for Registration {
	fn from(definition: brush_parser::ast::FunctionDefinition) -> Self {
		Self {
			definition:  Arc::new(definition),
			source_info: crate::SourceInfo::default(),
			exported:    false,
		}
	}
}

impl Registration {
	/// Creates a new function registration.
	///
	/// # Arguments
	///
	/// * `definition` - The function definition.
	/// * `source_info` - Source information for the function definition.
	pub fn new(
		definition: brush_parser::ast::FunctionDefinition,
		source_info: &crate::SourceInfo,
	) -> Self {
		Self {
			definition:  Arc::new(definition),
			source_info: source_info.clone(),
			exported:    false,
		}
	}

	/// Returns a reference to the function definition.
	pub fn definition(&self) -> &brush_parser::ast::FunctionDefinition {
		&self.definition
	}

	/// Returns a reference to the source info for the function definition.
	pub const fn source(&self) -> &crate::SourceInfo {
		&self.source_info
	}

	/// Marks the function for export.
	pub const fn export(&mut self) {
		self.exported = true;
	}

	/// Unmarks the function for export.
	pub const fn unexport(&mut self) {
		self.exported = false;
	}

	/// Returns whether this function is exported.
	pub const fn is_exported(&self) -> bool {
		self.exported
	}
}
