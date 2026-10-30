//! Implements variables for a shell environment.

use std::{
	borrow::Cow,
	collections::BTreeMap,
	ffi::OsString,
	fmt::{Display, Write},
};

use crate::{
	ExecutionParameters, error, escape, extensions, interp,
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
				new_values.insert(0, self.take_scalar());
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
				// Moved rather than copied, for the reason given on
				// [`Self::convert_to_indexed_array`]: `declare -A` on an
				// existing scalar is the same caller-sized copy.
				new_values.insert(String::from("0"), self.take_scalar());
				self.value = ShellValue::AssociativeArray(new_values);
				Ok(())
			},
		}
	}

	/// Takes this variable's value out as a string, leaving it unset.
	///
	/// Moved rather than copied where there is something to move: a scalar
	/// can be any size, and promoting a 64 MiB one to an array held the
	/// worker 25.8 ms in that copy, before the divided path it leads to had
	/// begun. A copy of a caller-sized value needs a checkpoint wherever it
	/// sits — and this one needs no copy at all.
	fn take_scalar(&mut self) -> String {
		match std::mem::replace(&mut self.value, ShellValue::Unset(ShellValueUnsetType::Untyped)) {
			ShellValue::String(text) => text,
			// Nothing else owns a `String` to hand over, and a dynamic value
			// has to be asked for one.
			other => {
				let text = other.to_cow_str_without_dynamic_support().to_string();
				self.value = other;
				text
			},
		}
	}

	/// Assign the given value to the variable, conditionally appending to the
	/// preexisting value.
	///
	/// An array literal can hold any number of elements, so its assignment
	/// spends a checkpoint on each one (see [`Self::assign_array`]). A scalar
	/// is one value, but one value can be a whole array joined into a string,
	/// so its conversion is divided too: `copy="${huge[@]}$open"` held the
	/// worker 94.8 ms at 64 MiB and 734.9 ms at 512 MiB through the
	/// synchronous [`Self::assign_scalar`].
	///
	/// **Every route into a variable converts its value exactly once, and
	/// where that one conversion goes depends on the operation**:
	///
	/// - a **replacement** converts the value;
	/// - a **scalar append** converts the concatenation, because that is the
	///   value the variable ends up holding;
	/// - an **element** is appended to, so its conversion belongs to the
	///   value arriving.
	///
	/// "Convert once" without "where" is not enough to go on, and saying only
	/// that is what let `declare -c x; x+=ßeta` answer `Sseta` where the
	/// whole string gives `SSeta`: [`ShellVariableUpdateTransform::Capitalize`]
	/// is not idempotent for a character whose uppercase form is longer than
	/// it, so converting the value and then the result lowercases everything
	/// after the first expansion. An exhaustive scan of the 103 such
	/// characters found 478 wrong answers in 45,360 comparisons.
	///
	/// # Arguments
	///
	/// * `value` - The value to assign to the variable.
	/// * `append` - Whether or not to append the value to the preexisting value.
	/// * `params` - The execution parameters of the run doing the assignment.
	pub async fn assign(
		&mut self,
		value: ShellValueLiteral,
		append: bool,
		params: &ExecutionParameters,
	) -> Result<(), error::Error> {
		match value {
			ShellValueLiteral::Scalar(value) => {
				if self.is_readonly() {
					return Err(error::ErrorKind::ReadonlyVariable.into());
				}
				// Not converted here: every route below converts once, and
				// where it converts matters — an append converts the
				// concatenation, not the value and then the result.
				self.place_scalar_divided(value, append, params).await
			},
			ShellValueLiteral::Array(literal) => self.assign_array(literal, append, params).await,
		}
	}

	/// Assign the given scalar to the variable, conditionally appending to the
	/// preexisting value. On an array this sets (or appends to) element `0`.
	///
	/// Nothing here is proportional to how many elements the variable holds,
	/// so it needs no checkpoint and callers with no run to cancel (an
	/// arithmetic expression, a builtin's own bookkeeping) can use it.
	///
	/// # Arguments
	///
	/// * `value` - The value to assign to the variable.
	/// * `append` - Whether or not to append the value to the preexisting value.
	pub fn assign_scalar(&mut self, value: String, append: bool) -> Result<(), error::Error> {
		if self.is_readonly() {
			return Err(error::ErrorKind::ReadonlyVariable.into());
		}

		self.place_scalar(value, append)
	}

	/// Stores a scalar, conditionally appending, converting it **once**.
	///
	/// `value` arrives as it was written. Where the conversion goes depends
	/// on the operation: a replacement converts the value, and an append
	/// converts the concatenation, because `Capitalize` is not idempotent for
	/// a character whose uppercase form is longer than it — converting
	/// `ßeta` and then converting `SSeta` again gives `Sseta`.
	///
	/// Appending to a variable that converts its values is therefore
	/// proportional to the value already there. [`Self::place_scalar_divided`]
	/// is the form with checkpoints in it; this one is for callers with no run
	/// to cancel.
	fn place_scalar(&mut self, value: String, append: bool) -> Result<(), error::Error> {
		if !append {
			let value = self.convert_value_str_for_assignment(value);
			return match &self.value {
				// Updating an array with a string updates its "0" element.
				ShellValue::IndexedArray(_)
				| ShellValue::AssociativeArray(_)
				| ShellValue::Unset(
					ShellValueUnsetType::AssociativeArray | ShellValueUnsetType::IndexedArray,
				) => {
					self.make_indexable()?;
					self.place_at_index(String::from("0"), value, false)
				},
				// Handle updates to dynamic values; for now we just drop them.
				// TODO(dynamic): Allow updates to dynamic values
				ShellValue::Dynamic { .. } => Ok(()),
				ShellValue::String(_) | ShellValue::Unset(ShellValueUnsetType::Untyped) => {
					self.value = ShellValue::String(value);
					Ok(())
				},
			};
		}

		self.fill_unset_for_append();

		let treat_as_int = self.is_treated_as_integer();
		let update_transform = self.get_update_transform();

		match &mut self.value {
			ShellValue::String(base) => {
				if treat_as_int {
					let int_value = base.parse::<i64>().unwrap_or(0) + value.parse::<i64>().unwrap_or(0);
					base.clear();
					base.push_str(int_value.to_string().as_str());
				} else {
					// The one conversion for this operation, over the whole
					// result.
					base.push_str(value.as_str());
					ValueConverter::apply_value_transforms(base, treat_as_int, update_transform);
				}
				Ok(())
			},
			ShellValue::IndexedArray(_) | ShellValue::AssociativeArray(_) => {
				// An element is appended to rather than rewritten, so the
				// conversion belongs to the incoming value.
				let value = self.convert_value_str_for_assignment(value);
				self.place_at_index(String::from("0"), value, true)
			},
			// TODO(dynamic): implement appending to dynamic vars
			ShellValue::Dynamic { .. } => Ok(()),
			ShellValue::Unset(_) => unreachable!("filled in above"),
		}
	}

	/// Brings a declared-but-unset variable to the value an append starts
	/// from.
	fn fill_unset_for_append(&mut self) {
		match &self.value {
			// Appending to a declared-but-unset array fills it out first.
			ShellValue::Unset(ShellValueUnsetType::IndexedArray | ShellValueUnsetType::AssociativeArray) => {
				self.fill_unset_with_empty_array();
			},
			// Appending to a declared-but-unset scalar starts from the empty
			// string, which comes out right even when it is treated as an
			// integer.
			ShellValue::Unset(ShellValueUnsetType::Untyped) => {
				self.value = ShellValue::String(self.convert_value_str_for_assignment(String::new()));
			},
			_ => (),
		}
	}

	/// [`Self::place_scalar`] with the conversion of the existing value
	/// divided.
	///
	/// **Both operands of a compound assignment are proportional to their
	/// size, and dividing one of them is not enough.** `copy+=x` on a
	/// converting variable concatenates and then converts the *whole* result,
	/// so a 64 MiB value already in the variable was walked in one
	/// synchronous step: 25.2 ms outside the allocator with that value
	/// already in the form the attribute wants — the pass itself, with
	/// nothing to convert — and 75.2 ms when it had work to do.
	///
	/// A variable that converts nothing keeps the in-place append, which
	/// copies no more than the incoming value.
	///
	/// # Errors
	///
	/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part
	/// way, **leaving the variable as it was**: the new value is built beside
	/// the old one rather than in it.
	async fn place_scalar_divided(
		&mut self,
		value: String,
		append: bool,
		params: &ExecutionParameters,
	) -> Result<(), error::Error> {
		// A scalar assigned to a variable that holds an array is the same
		// operation on element zero, so it takes the same divided route. The
		// explicit `arr[0]+=x` was not the only way to reach an element: this
		// spelling held 25.7 ms on a 64 MiB one.
		if matches!(
			self.value,
			ShellValue::IndexedArray(_)
				| ShellValue::AssociativeArray(_)
				| ShellValue::Unset(
					ShellValueUnsetType::IndexedArray | ShellValueUnsetType::AssociativeArray
				)
		) {
			return self.assign_at_index_divided(String::from("0"), value, append, params).await;
		}

		let converter = self.value_converter();
		let integer = self.is_treated_as_integer();
		if !append {
			if matches!(self.value, ShellValue::Dynamic { .. }) {
				// TODO(dynamic): Allow updates to dynamic values
				return Ok(());
			}
			// A bounded result does not bound its input parse: `declare -i`
			// of 64 MiB of zero digits held the worker 60.5 ms inside one
			// `str::parse`, because neither a non-digit nor an overflow ever
			// stopped it. The divided parse skips the zeros a stride at a
			// time.
			let converted = if integer {
				parse_shell_integer_divided(params, value.as_str()).await?.to_string()
			} else {
				// Stored rather than handed to `place_scalar`, which would
				// convert it a second time.
				converter.apply_divided(value, params).await?
			};
			self.value = ShellValue::String(converted);
			return Ok(());
		}
		if integer {
			// The addition is the conversion and its result is an integer,
			// but each side of it is a value the caller sized.
			let left = match &self.value {
				ShellValue::String(base) => parse_shell_integer_divided(params, base).await?,
				_ => 0,
			};
			let right = parse_shell_integer_divided(params, value.as_str()).await?;
			self.value = ShellValue::String((left + right).to_string());
			return Ok(());
		}
		if converter.is_identity() {
			// Nothing to convert, so the buffer is kept and appended to in
			// place — but **keeping the buffer and copying in one call are
			// two different things**, and the fast path had skipped both
			// checks: 64 MiB arriving into spare capacity held the worker
			// 24.6 ms inside one `push_str`.
			let ShellValue::String(base) = &mut self.value else {
				// A declared-but-unset scalar becomes the value itself, which
				// is already owned: no copy, and nothing written until here.
				if matches!(self.value, ShellValue::Unset(ShellValueUnsetType::Untyped)) {
					self.value = ShellValue::String(value);
					return Ok(());
				}
				return self.place_scalar(value, true);
			};

			// A cancelled append puts the buffer back where it started, which
			// keeps both the guarantee and the buffer: `truncate` frees no
			// capacity.
			//
			// It has to survive the future being **dropped**, not only an
			// `Err` returning: a run that is abandoned at a yield point never
			// reaches the line after the await. So the rollback is a guard
			// rather than an error branch.
			let mut appending = AppendInPlace::of(base);
			interp::push_str_in_strides(params, appending.text, &value).await?;
			appending.done();
			return Ok(());
		}


		// The conversion runs **once, over the concatenation**, from the value
		// as it arrived. Converting the incoming value first and the result
		// again is what gave `x+=ßeta` under `declare -c` the answer `Sseta`
		// where the whole string gives `SSeta`: `Capitalize` is not
		// idempotent for a character whose uppercase form is longer than it.
		let base = match &self.value {
			ShellValue::String(text) => text.as_str(),
			// A declared-but-unset scalar appends to the empty string. It is
			// not filled in first, because that would change the variable's
			// kind before any of the work below could be interrupted.
			ShellValue::Unset(ShellValueUnsetType::Untyped) => "",
			ShellValue::Dynamic { .. } => return self.place_scalar(value, true),
			ShellValue::IndexedArray(_)
			| ShellValue::AssociativeArray(_)
			| ShellValue::Unset(_) => unreachable!("answered above"),
		};

		let mut combined = String::with_capacity(base.len() + value.len());
		interp::push_str_in_strides(params, &mut combined, base).await?;
		interp::push_str_in_strides(params, &mut combined, &value).await?;
		self.value = ShellValue::String(converter.apply_divided(combined, params).await?);
		Ok(())
	}

	/// Assign the given array literal to the variable, conditionally appending
	/// its elements to the preexisting ones.
	///
	/// The literal can hold any number of elements, so building the array
	/// spends a checkpoint on each element: on its own, the pass is ready at
	/// once and holds the worker for as long as it runs, and it comes after
	/// the expansion of the last element has spent its own last checkpoint.
	/// A cancelled replacement leaves the variable as it was; a cancelled
	/// append keeps the elements it has already added, as `mapfile` keeps the
	/// lines it has read.
	async fn assign_array(
		&mut self,
		literal: ArrayLiteral,
		append: bool,
		params: &ExecutionParameters,
	) -> Result<(), error::Error> {
		if self.is_readonly() {
			return Err(error::ErrorKind::ReadonlyVariable.into());
		}

		let convert = self.value_converter();

		if !append {
			let value = match &self.value {
				// An associative array stays associative.
				ShellValue::AssociativeArray(_)
				| ShellValue::Unset(ShellValueUnsetType::AssociativeArray) => {
					let mut values = BTreeMap::new();
					ShellValue::update_associative_array_from_literals(&mut values, literal, convert, params)
						.await?;
					ShellValue::AssociativeArray(values)
				},
				// Anything else becomes (or stays) an indexed array.
				ShellValue::IndexedArray(_)
				| ShellValue::Unset(ShellValueUnsetType::IndexedArray | ShellValueUnsetType::Untyped)
				| ShellValue::String(_)
				| ShellValue::Dynamic { .. } => {
					let mut values = BTreeMap::new();
					ShellValue::update_indexed_array_from_literals(&mut values, literal, convert, params, 0)
						.await?;
					ShellValue::IndexedArray(values)
				},
			};
			self.value = value;
			return Ok(());
		}

		// Appending builds the new array **beside** the old value and commits
		// it at the end, for the reason the single-element path already does:
		// promoting before an await leaves a cancelled append having changed
		// the variable's kind without assigning anything.
		match &self.value {
			ShellValue::IndexedArray(_) => {
				let ShellValue::IndexedArray(existing_values) = &mut self.value else {
					unreachable!("matched above")
				};
				let next = existing_values.last_key_value().map_or(0, |(largest, _)| largest + 1);
				ShellValue::update_indexed_array_from_literals(
					existing_values,
					literal,
					convert,
					params,
					next,
				)
					.await
			},
			ShellValue::AssociativeArray(_) => {
				let ShellValue::AssociativeArray(existing_values) = &mut self.value else {
					unreachable!("matched above")
				};
				ShellValue::update_associative_array_from_literals(
					existing_values,
					literal,
					convert,
					params,
				)
				.await
			},
			// Appending to a string makes it element `0` of an array. The
			// literal is read into a map of its own, starting its unindexed
			// elements at `1`, and the scalar is moved into slot `0` at the
			// commit if the literal did not fill it.
			ShellValue::String(_) => {
				// The scalar's slot is left **absent** rather than empty.
				// An empty string was the first marker and an author can
				// write one: `x=base; x+=([0]='')` then looked exactly like
				// an untouched placeholder, so the scalar was put back and
				// the element read `base` where bash gives the empty string.
				// A key that is not in the map is not a value, so it cannot
				// be forged.
				let mut values: BTreeMap<u64, String> = BTreeMap::new();
				ShellValue::update_indexed_array_from_literals(&mut values, literal, convert, params, 1)
					.await?;
				if !values.contains_key(&0) {
					values.insert(0, self.take_scalar());
				}
				self.value = ShellValue::IndexedArray(values);
				Ok(())
			},
			// Appending to a declared-but-unset variable starts from the
			// empty array its declaration stands for.
			ShellValue::Unset(ShellValueUnsetType::AssociativeArray) => {
				let mut values = BTreeMap::new();
				ShellValue::update_associative_array_from_literals(
					&mut values,
					literal,
					convert,
					params,
				)
				.await?;
				self.value = ShellValue::AssociativeArray(values);
				Ok(())
			},
			ShellValue::Unset(_) => {
				let mut values = BTreeMap::new();
				ShellValue::update_indexed_array_from_literals(&mut values, literal, convert, params, 0)
					.await?;
				self.value = ShellValue::IndexedArray(values);
				Ok(())
			},
			// TODO(dynamic): implement appending to dynamic vars
			ShellValue::Dynamic { .. } => Ok(()),
		}
	}

	/// Gives a declared-but-unset variable the empty array its declaration
	/// stands for: associative after `declare -A`, indexed otherwise.
	fn fill_unset_with_empty_array(&mut self) {
		if let ShellValue::Unset(unset_type) = &self.value {
			self.value = match unset_type {
				ShellValueUnsetType::AssociativeArray => ShellValue::AssociativeArray(BTreeMap::new()),
				ShellValueUnsetType::IndexedArray | ShellValueUnsetType::Untyped => {
					ShellValue::IndexedArray(BTreeMap::new())
				},
			};
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
		self.make_indexable()?;
		let value = self.convert_value_str_for_assignment(value);
		self.place_at_index(array_index, value, append)
	}

	/// Stores an **already-converted** value at an index.
	///
	/// Separate from [`Self::assign_at_index`] because converting twice is
	/// not free and the second one cannot be divided: the divided form
	/// converted the value and then called the synchronous assignment, which
	/// converted it again, and a 64 MiB `ß` element into an uppercase array
	/// held the worker 24.8 ms in that second pass alone.
	fn place_at_index(
		&mut self,
		array_index: String,
		value: String,
		append: bool,
	) -> Result<(), error::Error> {
		let treat_as_int = self.is_treated_as_integer();

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

					arr.insert(array_index, new_value);
				} else {
					arr.insert(array_index, value);
				}
				Ok(())
			},
			ShellValue::Dynamic { .. } => Ok(()),
			ShellValue::Unset(_) | ShellValue::String(_) => Err(error::ErrorKind::NotArray.into()),
		}
	}

	/// Brings a variable to a form that can hold a value at an index.
	fn make_indexable(&mut self) -> Result<(), error::Error> {
		match &self.value {
			ShellValue::Unset(_) => {
				if self.is_readonly() {
					return Err(error::ErrorKind::ReadonlyVariable.into());
				}
				self.fill_unset_with_empty_array();
			},
			ShellValue::String(_) => {
				self.convert_to_indexed_array()?;
			},
			_ => (),
		}

		Ok(())
	}

	/// [`Self::assign_at_index`] with everything proportional to a value's
	/// size divided.
	///
	/// Three things here were not. The incoming value was converted twice,
	/// once divided and then again inside the synchronous assignment — 24.8 ms
	/// of a 64 MiB `ß` element was that second pass. Appending copied the
	/// element being appended to in one `to_owned`, and the associative branch
	/// copied the result again through a `clone` that nothing read. And
	/// promoting a scalar to an array copied the whole scalar, 25.8 ms of it,
	/// before the divided path it leads to had begun.
	///
	/// # Errors
	///
	/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part
	/// way, **leaving the variable as it was, in bytes and in kind**. Nothing
	/// here touches `self` until every await has returned: the promotion of a
	/// scalar happens at the commit rather than on the way in, so an
	/// interrupted append cannot leave a string turned into an array.
	pub(crate) async fn assign_at_index_divided(
		&mut self,
		array_index: String,
		value: String,
		append: bool,
		params: &ExecutionParameters,
	) -> Result<(), error::Error> {
		let value = self.value_converter().apply_divided(value, params).await?;
		self.place_at_index_divided(array_index, value, append, params).await
	}

	/// [`Self::place_at_index`] with the copy of the element being appended
	/// to divided.
	///
	/// `value` has already been converted, which is why this is separate:
	/// every route into a variable converts once, and the explicit
	/// `arr[0]+=x` is not the only one that reaches an element. A scalar
	/// append to a variable that holds an array is the same operation on
	/// element zero, and it held 25.7 ms on a 64 MiB element by taking the
	/// synchronous route.
	async fn place_at_index_divided(
		&mut self,
		array_index: String,
		value: String,
		append: bool,
		params: &ExecutionParameters,
	) -> Result<(), error::Error> {
		if !append || self.is_treated_as_integer() {
			self.make_indexable()?;
			return self.place_at_index(array_index, value, append);
		}

		let existing = match &self.value {
			ShellValue::IndexedArray(arr) => {
				let key = get_key_for_indexed_array(arr, array_index.as_str())?;
				arr.get(&key).map_or("", String::as_str)
			},
			ShellValue::AssociativeArray(arr) => {
				arr.get(array_index.as_str()).map_or("", String::as_str)
			},
			// A scalar becomes element zero of the array it is promoted into,
			// so an append at that index appends to it. The promotion itself
			// waits until there is something to commit.
			ShellValue::String(text) => {
				let promoted: BTreeMap<u64, String> =
					std::iter::once((0, String::new())).collect();
				if get_key_for_indexed_array(&promoted, array_index.as_str())? == 0 {
					text.as_str()
				} else {
					""
				}
			},
			ShellValue::Dynamic { .. } | ShellValue::Unset(_) => {
				self.make_indexable()?;
				return self.place_at_index(array_index, value, append);
			},
		};

		let mut appended = String::with_capacity(existing.len() + value.len());
		interp::push_str_in_strides(params, &mut appended, existing).await?;
		interp::push_str_in_strides(params, &mut appended, &value).await?;

		// Everything that can fail has returned, so the promotion of a scalar
		// and the element it holds are committed together.
		self.make_indexable()?;
		match &mut self.value {
			ShellValue::IndexedArray(arr) => {
				let key = get_key_for_indexed_array(arr, array_index.as_str())?;
				arr.insert(key, appended);
			},
			ShellValue::AssociativeArray(arr) => {
				arr.insert(array_index, appended);
			},
			_ => unreachable!("answered above"),
		}

		Ok(())
	}

	fn convert_value_str_for_assignment(&self, s: String) -> String {
		self.value_converter().apply(s)
	}

	/// Returns what this variable's attributes (`declare -i`, `-l`, `-u`,
	/// `-c`) make of a value assigned to it, for applying one element at a
	/// time.
	fn value_converter(&self) -> ValueConverter {
		ValueConverter {
			treat_as_int:     self.is_treated_as_integer(),
			update_transform: self.get_update_transform(),
		}
	}
}

