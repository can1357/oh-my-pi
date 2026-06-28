//! Implements variables for a shell environment.

use std::{
	borrow::Cow,
	collections::BTreeMap,
	ffi::OsString,
	fmt::{Display, Write},
};

use crate::{
	error, escape, extensions,
	shell::{Shell, ShellState},
};

/// A shell variable.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct ShellVariable {
	/// The value currently associated with the variable.
	value:               ShellValue,
	/// Whether or not the variable is marked as exported to child processes.
	exported:            bool,
	/// Whether or not the variable is marked as read-only.
	readonly:            bool,
	/// Whether or not the variable should be enumerated in the shell's
	/// environment.
	enumerable:          bool,
	/// The transformation to apply to the variable's value when it is updated.
	transform_on_update: ShellVariableUpdateTransform,
	/// Whether or not the variable is marked as being traced.
	trace:               bool,
	/// Whether or not the variable should be treated as an integer.
	treat_as_integer:    bool,
	/// Whether or not the variable should be treated as a name reference.
	treat_as_nameref:    bool,
}

/// Kind of transformation to apply to a variable's value when it is updated.
#[derive(Clone, Copy, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum ShellVariableUpdateTransform {
	/// No transformation.
	None,
	/// Convert the value to lowercase.
	Lowercase,
	/// Convert the value to uppercase.
	Uppercase,
	/// Convert the value to lowercase, with the first character capitalized.
	Capitalize,
}

impl Default for ShellVariable {
	fn default() -> Self {
		Self {
			value:               ShellValue::String(String::new()),
			exported:            false,
			readonly:            false,
			enumerable:          true,
			transform_on_update: ShellVariableUpdateTransform::None,
			trace:               false,
			treat_as_integer:    false,
			treat_as_nameref:    false,
		}
	}
}

impl ShellVariable {
	/// Returns a new shell variable, initialized with the given value.
	///
	/// # Arguments
	///
	/// * `value` - The value to associate with the variable.
	pub fn new<I: Into<ShellValue>>(value: I) -> Self {
		Self { value: value.into(), ..Self::default() }
	}

	/// Returns the value associated with the variable.
	pub const fn value(&self) -> &ShellValue {
		&self.value
	}

	/// Returns whether or not the variable is exported to child processes.
	pub const fn is_exported(&self) -> bool {
		self.exported
	}

	/// Marks the variable as exported to child processes.
	pub const fn export(&mut self) -> &mut Self {
		self.exported = true;
		self
	}

	/// Marks the variable as not exported to child processes.
	pub const fn unexport(&mut self) -> &mut Self {
		self.exported = false;
		self
	}

	/// Returns whether or not the variable is read-only.
	pub const fn is_readonly(&self) -> bool {
		self.readonly
	}

	/// Marks the variable as read-only.
	pub const fn set_readonly(&mut self) -> &mut Self {
		self.readonly = true;
		self
	}

	/// Marks the variable as not read-only.
	pub fn unset_readonly(&mut self) -> Result<&mut Self, error::Error> {
		if self.readonly {
			return Err(error::ErrorKind::ReadonlyVariable.into());
		}

		self.readonly = false;
		Ok(self)
	}

	/// Returns whether or not the variable is traced.
	pub const fn is_trace_enabled(&self) -> bool {
		self.trace
	}

	/// Marks the variable as traced.
	pub const fn enable_trace(&mut self) -> &mut Self {
		self.trace = true;
		self
	}

	/// Marks the variable as not traced.
	pub const fn disable_trace(&mut self) -> &mut Self {
		self.trace = false;
		self
	}

	/// Returns whether or not the variable should be enumerated in the shell's
	/// environment.
	pub const fn is_enumerable(&self) -> bool {
		self.enumerable
	}

	/// Marks the variable as not enumerable in the shell's environment.
	pub const fn hide_from_enumeration(&mut self) -> &mut Self {
		self.enumerable = false;
		self
	}

	/// Return the update transform associated with the variable.
	pub const fn get_update_transform(&self) -> ShellVariableUpdateTransform {
		self.transform_on_update
	}

	/// Set the update transform associated with the variable.
	pub const fn set_update_transform(&mut self, transform: ShellVariableUpdateTransform) {
		self.transform_on_update = transform;
	}