/// What a variable's attributes make of a value assigned to it.
#[derive(Clone, Copy)]
pub(crate) struct ValueConverter {
	treat_as_int:     bool,
	update_transform: ShellVariableUpdateTransform,
}

/// How much of a value one case-conversion step converts.
///
/// Smaller than [`interp::DIVIDE_COPY_ABOVE_BYTES`], which is a stride for
/// copying, because converting a byte costs far more than moving one: a
/// 64 KiB stride of `Σ` measured 1.2 ms optimised and 9.5–11 ms debug, over
/// the millisecond [`interp::LONGEST_HOLD_BETWEEN_YIELDS`] allows a single
/// hold, so the stride could not honour the bound the clock exists to
/// enforce. 8 KiB converts in about 0.15 ms optimised. The extra clock
/// reading each stride costs 100–300 ns against 150 µs of conversion.
///
/// This is the size of a *piece*, not the threshold for dividing at all;
/// a value shorter than [`interp::DIVIDE_COPY_ABOVE_BYTES`] is converted in
/// one step, because below that there is nothing worth dividing.
const CONVERSION_STRIDE_BYTES: usize = 8 * 1024;

/// An append made in place, which puts the buffer back if it does not finish.
///
/// The other divided assignments build the new value beside the old one, so
/// an interruption leaves the variable untouched by construction. An append
/// to a variable that converts nothing is the one that writes into the value
/// it is changing — deliberately, because building a 64 MiB base aside to
/// add a few bytes to it would be the trade this change exists to avoid.
///
/// The rollback is a guard rather than a branch after the await because a
/// run can be **dropped** at a yield point as well as cancelled, and a
/// dropped future never reaches the line after the await.
///
/// **`truncate` frees no capacity**, which is what makes the guard
/// compatible with the optimisation it protects: the buffer the caller had
/// is the buffer it keeps, so a rolled-back append costs the next one
/// nothing and the in-place control — 256 appends into spare capacity moving
/// the buffer zero times — stays green.
struct AppendInPlace<'a> {
	text:      &'a mut String,
	held:      usize,
	finished:  bool,
}