	/// Returns whether or not the variable should be treated as an integer.
	pub const fn is_treated_as_integer(&self) -> bool {
		self.treat_as_integer
	}

	/// Marks the variable as being treated as an integer.
	pub const fn treat_as_integer(&mut self) -> &mut Self {
		self.treat_as_integer = true;
		self
	}

	/// Marks the variable as not being treated as an integer.
	pub const fn unset_treat_as_integer(&mut self) -> &mut Self {
		self.treat_as_integer = false;
		self
	}

	/// Returns whether or not the variable should be treated as a name
	/// reference.
	pub const fn is_treated_as_nameref(&self) -> bool {
		self.treat_as_nameref
	}

	/// Marks the variable as being treated as a name reference.
	pub const fn treat_as_nameref(&mut self) -> &mut Self {
		self.treat_as_nameref = true;
		self
	}

	/// Marks the variable as not being treated as a name reference.
	pub const fn unset_treat_as_nameref(&mut self) -> &mut Self {
		self.treat_as_nameref = false;
		self
	}

	/// Converts the variable to an indexed array.
	pub fn convert_to_indexed_array(&mut self) -> Result<(), error::Error> {
		match self.value() {
			ShellValue::IndexedArray(_) => Ok(()),
			ShellValue::AssociativeArray(_) => {
				Err(error::ErrorKind::ConvertingAssociativeArrayToIndexedArray.into())
			},
			_ => {
				let mut new_values = BTreeMap::new();
				new_values.insert(0, self.value.to_cow_str_without_dynamic_support().to_string());
				self.value = ShellValue::IndexedArray(new_values);
				Ok(())
			},
		}
	}

	/// Converts the variable to an associative array.
	pub fn convert_to_associative_array(&mut self) -> Result<(), error::Error> {
		match self.value() {
			ShellValue::AssociativeArray(_) => Ok(()),
			ShellValue::IndexedArray(_) => {
				Err(error::ErrorKind::ConvertingIndexedArrayToAssociativeArray.into())
			},
			_ => {
				let mut new_values: BTreeMap<String, String> = BTreeMap::new();
				new_values.insert(
					String::from("0"),
					self.value.to_cow_str_without_dynamic_support().to_string(),
				);
				self.value = ShellValue::AssociativeArray(new_values);
				Ok(())
			},
		}
	}

	/// Assign the given value to the variable, conditionally appending to the
	/// preexisting value.
	///
	/// # Arguments
	///
	/// * `value` - The value to assign to the variable.
	/// * `append` - Whether or not to append the value to the preexisting value.
	#[expect(clippy::too_many_lines)]
	pub fn assign(&mut self, value: ShellValueLiteral, append: bool) -> Result<(), error::Error> {
		if self.is_readonly() {
			return Err(error::ErrorKind::ReadonlyVariable.into());
		}

		let value = self.convert_value_literal_for_assignment(value);

		if append {
			match (&self.value, &value) {
				// If we're appending an array to a declared-but-unset variable (or appending
				// anything to a declared-but-unset array), then fill it out first.
				(ShellValue::Unset(_), ShellValueLiteral::Array(_))
				| (
					ShellValue::Unset(
						ShellValueUnsetType::IndexedArray | ShellValueUnsetType::AssociativeArray,
					),
					_,
				) => {
					self.assign(ShellValueLiteral::Array(ArrayLiteral(vec![])), false)?;
				},
				// If we're appending a scalar to a declared-but-unset variable, then
				// start with the empty string. This will result in the right thing happening,
				// even in treat-as-integer cases.
				(ShellValue::Unset(_), ShellValueLiteral::Scalar(_)) => {
					self.assign(ShellValueLiteral::Scalar(String::new()), false)?;
				},
				// If we're trying to append an array to a string, we first promote the string to be
				// an array with the string being present at index 0.
				(ShellValue::String(_), ShellValueLiteral::Array(_)) => {
					self.convert_to_indexed_array()?;
				},
				_ => (),
			}

			let treat_as_int = self.is_treated_as_integer();
			let update_transform = self.get_update_transform();

			match &mut self.value {
				ShellValue::String(base) => match value {
					ShellValueLiteral::Scalar(suffix) => {
						if treat_as_int {
							let int_value =
								base.parse::<i64>().unwrap_or(0) + suffix.parse::<i64>().unwrap_or(0);
							base.clear();
							base.push_str(int_value.to_string().as_str());
						} else {
							base.push_str(suffix.as_str());
							Self::apply_value_transforms(base, treat_as_int, update_transform);
						}
						Ok(())
					},
					ShellValueLiteral::Array(_) => {
						// This case was already handled (see above).
						Ok(())
					},
				},
				ShellValue::IndexedArray(existing_values) => match value {
					ShellValueLiteral::Scalar(new_value) => {
						self.assign_at_index(String::from("0"), new_value, append)
					},
					ShellValueLiteral::Array(new_values) => {
						ShellValue::update_indexed_array_from_literals(existing_values, new_values);
						Ok(())
					},
				},
				ShellValue::AssociativeArray(existing_values) => match value {
					ShellValueLiteral::Scalar(new_value) => {
						self.assign_at_index(String::from("0"), new_value, append)
					},
					ShellValueLiteral::Array(new_values) => {
						ShellValue::update_associative_array_from_literals(existing_values, new_values)
					},
				},
				ShellValue::Unset(_) => unreachable!("covered in conversion above"),
				// TODO(dynamic): implement appending to dynamic vars
				ShellValue::Dynamic { .. } => Ok(()),
			}
		} else {
			match (&self.value, value) {
				// If we're updating an array value with a string, then treat it as an update to
				// just the "0"-indexed element of the array.
				(
					ShellValue::IndexedArray(_)
					| ShellValue::AssociativeArray(_)
					| ShellValue::Unset(
						ShellValueUnsetType::AssociativeArray | ShellValueUnsetType::IndexedArray,
					),
					ShellValueLiteral::Scalar(s),
				) => self.assign_at_index(String::from("0"), s, false),

				// If we're updating an indexed array value with an array, then preserve the array
				// type. We also default to using an indexed array if we are
				// assigning an array to a previously string-holding variable.
				(
					ShellValue::IndexedArray(_)
					| ShellValue::Unset(ShellValueUnsetType::IndexedArray | ShellValueUnsetType::Untyped)
					| ShellValue::String(_)
					| ShellValue::Dynamic { .. },
					ShellValueLiteral::Array(literal_values),
				) => {
					self.value = ShellValue::indexed_array_from_literals(literal_values);
					Ok(())
				},

				// If we're updating an associative array value with an array, then preserve the
				// array type.
				(
					ShellValue::AssociativeArray(_)
					| ShellValue::Unset(ShellValueUnsetType::AssociativeArray),
					ShellValueLiteral::Array(literal_values),
				) => {
					self.value = ShellValue::associative_array_from_literals(literal_values)?;
					Ok(())
				},

				// Handle updates to dynamic values; for now we just drop them.
				// TODO(dynamic): Allow updates to dynamic values
				(ShellValue::Dynamic { .. }, _) => Ok(()),

				// Assign a scalar value to a scalar or unset (and untyped) variable.
				(ShellValue::String(_) | ShellValue::Unset(_), ShellValueLiteral::Scalar(s)) => {
					self.value = ShellValue::String(s);
					Ok(())
				},
			}
		}
	}

	/// Assign the given value to the variable at the given index, conditionally
	/// appending to the preexisting value present at that element within the
	/// value.
	///
	/// # Arguments
	///
	/// * `array_index` - The index at which to assign the value.
	/// * `value` - The value to assign to the variable at the given index.
	/// * `append` - Whether or not to append the value to the preexisting value
	///   stored at the given index.
	pub fn assign_at_index(
		&mut self,
		array_index: String,
		value: String,
		append: bool,
	) -> Result<(), error::Error> {
		match &self.value {
			ShellValue::Unset(_) => {
				self.assign(ShellValueLiteral::Array(ArrayLiteral(vec![])), false)?;
			},
			ShellValue::String(_) => {
				self.convert_to_indexed_array()?;
			},
			_ => (),
		}

		let treat_as_int = self.is_treated_as_integer();
		let value = self.convert_value_str_for_assignment(value);

		match &mut self.value {
			ShellValue::IndexedArray(arr) => {
				let key = get_key_for_indexed_array(arr, array_index.as_str())?;

				if append {
					let existing_value = arr.get(&key).map_or_else(|| "", |v| v.as_str());

					let mut new_value;
					if treat_as_int {
						new_value = (existing_value.parse::<i64>().unwrap_or(0)
							+ value.parse::<i64>().unwrap_or(0))
						.to_string();
					} else {
						new_value = existing_value.to_owned();
						new_value.push_str(value.as_str());
					}

					arr.insert(key, new_value);
				} else {
					arr.insert(key, value);
				}

				Ok(())
			},
			ShellValue::AssociativeArray(arr) => {
				if append {
					let existing_value = arr
						.get(array_index.as_str())
						.map_or_else(|| "", |v| v.as_str());

					let mut new_value;
					if treat_as_int {
						new_value = (existing_value.parse::<i64>().unwrap_or(0)
							+ value.parse::<i64>().unwrap_or(0))
						.to_string();
					} else {
						new_value = existing_value.to_owned();
						new_value.push_str(value.as_str());
					}

					arr.insert(array_index, new_value.clone());
				} else {
					arr.insert(array_index, value);
				}
				Ok(())
			},
			ShellValue::Dynamic { .. } => Ok(()),
			ShellValue::Unset(_) | ShellValue::String(_) => Err(error::ErrorKind::NotArray.into()),
		}
	}