impl<'a> AppendInPlace<'a> {
	fn of(text: &'a mut String) -> Self {
		let held = text.len();
		Self { text, held, finished: false }
	}

	const fn done(&mut self) {
		self.finished = true;
	}
}

impl Drop for AppendInPlace<'_> {
	fn drop(&mut self) {
		if !self.finished {
			self.text.truncate(self.held);
		}
	}
}

impl ValueConverter {
	/// A converter that leaves every value as it is.
	pub(crate) const fn identity() -> Self {
		Self { treat_as_int: false, update_transform: ShellVariableUpdateTransform::None }
	}

	/// The converter an attribute means, with no integer handling: what the
	/// value a variable holds has to look like. The oracle every assignment
	/// route is compared against.
	#[cfg(test)]
	pub(crate) const fn for_transform(update_transform: ShellVariableUpdateTransform) -> Self {
		Self { treat_as_int: false, update_transform }
	}

	/// Whether this converter leaves every value exactly as it is.
	const fn is_identity(self) -> bool {
		!self.treat_as_int && matches!(self.update_transform, ShellVariableUpdateTransform::None)
	}

	/// Converts a value in one step.
	pub(crate) fn apply(self, mut value: String) -> String {
		Self::apply_value_transforms(&mut value, self.treat_as_int, self.update_transform);
		value
	}

	/// Converts a value a stride at a time, spending a checkpoint between
	/// pieces.
	///
	/// Case conversion rewrites the whole string and one array element can be
	/// any size: a `ß`-filled element into an uppercase destination held the
	/// worker for 87 ms at 64 MiB and 672 ms at 512 MiB, after its byte charge
	/// had already been paid. A charge counts work; only dividing the
	/// operation interrupts it.
	///
	/// Pieces are cut at any character boundary. **Choosing where to cut is
	/// not a way to make this exact** — an earlier version extended a piece
	/// until it did not end in `Σ`, which lost the preceding context in one
	/// direction, missed the following context in the other, and turned an
	/// all-sigma string into one piece of 1.03 s at 64 MiB. **Nor is asking
	/// the whole string at each `Σ`**, which was exact and unbounded: see
	/// [`ConversionState`], which carries the question across pieces so that
	/// the loop reading the characters is the one that spends the
	/// checkpoints.
	///
	/// # Errors
	///
	/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part
	/// way, leaving the conversion unfinished and discarded.
	async fn apply_divided(
		self,
		value: String,
		params: &ExecutionParameters,
	) -> Result<String, error::Error> {
		// Nothing to convert is the common case — an array literal assigned to
		// a variable with no case or integer attribute — and awaiting this
		// function per element for it measured 2.88% of pure waste.
		if self.is_identity() {
			return Ok(value);
		}
		let divisible = !self.treat_as_int
			&& !matches!(self.update_transform, ShellVariableUpdateTransform::None);
		if !divisible || value.len() <= interp::DIVIDE_COPY_ABOVE_BYTES {
			return Ok(self.apply(value));
		}

		let mut converted = String::with_capacity(value.len());
		let mut state = ConversionState::new();
		let mut cut = 0;
		while cut < value.len() {
			interp::stride_checkpoint(params).await?;
			let end = Self::stride_end(&value, cut);
			Self::convert_piece(&value, cut..end, self.update_transform, &mut converted, &mut state);
			cut = end;
		}
		state.finish(&mut converted);

		Ok(converted)
	}