	fn convert_value_literal_for_assignment(&self, value: ShellValueLiteral) -> ShellValueLiteral {
		match value {
			ShellValueLiteral::Scalar(s) => {
				ShellValueLiteral::Scalar(self.convert_value_str_for_assignment(s))
			},
			ShellValueLiteral::Array(literals) => ShellValueLiteral::Array(ArrayLiteral(
				literals
					.0
					.into_iter()
					.map(|(k, v)| (k, self.convert_value_str_for_assignment(v)))
					.collect(),
			)),
		}
	}

	fn convert_value_str_for_assignment(&self, mut s: String) -> String {
		Self::apply_value_transforms(
			&mut s,
			self.is_treated_as_integer(),
			self.get_update_transform(),
		);

		s
	}

	fn apply_value_transforms(
		s: &mut String,
		treat_as_int: bool,
		update_transform: ShellVariableUpdateTransform,
	) {
		if treat_as_int {
			*s = (*s).parse::<i64>().unwrap_or(0).to_string();
		} else {
			match update_transform {
				ShellVariableUpdateTransform::None => (),
				ShellVariableUpdateTransform::Lowercase => *s = (*s).to_lowercase(),
				ShellVariableUpdateTransform::Uppercase => *s = (*s).to_uppercase(),
				ShellVariableUpdateTransform::Capitalize => {
					// This isn't really title-case; only the first character is capitalized.
					*s = s.to_lowercase();
					if let Some(c) = s.chars().next() {
						s.replace_range(0..1, &c.to_uppercase().to_string());
					}
				},
			}
		}
	}

	/// Tries to unset the value stored at the given index in the variable.
	/// Returns whether or not a value was unset.
	///
	/// # Arguments
	///
	/// * `index` - The index at which to unset the value.
	pub fn unset_index(&mut self, index: &str) -> Result<bool, error::Error> {
		match &mut self.value {
			ShellValue::Unset(ty) => match ty {
				ShellValueUnsetType::Untyped => Err(error::ErrorKind::NotArray.into()),
				ShellValueUnsetType::AssociativeArray | ShellValueUnsetType::IndexedArray => Ok(false),
			},
			ShellValue::String(_) => Err(error::ErrorKind::NotArray.into()),
			ShellValue::AssociativeArray(values) => Ok(values.remove(index).is_some()),
			ShellValue::IndexedArray(values) => {
				let key = get_key_for_indexed_array(values, index)?;
				Ok(values.remove(&key).is_some())
			},
			ShellValue::Dynamic { .. } => Ok(false),
		}
	}

	/// Returns the variable's value; for dynamic values, this will resolve the
	/// value.
	///
	/// # Arguments
	///
	/// * `shell` - The shell in which the variable is being resolved.
	pub fn resolve_value(&self, shell: &Shell<impl extensions::ShellExtensions>) -> ShellValue {
		// N.B. We do *not* specially handle a dynamic value that resolves to a dynamic
		// value.
		match &self.value {
			ShellValue::Dynamic { getter, .. } => getter(shell),
			_ => self.value.clone(),
		}
	}