	/// Where the next piece ends: the last character boundary within
	/// [`CONVERSION_STRIDE_BYTES`].
	fn stride_end(text: &str, from: usize) -> usize {
		let mut end = (from + CONVERSION_STRIDE_BYTES).min(text.len());
		while !text.is_char_boundary(end) {
			end -= 1;
		}
		end
	}

	/// Converts `text[piece]` onto `converted`, carrying in `state` the only
	/// thing a character needs from outside itself.
	///
	/// `Capitalize` applies only at the very start of the value; everywhere
	/// else it lowercases, which is what capitalising the whole string does.
	fn convert_piece(
		text: &str,
		piece: std::ops::Range<usize>,
		update_transform: ShellVariableUpdateTransform,
		converted: &mut String,
		state: &mut ConversionState,
	) {
		let lowercases = matches!(
			update_transform,
			ShellVariableUpdateTransform::Lowercase | ShellVariableUpdateTransform::Capitalize
		);
		let capitalizes = matches!(update_transform, ShellVariableUpdateTransform::Capitalize);

		for (offset, character) in text[piece.clone()].char_indices() {
			let at = piece.start + offset;
			if !lowercases {
				converted.extend(character.to_uppercase());
				continue;
			}

			// `Σ` is cased; asking the oracle would answer that by probing
			// `"ΣΣ"`, and the answer is not in doubt.
			let role = if character == 'Σ' { CaseRole::Cased } else { case_role(character) };
			state.note(role, converted);

			if capitalizes && at == 0 {
				// Capitalising is lowercasing and then uppercasing the first
				// character of *that*, which is not the same as uppercasing the
				// original: `İ` lowercases to `i` and a combining dot, and only
				// the `i` is raised again. A `Σ` here has nothing cased before
				// it, so it is never the final form.
				let mut lowered = character.to_lowercase();
				if let Some(first) = lowered.next() {
					converted.extend(first.to_uppercase());
				}
				converted.extend(lowered);
			} else if character == 'Σ' {
				let written = converted.len();
				converted.push('σ');
				if state.preceding_cased {
					state.undecided_sigma = Some(written);
				}
			} else {
				converted.extend(character.to_lowercase());
			}

			match role {
				CaseRole::Ignorable => (),
				CaseRole::Cased => state.preceding_cased = true,
				CaseRole::Neither => state.preceding_cased = false,
			}
		}
	}

	fn apply_value_transforms(
		s: &mut String,
		treat_as_int: bool,
		update_transform: ShellVariableUpdateTransform,
	) {
		if treat_as_int {
			*s = parse_shell_integer(s.as_str()).to_string();
		} else {
			match update_transform {
				ShellVariableUpdateTransform::None => (),
				ShellVariableUpdateTransform::Lowercase => *s = (*s).to_lowercase(),
				ShellVariableUpdateTransform::Uppercase => *s = (*s).to_uppercase(),
				ShellVariableUpdateTransform::Capitalize => {
					// This isn't really title-case; only the first character is capitalized.
					*s = s.to_lowercase();
					if let Some(c) = s.chars().next() {
						// By the character's own length: `replace_range(0..1)`
						// panics on a multibyte one, and `ß` is two bytes.
						s.replace_range(0..c.len_utf8(), &c.to_uppercase().to_string());
					}
				},
			}
		}
	}
}

/// What `declare -i` makes of a value: `str::parse` with a failure read as
/// zero, in a number of steps that does not depend on the value's length.
///
/// **A bounded result does not bound its input parse.** `i64::from_str`
/// stops at the first character that is not a digit and at the first
/// overflow, so almost every long value is decided at once — but a run of
/// zeros is neither, and 64 MiB of them held the worker **60.5 ms** inside
/// one `parse`.
///
/// Leading zeros are the only part that can be long, and they carry no
/// information: skipping them leaves at most nineteen digits that can
/// matter, because a twentieth overflows an `i64` and `from_str` would have
/// answered `Err` — which this reads as zero, as the caller always did.
/// What is left is parsed by the standard library, so the answer is still
/// its answer rather than a second opinion.
fn parse_shell_integer(value: &str) -> i64 {
	let (sign, digits) = split_integer_sign(value);
	integer_from(sign, digits.trim_start_matches('0'))
}

/// Splits an optional leading sign from the digits after it.
fn split_integer_sign(value: &str) -> (&str, &str) {
	match value.as_bytes().first() {
		Some(b'-') => ("-", &value[1..]),
		Some(b'+') => ("", &value[1..]),
		_ => ("", value),
	}
}

/// The value of `sign` and the digits left after any leading zeros.
///
/// At most nineteen digits can matter, because a twentieth overflows an
/// `i64` and `str::parse` would answer `Err`, which this reads as zero
/// exactly as `unwrap_or_default` always did. Anything longer is therefore
/// zero without being read: an overflow, or a value that was never a
/// number. What is short enough is handed to the standard library, so the
/// answer is still its answer rather than a second opinion.
fn integer_from(sign: &str, significant: &str) -> i64 {
	if significant.len() > 32 {
		return 0;
	}

	let mut whole = String::with_capacity(sign.len() + significant.len());
	whole.push_str(sign);
	whole.push_str(significant);
	whole.parse::<i64>().unwrap_or_default()
}

/// [`parse_shell_integer`] with the run of leading zeros skipped a stride at
/// a time.
///
/// The synchronous form still walks that run in one step. It is a byte
/// comparison rather than a digit accumulation, so 64 MiB of zeros costs
/// about 6 ms there instead of 60 — better, and still over the bound, which
/// is why the path a script takes uses this one.
///
/// # Errors
///
/// Returns [`error::ErrorKind::Interrupted`] if the run is cancelled part
/// way.
async fn parse_shell_integer_divided(
	params: &ExecutionParameters,
	value: &str,
) -> Result<i64, error::Error> {
	let (sign, digits) = split_integer_sign(value);

	let mut zeros = 0;
	let bytes = digits.as_bytes();
	while zeros < bytes.len() {
		let stride = (zeros + interp::BYTE_CHECKPOINT_STRIDE).min(bytes.len());
		if stride - zeros >= interp::BYTE_CHECKPOINT_STRIDE {
			interp::stride_checkpoint(params).await?;
		}
		match bytes[zeros..stride].iter().position(|byte| *byte != b'0') {
			Some(offset) => {
				zeros += offset;
				break;
			},
			None => zeros = stride,
		}
	}

	Ok(integer_from(sign, &digits[zeros..]))
}

/// What a divided conversion carries from one piece to the next.
///
/// `Final_Sigma` is the only rule in a lowercase conversion that depends on
/// anything outside the character being converted: a `Σ` is written `ς` when
/// a cased character comes before it and none comes after, skipping
/// case-ignorable characters on both sides.
///
/// An earlier version answered that by asking the whole original string at
/// each `Σ`. It was exact, and it was unbounded: a case-ignorable run can be
/// as long as the value, so one `convert_piece` could scan 32 MiB of
/// combining marks with no checkpoint in it — **358 ms** on one side,
/// **712 ms** on both, and already 5.6–11.6 ms at 1 MiB, against a 4 ms
/// bound. Dividing the pieces bounded the pieces and not the scan.
///
/// This carries the scan instead of restarting it, so the conversion reads
/// each character once and the loop that reads them is the one that already
/// spends checkpoints:
///
/// - the backward question is answered by remembering what the last
///   character that was not case-ignorable was;
/// - the forward question is answered by **writing `σ` and coming back**.
///   At most one `Σ` is ever undecided, because a second one would itself be
///   the cased character that decides the first.
///
/// **Do not reach for a checkpoint here.** Everywhere else in this change the
/// answer to a long step is to divide it and yield; this is the one place
/// where the work should not exist. Checkpointing the scan would mean making
/// it resumable across pieces, since the run it walks can be longer than one
/// — which is this state machine, reached the long way round and with a
/// suspended scan to carry as well as the answer.
///
/// It would not be quadratic, and an earlier version of this comment said it
/// would: a `Σ` is itself cased, so it stops the scan of the `Σ` next to it,
/// and a value of alternating sigmas and runs walks each run at most twice.
/// The scan was linear in total and unbounded in one step, which is a
/// different complaint and the one that mattered.
struct ConversionState {
	/// Whether the last character that was not case-ignorable was cased.
	preceding_cased:  bool,
	/// Where a `σ` was written that becomes `ς` unless a cased character
	/// follows it.
	undecided_sigma:  Option<usize>,
}

impl ConversionState {
	const fn new() -> Self {
		Self { preceding_cased: false, undecided_sigma: None }
	}

	/// Settles an undecided `Σ` as the final form, nothing cased having
	/// followed it.
	fn settle_as_final(&mut self, converted: &mut String) {
		let Some(at) = self.undecided_sigma.take() else {
			return;
		};
		debug_assert_eq!(&converted[at..at + 'σ'.len_utf8()], "σ");
		// SAFETY: `at` is where a `σ` was pushed, so these are its two bytes,
		// `CF 83`. `ς` is `CF 82`: the same length, and writing it over them
		// leaves the string valid UTF-8.
		unsafe { converted.as_mut_vec()[at + 1] = 0x82 };
	}

	/// Takes the role of the next character, before it is written.
	fn note(&mut self, role: CaseRole, converted: &mut String) {
		match role {
			// Nothing about the scan changes, in either direction.
			CaseRole::Ignorable => (),
			// A cased character after an undecided `Σ` settles it as `σ`,
			// which is what is already written.
			CaseRole::Cased => self.undecided_sigma = None,
			CaseRole::Neither => self.settle_as_final(converted),
		}
	}

	/// The value has ended, so nothing cased follows an undecided `Σ`.
	fn finish(&mut self, converted: &mut String) {
		self.settle_as_final(converted);
	}
}

/// What a character does to the scan either side of a `Σ`.
#[derive(Clone, Copy)]
enum CaseRole {
	/// Cased: the scan stops here and the answer is yes.
	Cased,
	/// Case-ignorable: the scan passes over it.
	Ignorable,
	/// Neither: the scan stops here and the answer is no.
	Neither,
}

thread_local! {
	/// Answers already asked. The scan only ever runs next to a `Σ`, so this
	/// is empty for text that has none, and one entry per distinct neighbour
	/// for text made of them.
	static CASE_ROLES: std::cell::RefCell<std::collections::HashMap<char, CaseRole>> =
		std::cell::RefCell::new(std::collections::HashMap::new());
}

/// What `character` is, as far as the scan around a `Σ` is concerned.
///
/// The standard library is the only Unicode table here, and it is asked the
/// question it already answers: lowercasing `"<c>Σ"` yields `ς` exactly when
/// `c` stops the backward scan as cased, and lowercasing `"A<c>Σ"` yields `ς`
/// exactly when `c` either is cased or is passed over. Keeping one table
/// rather than two means the branch cannot disagree with `str::to_lowercase`
/// about what a character is.
fn case_role(character: char) -> CaseRole {
	if let Some(known) = CASE_ROLES.with_borrow(|roles| roles.get(&character).copied()) {
		return known;
	}

	let mut probe = String::with_capacity(8);
	probe.push(character);
	probe.push('Σ');
	let role = if probe.to_lowercase().ends_with('ς') {
		CaseRole::Cased
	} else {
		probe.insert(0, 'A');
		if probe.to_lowercase().ends_with('ς') { CaseRole::Ignorable } else { CaseRole::Neither }
	};

	CASE_ROLES.with_borrow_mut(|roles| roles.insert(character, role));
	role
}