	/// Returns the canonical attribute flag string for this variable.
	pub fn attribute_flags(&self, shell: &Shell<impl extensions::ShellExtensions>) -> String {
		let value = self.resolve_value(shell);

		let mut result = String::new();

		if matches!(
			value,
			ShellValue::IndexedArray(_) | ShellValue::Unset(ShellValueUnsetType::IndexedArray)
		) {
			result.push('a');
		}
		if matches!(
			value,
			ShellValue::AssociativeArray(_) | ShellValue::Unset(ShellValueUnsetType::AssociativeArray)
		) {
			result.push('A');
		}
		if matches!(self.get_update_transform(), ShellVariableUpdateTransform::Capitalize) {
			result.push('c');
		}
		if self.is_treated_as_integer() {
			result.push('i');
		}
		if self.is_treated_as_nameref() {
			result.push('n');
		}
		if self.is_readonly() {
			result.push('r');
		}
		if matches!(self.get_update_transform(), ShellVariableUpdateTransform::Lowercase) {
			result.push('l');
		}
		if self.is_trace_enabled() {
			result.push('t');
		}
		if matches!(self.get_update_transform(), ShellVariableUpdateTransform::Uppercase) {
			result.push('u');
		}
		if self.is_exported() {
			result.push('x');
		}

		result
	}
}

type DynamicValueGetter = fn(&dyn ShellState) -> ShellValue;
type DynamicValueSetter = fn(&dyn ShellState) -> ();

/// A shell value.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum ShellValue {
	/// A value that has been typed but not yet set.
	Unset(ShellValueUnsetType),
	/// A string.
	String(String),
	/// An associative array.
	AssociativeArray(BTreeMap<String, String>),
	/// An indexed array.
	IndexedArray(BTreeMap<u64, String>),
	/// A value that is dynamically computed.
	Dynamic {
		/// Function that can query the value.
		/// TODO(serde): figure out how to serialize/deserialize dynamic values.
		#[cfg_attr(feature = "serde", serde(skip, default = "default_dynamic_value_getter"))]
		getter: DynamicValueGetter,
		/// Function that receives value update requests.
		/// TODO(serde): figure out how to serialize/deserialize dynamic values.
		#[cfg_attr(feature = "serde", serde(skip, default = "default_dynamic_value_setter"))]
		setter: DynamicValueSetter,
	},
}

#[cfg(feature = "serde")]
fn default_dynamic_value_getter() -> DynamicValueGetter {
	|_shell: &dyn ShellState| ShellValue::String(String::new())
}

#[cfg(feature = "serde")]
fn default_dynamic_value_setter() -> DynamicValueSetter {
	|_shell: &dyn ShellState| {}
}

/// The type of an unset shell value.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum ShellValueUnsetType {
	/// The value is untyped.
	Untyped,
	/// The value is an associative array.
	AssociativeArray,
	/// The value is an indexed array.
	IndexedArray,
}

/// A shell value literal; used for assignment.
#[derive(Clone, Debug)]
pub enum ShellValueLiteral {
	/// A scalar value.
	Scalar(String),
	/// An array value.
	Array(ArrayLiteral),
}

impl ShellValueLiteral {
	pub(crate) fn fmt_for_tracing(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Scalar(s) => Self::fmt_scalar_for_tracing(s.as_str(), f),
			Self::Array(elements) => {
				write!(f, "(")?;
				for (i, (key, value)) in elements.0.iter().enumerate() {
					if i > 0 {
						write!(f, " ")?;
					}
					if let Some(key) = key {
						write!(f, "[")?;
						Self::fmt_scalar_for_tracing(key.as_str(), f)?;
						write!(f, "]=")?;
					}
					Self::fmt_scalar_for_tracing(value.as_str(), f)?;
				}
				write!(f, ")")
			},
		}
	}

	fn fmt_scalar_for_tracing(s: &str, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		let processed = escape::quote_if_needed(s, escape::QuoteMode::SingleQuote);
		write!(f, "{processed}")
	}
}

impl Display for ShellValueLiteral {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		self.fmt_for_tracing(f)
	}
}

impl From<&str> for ShellValueLiteral {
	fn from(value: &str) -> Self {
		Self::Scalar(value.to_owned())
	}
}

impl From<String> for ShellValueLiteral {
	fn from(value: String) -> Self {
		Self::Scalar(value)
	}
}