impl ShellVariable {

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
		// Only the kind of value counts, so a stored value is read in place:
		// copying an array to look at it costs a pass over every element.
		let resolved;
		let value = if let ShellValue::Dynamic { getter, .. } = &self.value {
			resolved = getter(shell);
			&resolved
		} else {
			&self.value
		};

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

impl ArrayLiteral {
	/// Copies the expanded elements of an array assignment (`name=(…)`, as a
	/// declaration builtin receives it) into a literal.
	///
	/// The builtin holds the elements borrowed, and they can be any number, so
	/// each copy spends a checkpoint.
	///
	/// # Arguments
	///
	/// * `elements` - The expanded keys and values.
	/// * `params` - The execution parameters of the run doing the assignment.
	pub async fn from_assignment_elements(
		elements: &[(Option<brush_parser::ast::Word>, brush_parser::ast::Word)],
		params: &ExecutionParameters,
	) -> Result<Self, error::Error> {
		let mut literal = Vec::with_capacity(elements.len());
		let mut budget = interp::ElementBudget::new();
		for (key, value) in elements {
			// One element can be of any size, so the copy itself is divided
			// rather than merely charged for; the step charge is what makes a
			// long list of short elements yield.
			let long = key.as_ref().map_or(0, |key| key.value.len()) + value.value.len()
				> interp::DIVIDE_COPY_ABOVE_BYTES;
			if long {
				let key = match key {
					Some(key) => Some(interp::clone_in_strides(params, key.value.as_str()).await?),
					None => None,
				};
				literal.push((key, interp::clone_in_strides(params, value.value.as_str()).await?));
				continue;
			}
			let due = budget.charge(key.as_ref().map_or(0, |key| key.value.len()) + value.value.len());
			if due > 0 {
				interp::loop_checkpoints(params, due).await?;
			}
			literal.push((key.as_ref().map(|key| key.value.clone()), value.value.clone()));
		}

		Ok(Self(literal))
	}
}

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
	/// Spends a checkpoint on each element, as [`ShellVariable::assign`] does.
	///
	/// # Arguments
	///
	/// * `literals` - The literals to construct the indexed array from.
	/// * `params` - The execution parameters of the run building the array.
	pub async fn indexed_array_from_literals(
		literals: ArrayLiteral,
		params: &ExecutionParameters,
	) -> Result<Self, error::Error> {
		let mut values = BTreeMap::new();
		Self::update_indexed_array_from_literals(
			&mut values,
			literals,
			ValueConverter::identity(),
			params,
			0,
		)
			.await?;

		Ok(Self::IndexedArray(values))
	}

	/// Returns an indexed array holding `value` alone, at the index that
	/// `[index]=value` names in an array literal.
	///
	/// # Arguments
	///
	/// * `index` - The index of the element.
	/// * `value` - The element.
	pub fn indexed_array_with_element(index: &str, value: String) -> Self {
		Self::IndexedArray(BTreeMap::from([(literal_index(index), value)]))
	}

	/// Adds the elements of `literal_values` to `existing_values`, each after
	/// the one before unless it names its own index (`[index]=value`), and each
	/// passed through `convert`.
	///
	/// The literal can hold any number of elements and nothing in the loop
	/// waits on anything, so it spends a checkpoint on each element.
	async fn update_indexed_array_from_literals(
		existing_values: &mut BTreeMap<u64, String>,
		literal_values: ArrayLiteral,
		convert: ValueConverter,
		params: &ExecutionParameters,
		first_unindexed_key: u64,
	) -> Result<(), error::Error> {
		let mut new_key = first_unindexed_key;

		let mut budget = interp::ElementBudget::new();
		for (key, value) in literal_values.0 {
			// `convert` rewrites the value, so its length is the work.
			let due = budget.charge(value.len());
			if due > 0 {
				interp::loop_checkpoints(params, due).await?;
			}
			if let Some(key) = key {
				new_key = literal_index(&key);
			}

			existing_values.insert(new_key, convert.apply_divided(value, params).await?);
			new_key += 1;
		}

		Ok(())
	}