impl From<Vec<&str>> for ShellValueLiteral {
	fn from(value: Vec<&str>) -> Self {
		Self::Array(ArrayLiteral(value.into_iter().map(|s| (None, s.to_owned())).collect()))
	}
}

/// An array literal.
#[derive(Clone, Debug)]
pub struct ArrayLiteral(pub Vec<(Option<String>, String)>);

/// Style for formatting a shell variable's value.
#[derive(Copy, Clone, Debug)]
pub enum FormatStyle {
	/// Basic formatting.
	Basic,
	/// Formatting as appropriate in the `declare` built-in command.
	DeclarePrint,
}

impl ShellValue {
	/// Returns whether or not the value is an array.
	pub const fn is_array(&self) -> bool {
		matches!(
			self,
			Self::IndexedArray(_)
				| Self::AssociativeArray(_)
				| Self::Unset(
					ShellValueUnsetType::IndexedArray | ShellValueUnsetType::AssociativeArray
				)
		)
	}

	/// Returns whether or not the value is set.
	pub const fn is_set(&self) -> bool {
		!matches!(self, Self::Unset(_))
	}

	/// Returns a new indexed array value constructed from the given slice of
	/// owned strings.
	///
	/// # Arguments
	///
	/// * `values` - The slice of strings to construct the indexed array from.
	pub fn indexed_array_from_strings<S>(values: S) -> Self
	where
		S: IntoIterator<Item = String>,
	{
		let mut owned_values = BTreeMap::new();
		for (i, value) in values.into_iter().enumerate() {
			owned_values.insert(i as u64, value);
		}

		Self::IndexedArray(owned_values)
	}

	/// Returns a new indexed array value constructed from the given slice of
	/// unowned strings.
	///
	/// # Arguments
	///
	/// * `values` - The slice of strings to construct the indexed array from.
	pub fn indexed_array_from_strs(values: &[&str]) -> Self {
		let mut owned_values = BTreeMap::new();
		for (i, value) in values.iter().enumerate() {
			owned_values.insert(i as u64, (*value).to_string());
		}

		Self::IndexedArray(owned_values)
	}

	/// Returns a new indexed array value constructed from the given literals.
	///
	/// # Arguments
	///
	/// * `literals` - The literals to construct the indexed array from.
	pub fn indexed_array_from_literals(literals: ArrayLiteral) -> Self {
		let mut values = BTreeMap::new();
		Self::update_indexed_array_from_literals(&mut values, literals);

		Self::IndexedArray(values)
	}

	fn update_indexed_array_from_literals(
		existing_values: &mut BTreeMap<u64, String>,
		literal_values: ArrayLiteral,
	) {
		let mut new_key = if let Some((largest_index, _)) = existing_values.last_key_value() {
			largest_index + 1
		} else {
			0
		};

		for (key, value) in literal_values.0 {
			if let Some(key) = key {
				new_key = key.parse().unwrap_or(0);
			}

			existing_values.insert(new_key, value);
			new_key += 1;
		}
	}

	/// Returns a new associative array value constructed from the given
	/// literals.
	///
	/// # Arguments
	///
	/// * `literals` - The literals to construct the associative array from.
	pub fn associative_array_from_literals(literals: ArrayLiteral) -> Result<Self, error::Error> {
		let mut values = BTreeMap::new();
		Self::update_associative_array_from_literals(&mut values, literals)?;

		Ok(Self::AssociativeArray(values))
	}

	fn update_associative_array_from_literals(
		existing_values: &mut BTreeMap<String, String>,
		literal_values: ArrayLiteral,
	) -> Result<(), error::Error> {
		let mut literal_values = literal_values.0.into_iter();
		let Some((first_key, first_value)) = literal_values.next() else {
			return Ok(());
		};

		if let Some(first_key) = first_key {
			existing_values.insert(first_key, first_value);

			for (key, value) in literal_values {
				let Some(key) = key else {
					return Err(error::ErrorKind::AssociativeArrayMissingSubscript.into());
				};

				existing_values.insert(key, value);
			}
		} else {
			let mut current_key = Some(first_value);
			for (key, value) in literal_values {
				let value = if let Some(key) = key {
					let mut word = String::with_capacity(key.len() + value.len() + 3);
					word.push('[');
					word.push_str(key.as_str());
					word.push_str("]=");
					word.push_str(value.as_str());
					word
				} else {
					value
				};

				if let Some(key) = current_key.take() {
					existing_values.insert(key, value);
				} else {
					current_key = Some(value);
				}
			}

			if let Some(current_key) = current_key {
				existing_values.insert(current_key, String::new());
			}
		}

		Ok(())
	}