	/// Adds the elements of `literal_values` to `existing_values`, each value
	/// passed through `convert`. Either every element names its key
	/// (`[key]=value`), or none of the first does and the elements alternate
	/// key and value.
	///
	/// The literal can hold any number of elements and nothing in the loop
	/// waits on anything, so it spends a checkpoint on an
	/// [`interp::ElementBudget`] of steps and bytes.
	async fn update_associative_array_from_literals(
		existing_values: &mut BTreeMap<String, String>,
		literal_values: ArrayLiteral,
		convert: ValueConverter,
		params: &ExecutionParameters,
	) -> Result<(), error::Error> {
		let mut literal_values = literal_values.0.into_iter();
		let Some((first_key, first_value)) = literal_values.next() else {
			return Ok(());
		};
		let mut budget = interp::ElementBudget::new();
		interp::loop_checkpoints(params, budget.charge(first_value.len())).await?;
		let first_value = convert.apply_divided(first_value, params).await?;

		if let Some(first_key) = first_key {
			existing_values.insert(first_key, first_value);

			for (key, value) in literal_values {
				let due = budget.charge(value.len());
				if due > 0 {
					interp::loop_checkpoints(params, due).await?;
				}
				let Some(key) = key else {
					return Err(error::ErrorKind::AssociativeArrayMissingSubscript.into());
				};

				existing_values.insert(key, convert.apply_divided(value, params).await?);
			}
		} else {
			let mut current_key = Some(first_value);
			for (key, value) in literal_values {
				let due = budget.charge(key.as_ref().map_or(0, String::len) + value.len());
				if due > 0 {
					interp::loop_checkpoints(params, due).await?;
				}
				let value = convert.apply_divided(value, params).await?;
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

/// The index `[index]=value` names in an indexed array literal; anything but
/// a number names `0`.
fn literal_index(index: &str) -> u64 {
	index.parse().unwrap_or(0)
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

#[cfg(test)]
mod conversion {
	use super::*;

	/// Every transform the divided converter has to reproduce.
	const TRANSFORMS: [ShellVariableUpdateTransform; 3] = [
		ShellVariableUpdateTransform::Lowercase,
		ShellVariableUpdateTransform::Uppercase,
		ShellVariableUpdateTransform::Capitalize,
	];

	/// Contexts around the character the conversion has to get right. `Σ`
	/// lowercases to `ς` only when a cased character precedes it and none
	/// follows, skipping case-ignorable ones — an apostrophe, a combining
	/// mark, a zero-width joiner — on both sides.
	const CONTEXTS: [&str; 17] = [
		"Σ",
		"Σ!",
		"ΣA",
		"Σ'",
		"Σ'A",
		"Σ\u{0301}",
		"Σ\u{0301}A",
		"Σ\u{200d}A",
		"ΣΣ",
		"ΣßΣ",
		"İΣ",
		// Runs of case-ignorable characters on either side, which is what
		// the carried state replaced an unbounded scan with: long enough to
		// cross a stride boundary on their own.
		"A\u{0301}\u{0301}\u{0301}Σ",
		"AΣ\u{0301}\u{0301}\u{0301}",
		"AΣ\u{0301}\u{0301}\u{0301}A",
		"A\u{0301}\u{0301}Σ\u{0301}\u{0301}",
		"A\u{0301}\u{0301}Σ\u{0301}\u{0301}A",
		"\u{0301}Σ",
	];

	/// Divides a conversion the way an assignment does, without a runtime.
	fn divided(converter: ValueConverter, value: &str) -> String {
		let mut converted = String::new();
		let mut state = ConversionState::new();
		let mut cut = 0;
		while cut < value.len() {
			let end = ValueConverter::stride_end(value, cut);
			ValueConverter::convert_piece(
				value,
				cut..end,
				converter.update_transform,
				&mut converted,
				&mut state,
			);
			cut = end;
		}
		state.finish(&mut converted);

		converted
	}

	/// The divided conversion has to agree with the whole-string one
	/// character for character, at every offset a piece boundary can fall on.
	///
	/// A latency change that silently alters text is worse than the hold it
	/// removes, and nothing else in the suite would see it: an earlier version
	/// chose its cut points to avoid splitting a sigma's context and got sixty
	/// of these wrong, in both directions.
	#[test]
	fn divided_conversion_matches_whole_string() {
		let stride = CONVERSION_STRIDE_BYTES;
		let mut compared = 0;
		for transform in TRANSFORMS {
			let converter =
				ValueConverter { treat_as_int: false, update_transform: transform };
			for context in CONTEXTS {
				// Offsets that put a piece boundary just before, inside and
				// just after the context, and well away from it.
				for filler in [0, 1, 2, 3, 4, stride - 4, stride - 2, stride - 1, stride, stride + 1]
				{
					let value = format!("{}{context}", "A".repeat(filler));
					let whole = converter.apply(value.clone());
					let divided = divided(converter, &value);
					assert_eq!(
						divided, whole,
						"{transform:?} of {filler} fillers before {context:?}"
					);
					compared += 1;
				}
			}
		}

		assert_eq!(compared, TRANSFORMS.len() * CONTEXTS.len() * 10, "every case ran");
	}

	/// `Capitalize` replaced the first character by byte index, which is a
	/// panic when that character is wider than one byte.
	#[test]
	fn capitalize_accepts_a_multibyte_first_character() {
		let converter = ValueConverter {
			treat_as_int:     false,
			update_transform: ShellVariableUpdateTransform::Capitalize,
		};
		assert_eq!(converter.apply(String::from("ßeta")), "SSeta");
		assert_eq!(converter.apply(String::from("über")), "Über");
		assert_eq!(converter.apply(String::new()), "");
	}

	/// The slot an undecided `Σ` is written into is an offset into the
	/// **output**, which is not the offset of the `Σ` in the input: `İ`
	/// lowercases to two characters, `ß` uppercases to two, and a conversion
	/// that patched by input offset would overwrite the wrong bytes — or a
	/// character boundary — once either had been seen.
	#[test]
	fn an_undecided_sigma_is_patched_by_output_offset() {
		for transform in TRANSFORMS {
			let converter = ValueConverter { treat_as_int: false, update_transform: transform };
			// Characters whose conversion is longer than they are, before a
			// `Σ` that is undecided until the `!` after it, at offsets that
			// put the expansion and the `Σ` in different pieces.
			for growing in ["İ", "ß", "İß"] {
				for filler in [0, 1, CONVERSION_STRIDE_BYTES - 1, CONVERSION_STRIDE_BYTES + 1] {
					let value = format!("{growing}{}AΣ!", "a".repeat(filler));
					assert_eq!(
						divided(converter, &value),
						converter.apply(value.clone()),
						"{transform:?} of {growing:?} with {filler} fillers"
					);
				}
			}
		}
	}

	/// Inputs whose conversion is **not idempotent**, which is the class that
	/// converting twice corrupts: a character whose uppercase form is more
	/// than one character leaves everything after it to be lowercased by the
	/// second pass. On the head that had two conversions, `ßeta` gave
	/// `Sseta` for `SSeta` and `ﬃeld` gave `Ffield` for `FFIeld`, while
	/// `İΣ` happened to agree — which is why the oracle is the whole-string
	/// conversion and not a pinned pair of examples.
	const NOT_IDEMPOTENT: [&str; 8] =
		["ßeta", "ﬃeld", "İΣ", "ΣΣ", "aΣ", "AΣ!", "A\u{0301}Σ", "ǰ"];

	/// Every path into a variable converts its value **once**. The scalar
	/// assignment is the oracle: the same input at an index has to come out
	/// the same way.
	#[test]
	fn a_value_is_converted_once_on_every_path() {
		for transform in TRANSFORMS {
			for input in NOT_IDEMPOTENT {
				let mut scalar = ShellVariable::new(ShellValue::Unset(ShellValueUnsetType::Untyped));
				scalar.set_update_transform(transform);
				scalar.assign_scalar(String::from(input), false).expect("assigned as a scalar");
				let whole = scalar.value().to_cow_str_without_dynamic_support().into_owned();

				for mut variable in [
					ShellVariable::new(ShellValue::IndexedArray(BTreeMap::new())),
					ShellVariable::new(ShellValue::AssociativeArray(BTreeMap::new())),
					ShellVariable::new(ShellValue::Unset(ShellValueUnsetType::IndexedArray)),
					ShellVariable::new(ShellValue::Unset(ShellValueUnsetType::AssociativeArray)),
				] {
					variable.set_update_transform(transform);
					variable
						.assign_at_index(String::from("0"), String::from(input), false)
						.expect("assigned at index");
					assert_eq!(
						variable.value().to_cow_str_without_dynamic_support(),
						whole,
						"{transform:?} of {input:?} at an index"
					);
				}
			}
		}
	}

	/// Dividing an append must not turn an in-place one into a reallocation.
	/// That would be the easy way to make every hold figure in this change go
	/// away while making the shell slower, and nothing else here would catch
	/// it: a variable that converts nothing keeps the old in-place append.
	///
	/// **This proves the identity scalar case and nothing else.** Keeping the
	/// buffer is not a property of assignment in general: a reviewer measured
	/// appending `WORLD` to `HELLO` in six shapes and **five of them moved**,
	/// a transformed scalar and both array kinds replacing a 1 MiB allocation
	/// with a ten-byte one, because those paths build the new value rather
	/// than growing the old. Read as a general guarantee this test says
	/// something false.
	#[test]
	fn an_ordinary_append_still_grows_in_place() {
		let mut variable = ShellVariable::new(ShellValue::String(String::with_capacity(4096)));
		let mut reference = String::with_capacity(4096);
		let mut moves = 0;

		for _ in 0..256 {
			let ShellValue::String(before) = variable.value() else { unreachable!("a scalar") };
			let before = before.as_ptr();
			variable.assign_scalar(String::from("ab"), true).expect("appended");
			reference.push_str("ab");
			let ShellValue::String(after) = variable.value() else { unreachable!("a scalar") };
			if before != after.as_ptr() {
				moves += 1;
			}
		}

		let ShellValue::String(text) = variable.value() else { unreachable!("a scalar") };
		assert_eq!(text, &reference, "the same bytes as a plain `String`");
		assert_eq!(text.capacity(), reference.capacity(), "the same growth as a plain `String`");
		assert_eq!(moves, 0, "512 bytes into 4096 of capacity moved the buffer {moves} times");
	}
}