	/// Formats the value using the given style.
	///
	/// # Arguments
	///
	/// * `style` - The style to use for formatting the value.
	pub fn format(
		&self,
		style: FormatStyle,
		shell: &Shell<impl extensions::ShellExtensions>,
	) -> Result<Cow<'_, str>, error::Error> {
		match self {
			Self::Unset(_) => Ok("".into()),
			Self::String(s) => match style {
				FormatStyle::Basic => {
					Ok(escape::quote_if_needed(s.as_str(), escape::QuoteMode::SingleQuote))
				},
				FormatStyle::DeclarePrint => {
					Ok(escape::force_quote(s.as_str(), escape::QuoteMode::DoubleQuote).into())
				},
			},
			Self::AssociativeArray(values) => {
				let mut result = String::new();
				result.push('(');

				for (key, value) in values {
					let formatted_key =
						escape::quote_if_needed(key.as_str(), escape::QuoteMode::DoubleQuote);
					let formatted_value =
						escape::force_quote(value.as_str(), escape::QuoteMode::DoubleQuote);

					// N.B. We include an unconditional trailing space character (even after the
					// last entry in the associative array) to match standard
					// output behavior.
					write!(result, "[{formatted_key}]={formatted_value} ")?;
				}

				result.push(')');
				Ok(result.into())
			},
			Self::IndexedArray(values) => {
				let mut result = String::new();
				result.push('(');

				for (i, (key, value)) in values.iter().enumerate() {
					if i > 0 {
						result.push(' ');
					}

					let formatted_value =
						escape::force_quote(value.as_str(), escape::QuoteMode::DoubleQuote);
					write!(result, "[{key}]={formatted_value}")?;
				}

				result.push(')');
				Ok(result.into())
			},
			Self::Dynamic { getter, .. } => {
				let dynamic_value = getter(shell);
				let result = dynamic_value.format(style, shell)?.to_string();
				Ok(result.into())
			},
		}
	}

	/// Tries to retrieve the value stored at the given index in this variable.
	///
	/// # Arguments
	///
	/// * `index` - The index at which to retrieve the value.
	pub fn get_at(
		&self,
		index: &str,
		shell: &Shell<impl extensions::ShellExtensions>,
	) -> Result<Option<Cow<'_, str>>, error::Error> {
		match self {
			Self::Unset(_) => Ok(None),
			Self::String(s) => {
				if index.parse::<u64>().unwrap_or(0) == 0 {
					Ok(Some(Cow::Borrowed(s)))
				} else {
					Ok(None)
				}
			},
			Self::AssociativeArray(values) => Ok(values.get(index).map(|s| Cow::Borrowed(s.as_str()))),
			Self::IndexedArray(values) => {
				let key = get_key_for_indexed_array(values, index)?;
				Ok(values.get(&key).map(|s| Cow::Borrowed(s.as_str())))
			},
			Self::Dynamic { getter, .. } => {
				let dynamic_value = getter(shell);
				let result = dynamic_value.get_at(index, shell)?;
				Ok(result.map(|s| s.to_string().into()))
			},
		}
	}

	/// Returns the keys of the elements in this variable.
	pub fn element_keys(&self, shell: &Shell<impl extensions::ShellExtensions>) -> Vec<String> {
		match self {
			Self::Unset(_) => vec![],
			Self::String(_) => vec!["0".to_owned()],
			Self::AssociativeArray(array) => array.keys().map(|k| k.to_owned()).collect(),
			Self::IndexedArray(array) => array.keys().map(|k| k.to_string()).collect(),
			Self::Dynamic { getter, .. } => getter(shell).element_keys(shell),
		}
	}

	/// Returns the values of the elements in this variable.
	pub fn element_values(&self, shell: &Shell<impl extensions::ShellExtensions>) -> Vec<String> {
		match self {
			Self::Unset(_) => vec![],
			Self::String(s) => vec![s.to_owned()],
			Self::AssociativeArray(array) => array.values().map(|v| v.to_owned()).collect(),
			Self::IndexedArray(array) => array.values().map(|v| v.to_owned()).collect(),
			Self::Dynamic { getter, .. } => getter(shell).element_values(shell),
		}
	}

	/// Converts this value to a string.
	pub fn to_cow_str(&self, shell: &Shell<impl extensions::ShellExtensions>) -> Cow<'_, str> {
		self.try_get_cow_str(shell).unwrap_or(Cow::Borrowed(""))
	}

	fn to_cow_str_without_dynamic_support(&self) -> Cow<'_, str> {
		self
			.try_get_cow_str_without_dynamic_support()
			.unwrap_or(Cow::Borrowed(""))
	}

	/// Tries to convert this value to a string; returns `None` if the value is
	/// unset or otherwise doesn't exist.
	pub fn try_get_cow_str(
		&self,
		shell: &Shell<impl extensions::ShellExtensions>,
	) -> Option<Cow<'_, str>> {
		match self {
			Self::Dynamic { getter, .. } => {
				let dynamic_value = getter(shell);
				dynamic_value
					.try_get_cow_str(shell)
					.map(|s| s.to_string().into())
			},
			_ => self.try_get_cow_str_without_dynamic_support(),
		}
	}

	fn try_get_cow_str_without_dynamic_support(&self) -> Option<Cow<'_, str>> {
		match self {
			Self::Unset(_) => None,
			Self::String(s) => Some(Cow::Borrowed(s.as_str())),
			Self::AssociativeArray(values) => values.get("0").map(|s| Cow::Borrowed(s.as_str())),
			Self::IndexedArray(values) => values.get(&0).map(|s| Cow::Borrowed(s.as_str())),
			Self::Dynamic { .. } => None,
		}
	}

	/// Formats this value as a program string usable in an assignment.
	///
	/// # Arguments
	///
	/// * `index` - The index at which to retrieve the value, if indexing is to
	///   be performed.
	pub fn to_assignable_str(
		&self,
		index: Option<&str>,
		shell: &Shell<impl extensions::ShellExtensions>,
	) -> Result<String, error::Error> {
		match self {
			Self::Unset(_) => Ok(String::new()),
			Self::String(s) => Ok(escape::force_quote(s.as_str(), escape::QuoteMode::SingleQuote)),
			Self::AssociativeArray(_) | Self::IndexedArray(_) => {
				if let Some(index) = index {
					if let Ok(Some(value)) = self.get_at(index, shell) {
						Ok(escape::force_quote(value.as_ref(), escape::QuoteMode::SingleQuote))
					} else {
						Ok(String::new())
					}
				} else {
					Ok(self.format(FormatStyle::DeclarePrint, shell)?.into_owned())
				}
			},
			Self::Dynamic { getter, .. } => getter(shell).to_assignable_str(index, shell),
		}
	}
}

fn get_key_for_indexed_array(
	values: &BTreeMap<u64, String>,
	index_str: &str,
) -> Result<u64, error::Error> {
	let mut index_value = index_str.parse::<i64>().unwrap_or(0);

	// Handle negative indices, but check for out-of-range values.
	#[expect(clippy::cast_possible_wrap)]
	if index_value < 0 {
		index_value += values.len() as i64;
		if index_value < 0 {
			return Err(error::ErrorKind::ArrayIndexOutOfRange(index_str.to_owned()).into());
		}
	}

	// Now that we've confirmed that the index is non-negative, we can safely
	// convert it to a u64 without any fuss.
	#[expect(clippy::cast_sign_loss)]
	Ok(index_value as u64)
}

impl From<&str> for ShellValue {
	fn from(value: &str) -> Self {
		Self::String(value.to_owned())
	}
}

impl From<&String> for ShellValue {
	fn from(value: &String) -> Self {
		Self::String(value.clone())
	}
}

impl From<String> for ShellValue {
	fn from(value: String) -> Self {
		Self::String(value)
	}
}

impl From<OsString> for ShellValue {
	fn from(value: OsString) -> Self {
		Self::String(value.to_string_lossy().into_owned())
	}
}

impl From<Vec<String>> for ShellValue {
	fn from(values: Vec<String>) -> Self {
		Self::indexed_array_from_strings(values)
	}
}

impl From<Vec<&str>> for ShellValue {
	fn from(values: Vec<&str>) -> Self {
		Self::indexed_array_from_strs(values.as_slice())
	}
}
