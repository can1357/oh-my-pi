use std::{io::Write, sync::LazyLock};

use brush_core::{
	ErrorKind, ExecutionResult, builtins,
	env::{self, EnvironmentLookup, EnvironmentScope},
	parser::ast,
	variables::{
		self, ArrayLiteral, ShellValue, ShellValueLiteral, ShellValueUnsetType, ShellVariable,
		ShellVariableUpdateTransform,
	},
};
use clap::Parser;
use itertools::Itertools;

crate::minus_or_plus_flag_arg!(MakeIndexedArrayFlag, 'a', "Make the variable an indexed array.");
crate::minus_or_plus_flag_arg!(
	MakeAssociativeArrayFlag,
	'A',
	"Make the variable an associative array."
);
crate::minus_or_plus_flag_arg!(
	CapitalizeValueOnAssignmentFlag,
	'c',
	"Enable capitalize-on-assignment for the variable."
);
crate::minus_or_plus_flag_arg!(MakeIntegerFlag, 'i', "Mark the variable as integer-typed");
crate::minus_or_plus_flag_arg!(
	LowercaseValueOnAssignmentFlag,
	'l',
	"Enable lowercase-on-assignment for the variable."
);
crate::minus_or_plus_flag_arg!(MakeNameRefFlag, 'n', "Mark the variable as a name reference");
crate::minus_or_plus_flag_arg!(MakeReadonlyFlag, 'r', "Mark the variable as read-only.");
crate::minus_or_plus_flag_arg!(MakeTracedFlag, 't', "Enable tracing for the variable.");
crate::minus_or_plus_flag_arg!(
	UppercaseValueOnAssignmentFlag,
	'u',
	"Enable uppercase-on-assignment for the variable."
);
crate::minus_or_plus_flag_arg!(MakeExportedFlag, 'x', "Mark the variable for export.");

/// Display or update variables and their attributes.
#[derive(Parser)]
#[clap(override_usage = "declare [OPTIONS] [DECLARATIONS]...")]
pub(crate) struct DeclareCommand {
	/// Constrain to function names or definitions.
	#[arg(short = 'f')]
	function_names_or_defs_only: bool,

	/// Constrain to function names only.
	#[arg(short = 'F')]
	function_names_only: bool,

	/// Create global variable, if applicable.
	#[arg(short = 'g')]
	create_global: bool,

	/// When creating a local variable that shadows another variable of the same
	/// name, then initialize it with the contents and attributes of the
	/// variable being shadowed.
	#[arg(short = 'I')]
	locals_inherit_from_prev_scope: bool,

	/// Display each item's attributes and values.
	#[arg(short = 'p')]
	print: bool,

	//
	// Attribute options
	#[clap(flatten)] // -a
	make_indexed_array: MakeIndexedArrayFlag,
	#[clap(flatten)] // -A
	make_associative_array: MakeAssociativeArrayFlag,
	#[clap(flatten)] // -c
	capitalize_value_on_assignment: CapitalizeValueOnAssignmentFlag,
	#[clap(flatten)] // -i
	make_integer: MakeIntegerFlag,
	#[clap(flatten)] // -l
	lowercase_value_on_assignment: LowercaseValueOnAssignmentFlag,
	#[clap(flatten)] // -n
	make_nameref: MakeNameRefFlag,
	#[clap(flatten)] // -r
	make_readonly: MakeReadonlyFlag,
	#[clap(flatten)] // -t
	make_traced: MakeTracedFlag,
	#[clap(flatten)] // -u
	uppercase_value_on_assignment: UppercaseValueOnAssignmentFlag,
	#[clap(flatten)] // -x
	make_exported: MakeExportedFlag,

	//
	// Declarations
	//
	// N.B. These are skipped by clap, but filled in by the BuiltinDeclarationCommand trait.
	#[clap(skip)]
	declarations: Vec<brush_core::CommandArg>,
}

#[derive(Clone, Copy)]
enum DeclareVerb {
	Declare,
	Local,
	Readonly,
}

impl builtins::DeclarationCommand for DeclareCommand {
	fn set_declarations(&mut self, declarations: Vec<brush_core::CommandArg>) {
		self.declarations = declarations;
	}
}

impl builtins::Command for DeclareCommand {
	type Error = brush_core::Error;

	fn takes_plus_options() -> bool {
		true
	}

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		mut context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		let verb = match context.command_name.as_str() {
			"local" => DeclareVerb::Local,
			"readonly" => DeclareVerb::Readonly,
			_ => DeclareVerb::Declare,
		};

		if matches!(verb, DeclareVerb::Local) && !context.shell.in_function() {
			writeln!(context.stderr(), "can only be used in a function")?;
			return Ok(ExecutionResult::general_error());
		}

		let mut result = ExecutionResult::success();
		if !self.declarations.is_empty() {
			for declaration in &self.declarations {
				if self.print && !matches!(verb, DeclareVerb::Readonly) {
					if !self.try_display_declaration(&context, declaration, verb)? {
						result = ExecutionResult::general_error();
					}
				} else {
					if !self.process_declaration(&mut context, declaration, verb).await? {
						result = ExecutionResult::general_error();
					}
				}
			}
		} else {
			// Display matching declarations from the variable environment.
			if !self.function_names_only && !self.function_names_or_defs_only {
				self.display_matching_env_declarations(&context, verb)?;
			}

			// Do the same for functions.
			if !matches!(verb, DeclareVerb::Local | DeclareVerb::Readonly)
				&& (!self.print || self.function_names_only || self.function_names_or_defs_only)
			{
				self.display_matching_functions(&context)?;
			}
		}

		Ok(result)
	}
}

impl DeclareCommand {
	fn try_display_declaration(
		&self,
		context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		declaration: &brush_core::CommandArg,
		verb: DeclareVerb,
	) -> Result<bool, brush_core::Error> {
		let name = match declaration {
			brush_core::CommandArg::String(s) => s,
			brush_core::CommandArg::Assignment(_) => {
				writeln!(context.stderr(), "declare: {declaration}: not found")?;
				return Ok(false);
			},
		};

		let lookup = if matches!(verb, DeclareVerb::Local) {
			EnvironmentLookup::OnlyInCurrentLocal
		} else {
			EnvironmentLookup::Anywhere
		};

		if self.function_names_only || self.function_names_or_defs_only {
			if let Some(func_registration) = context.shell.funcs().get(name) {
				if self.function_names_only {
					if self.print {
						writeln!(context.stdout(), "declare -f {name}")?;
					} else {
						writeln!(context.stdout(), "{name}")?;
					}
				} else {
					writeln!(context.stdout(), "{}", func_registration.definition())?;
				}
				Ok(true)
			} else {
				// For some reason, bash does not print an error message in this case.
				Ok(false)
			}
		} else if let Some(variable) = context.shell.env().get_using_policy(name, lookup) {
			let mut cs = variable.attribute_flags(context.shell);
			if cs.is_empty() {
				cs.push('-');
			}

			let resolved_value = variable.resolve_value(context.shell);
			let separator_str = if matches!(resolved_value, ShellValue::Unset(_)) {
				""
			} else {
				"="
			};

			writeln!(
				context.stdout(),
				"declare -{cs} {name}{separator_str}{}",
				resolved_value.format(variables::FormatStyle::DeclarePrint, context.shell)?
			)?;

			Ok(true)
		} else {
			writeln!(context.stderr(), "declare: {name}: not found")?;
			Ok(false)
		}
	}

	async fn process_declaration(
		&self,
		context: &mut brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		declaration: &brush_core::CommandArg,
		verb: DeclareVerb,
	) -> Result<bool, brush_core::Error> {
		let create_var_local = matches!(verb, DeclareVerb::Local)
			|| (matches!(verb, DeclareVerb::Declare)
				&& context.shell.in_function()
				&& !self.create_global);

		if self.function_names_or_defs_only || self.function_names_only {
			return self.try_display_declaration(context, declaration, verb);
		}

		// Extract the variable name and the initial value being assigned (if any).
		let (name, assigned_index, initial_value, name_is_array, keyed) =
			Self::declaration_to_name_and_value(declaration, &context.params).await?;

		// Special-case: `local -`
		if name == "-" && matches!(verb, DeclareVerb::Local) {
			// TODO(local): `local -` allows shadowing the current `set` options (i.e., $-),
			// with subsequent updates getting discarded when the current local scope is
			// popped.
			tracing::warn!("not yet implemented: local -");
			return Ok(true);
		}

		// Make sure it's a valid name.
		if !env::valid_variable_name(name.as_str()) {
			writeln!(context.stderr(), "{}: {name}: not a valid variable name", context.command_name)?;
			return Ok(false);
		}

		// Figure out where we should look.
		let lookup = if create_var_local {
			EnvironmentLookup::OnlyInCurrentLocal
		} else {
			EnvironmentLookup::Anywhere
		};

		// Look up the variable.
		let refused = if let Some(var) = context
			.shell
			.env_mut()
			.get_mut_using_policy(name.as_str(), lookup)
		{
			if self.make_associative_array.is_some() {
				var.convert_to_associative_array()?;
			}
			if self.make_indexed_array.is_some() {
				var.convert_to_indexed_array()?;
			}

			self.apply_attributes_before_update(var)?;

			// We append if the declaration included an explicit index.
			let append = assigned_index.is_some();
			let start = var.takes_indexes().then(|| var.indexed_literal_start(append));
			let (initial_value, refused) = Self::index_subscripts(
				context,
				&name,
				assigned_index.as_deref(),
				initial_value,
				keyed,
				start,
			)
			.await?;

			// Evaluating a subscript can assign variables, so the variable is
			// found again rather than held across it.
			let var = context
				.shell
				.env_mut()
				.get_mut_using_policy(name.as_str(), lookup)
				.ok_or_else(|| ErrorKind::InternalError(format!("{name} vanished while declared")))?;
			if let Some(initial_value) = initial_value {
				var.assign(initial_value, append, &context.params).await?;
			}

			self.apply_attributes_after_update(var, verb)?;
			refused
		} else {
			let unset_type = if self.make_indexed_array.is_some() {
				ShellValueUnsetType::IndexedArray
			} else if self.make_associative_array.is_some() {
				ShellValueUnsetType::AssociativeArray
			} else if name_is_array {
				ShellValueUnsetType::IndexedArray
			} else {
				ShellValueUnsetType::Untyped
			};

			let mut var = if create_var_local
				&& (self.locals_inherit_from_prev_scope
					|| context.shell.options().local_vars_inherit_value_and_attrs)
				&& let Some(prev_var) = context
					.shell
					.env()
					.get_using_policy(name.as_str(), EnvironmentLookup::Anywhere)
			{
				if prev_var.is_readonly() {
					return Err(ErrorKind::ReadonlyVariable.into());
				}

				let mut var = prev_var.clone();
				var.unset_treat_as_nameref();
				var
			} else {
				ShellVariable::new(ShellValue::Unset(unset_type))
			};

			self.apply_attributes_before_update(&mut var)?;

			let start = var.takes_indexes().then(|| var.indexed_literal_start(false));
			let (initial_value, refused) = Self::index_subscripts(
				context,
				&name,
				assigned_index.as_deref(),
				initial_value,
				keyed,
				start,
			)
			.await?;
			if let Some(initial_value) = initial_value {
				var.assign(initial_value, false, &context.params).await?;
			}

			if context.shell.options().export_variables_on_modification && !var.value().is_array() {
				var.export();
			}

			self.apply_attributes_after_update(&mut var, verb)?;

			let scope = if create_var_local {
				EnvironmentScope::Local
			} else {
				EnvironmentScope::Global
			};

			context.shell.env_mut().add(name, var, scope)?;
			refused
		};

		Ok(!refused)
	}

	/// Gives a declaration's array value the indexes Bash gives it, when it
	/// names a subscript and the variable's subscripts are indexes (`start`
	/// is where they count from; `None` for an associative array's keys).
	///
	/// A literal's elements are evaluated and refused as an assignment's are
	/// ([`ArrayLiteral::evaluate_subscripts`]). `name[subscript]=value`
	/// (`element`) is one element, and a subscript of it that names no element
	/// is refused as Bash refuses it: `name[subscript]: bad array subscript`,
	/// and the declaration fails, though the variable is still declared an
	/// array. Returns the value to assign and whether it was refused.
	async fn index_subscripts(
		context: &mut brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		name: &str,
		element: Option<&str>,
		value: Option<ShellValueLiteral>,
		keyed: bool,
		start: Option<u64>,
	) -> Result<(Option<ShellValueLiteral>, bool), brush_core::Error> {
		let Some(start) = start.filter(|_| keyed) else {
			return Ok((value, false));
		};
		let literal = match value {
			Some(ShellValueLiteral::Array(literal)) => literal,
			other => return Ok((other, false)),
		};

		let Some(subscript) = element else {
			let literal = literal
				.evaluate_subscripts(context.shell, &context.params, start)
				.await?;
			return Ok((Some(ShellValueLiteral::Array(literal)), false));
		};

		let mut elements = literal.0;
		match variables::evaluate_index_subscript(context.shell, &context.params, subscript, start)
			.await?
		{
			Some(index) => {
				if let Some((key, _)) = elements.first_mut() {
					*key = Some(index.to_string());
				}
				Ok((Some(ShellValueLiteral::Array(ArrayLiteral(elements))), false))
			},
			None => {
				let word = format!("{name}[{subscript}]");
				let refusal = brush_core::Error::from(ErrorKind::BadArraySubscript(word));
				let mut stderr = context.params.stderr(context.shell);
				let _ = context.shell.display_error(&mut stderr, &refusal).await;
				// Nothing is assigned, but an empty literal still makes the
				// variable the array its declaration names.
				Ok((Some(ShellValueLiteral::Array(ArrayLiteral(Vec::new()))), true))
			},
		}
	}

	/// The name a declaration declares, the subscript it assigns at
	/// (`name[subscript]=value`), the value it assigns, whether the name
	/// itself makes the variable an array, and whether that value names any
	/// subscript — learned while the literal is copied, so a literal with none
	/// pays nothing for the question.
	async fn declaration_to_name_and_value(
		declaration: &brush_core::CommandArg,
		params: &brush_core::ExecutionParameters,
	) -> Result<(String, Option<String>, Option<ShellValueLiteral>, bool, bool), brush_core::Error> {
		let name;
		let assigned_index;
		let initial_value;
		let name_is_array;
		let mut keyed = false;

		match declaration {
			brush_core::CommandArg::String(s) => {
				// We need to handle the case of someone invoking `declare array[index]`.
				// In such case, we ignore the index and treat it as a declaration of
				// the array.
				#[allow(
					clippy::unwrap_in_result,
					clippy::unwrap_used,
					reason = "regex is valid and should not fail"
				)]
				static ARRAY_AND_INDEX_RE: LazyLock<fancy_regex::Regex> =
					LazyLock::new(|| fancy_regex::Regex::new(r"^(.*?)\[(.*?)\]$").unwrap());

				// Every copy below is of text the caller expanded —
				// `declare "$big"`, `declare "a[$big]=$big"` — so each takes
				// the divided copy rather than `to_owned`. The bounds come out
				// of the captures first, so nothing borrowed from the regex is
				// held across a checkpoint.
				let bounds = ARRAY_AND_INDEX_RE.captures(s)?.map(|captures| {
					(
						captures.get(1).map(|m| (m.start(), m.end())),
						captures.get(2).map(|m| (m.start(), m.end())),
					)
				});

				if let Some((matched_name, matched_index)) = bounds {
					let (start, end) = matched_name.ok_or_else(|| {
						brush_core::ErrorKind::InternalError("declaration parse error".into())
					})?;
					name = brush_core::clone_in_strides(params, &s[start..end]).await?;

					assigned_index = match matched_index {
						Some((start, end)) => {
							Some(brush_core::clone_in_strides(params, &s[start..end]).await?)
						},
						None => None,
					};
					name_is_array = true;
				} else {
					name = brush_core::clone_in_strides(params, s).await?;
					assigned_index = None;
					name_is_array = false;
				}
				initial_value = None;
			},
			brush_core::CommandArg::Assignment(assignment) => {
				match &assignment.name {
					ast::AssignmentName::VariableName(var_name) => {
						name = brush_core::clone_in_strides(params, var_name).await?;
						assigned_index = None;
					},
					ast::AssignmentName::ArrayElementName(var_name, index) => {
						if matches!(assignment.value, ast::AssignmentValue::Array(_)) {
							return Err(ErrorKind::AssigningListToArrayMember.into());
						}

						name = brush_core::clone_in_strides(params, var_name).await?;
						assigned_index = Some(brush_core::clone_in_strides(params, index).await?);
					},
				}

				// The value is the measured hold: `declare BIG="$big"` cloned
				// the whole word here and then handed it to a write that had
				// already been divided, so the time stayed in the clone.
				match &assignment.value {
					ast::AssignmentValue::Scalar(s) => {
						let value = brush_core::clone_in_strides(params, &s.value).await?;
						if let Some(index) = &assigned_index {
							let index = brush_core::clone_in_strides(params, index).await?;
							initial_value =
								Some(ShellValueLiteral::Array(ArrayLiteral(vec![(Some(index), value)])));
							name_is_array = true;
							keyed = true;
						} else {
							initial_value = Some(ShellValueLiteral::Scalar(value));
							name_is_array = false;
						}
					},
					ast::AssignmentValue::Array(a) => {
						let (literal, literal_keyed) =
							ArrayLiteral::from_assignment_elements(a, params).await?;
						initial_value = Some(ShellValueLiteral::Array(literal));
						name_is_array = true;
						keyed = literal_keyed;
					},
				}
			},
		}

		Ok((name, assigned_index, initial_value, name_is_array, keyed))
	}

	fn display_matching_env_declarations(
		&self,
		context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		verb: DeclareVerb,
	) -> Result<(), brush_core::Error> {
		//
		// Dump all declarations. Use attribute flags to filter which variables are
		// dumped.
		//

		// We start by excluding all variables that are not enumerable.
		#[expect(clippy::type_complexity)]
		let mut filters: Vec<Box<dyn Fn((&String, &ShellVariable)) -> bool>> =
			vec![Box::new(|(_, v)| v.is_enumerable())];

		// Add filters depending on verb.
		if matches!(verb, DeclareVerb::Readonly) {
			filters.push(Box::new(|(_, v)| v.is_readonly()));
		}

		// Add filters depending on attribute flags.
		if let Some(value) = self.make_indexed_array.to_bool() {
			filters.push(Box::new(move |(_, v)| {
				matches!(v.value(), ShellValue::IndexedArray(_)) == value
			}));
		}
		if let Some(value) = self.make_associative_array.to_bool() {
			filters.push(Box::new(move |(_, v)| {
				matches!(v.value(), ShellValue::AssociativeArray(_)) == value
			}));
		}
		if let Some(value) = self.make_integer.to_bool() {
			filters.push(Box::new(move |(_, v)| v.is_treated_as_integer() == value));
		}
		if let Some(value) = self.capitalize_value_on_assignment.to_bool() {
			filters.push(Box::new(move |(_, v)| {
				matches!(v.get_update_transform(), ShellVariableUpdateTransform::Capitalize) == value
			}));
		}
		if let Some(value) = self.lowercase_value_on_assignment.to_bool() {
			filters.push(Box::new(move |(_, v)| {
				matches!(v.get_update_transform(), ShellVariableUpdateTransform::Lowercase) == value
			}));
		}
		if let Some(value) = self.make_nameref.to_bool() {
			filters.push(Box::new(move |(_, v)| v.is_treated_as_nameref() == value));
		}
		if let Some(value) = self.make_readonly.to_bool() {
			filters.push(Box::new(move |(_, v)| v.is_readonly() == value));
		}
		if let Some(value) = self.make_traced.to_bool() {
			filters.push(Box::new(move |(_, v)| v.is_trace_enabled() == value));
		}
		if let Some(value) = self.uppercase_value_on_assignment.to_bool() {
			filters.push(Box::new(move |(_, v)| {
				matches!(v.get_update_transform(), ShellVariableUpdateTransform::Uppercase) == value
			}));
		}
		if let Some(value) = self.make_exported.to_bool() {
			filters.push(Box::new(move |(_, v)| v.is_exported() == value));
		}

		let iter_policy = if matches!(verb, DeclareVerb::Local) {
			EnvironmentLookup::OnlyInCurrentLocal
		} else {
			EnvironmentLookup::Anywhere
		};

		// Iterate through an ordered list of all matching declarations tracked in the
		// environment.
		for (name, variable) in context
			.shell
			.env()
			.iter_using_policy(iter_policy)
			.filter(|pair| filters.iter().all(|f| f(*pair)))
			.sorted_by_key(|v| v.0)
		{
			if self.print {
				let mut cs = variable.attribute_flags(context.shell);
				if cs.is_empty() {
					cs.push('-');
				}

				let separator_str = if matches!(variable.value(), ShellValue::Unset(_)) {
					""
				} else {
					"="
				};

				writeln!(
					context.stdout(),
					"declare -{cs} {name}{separator_str}{}",
					variable
						.value()
						.format(variables::FormatStyle::DeclarePrint, context.shell)?
				)?;
			} else {
				writeln!(
					context.stdout(),
					"{name}={}",
					variable
						.value()
						.format(variables::FormatStyle::Basic, context.shell)?
				)?;
			}
		}

		Ok(())
	}

	fn display_matching_functions(
		&self,
		context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
	) -> Result<(), brush_core::Error> {
		for (name, registration) in context.shell.funcs().iter().sorted_by_key(|v| v.0) {
			if self.function_names_only {
				writeln!(context.stdout(), "declare -f {name}")?;
			} else {
				writeln!(context.stdout(), "{}", registration.definition())?;
			}
		}

		Ok(())
	}

	#[expect(clippy::unnecessary_wraps)]
	const fn apply_attributes_before_update(
		&self,
		var: &mut ShellVariable,
	) -> Result<(), brush_core::Error> {
		if let Some(value) = self.make_integer.to_bool() {
			if value {
				var.treat_as_integer();
			} else {
				var.unset_treat_as_integer();
			}
		}
		if let Some(value) = self.capitalize_value_on_assignment.to_bool() {
			if value {
				var.set_update_transform(ShellVariableUpdateTransform::Capitalize);
			} else if matches!(var.get_update_transform(), ShellVariableUpdateTransform::Capitalize) {
				var.set_update_transform(ShellVariableUpdateTransform::None);
			}
		}
		if let Some(value) = self.lowercase_value_on_assignment.to_bool() {
			if value {
				var.set_update_transform(ShellVariableUpdateTransform::Lowercase);
			} else if matches!(var.get_update_transform(), ShellVariableUpdateTransform::Lowercase) {
				var.set_update_transform(ShellVariableUpdateTransform::None);
			}
		}
		if let Some(value) = self.make_nameref.to_bool() {
			if value {
				var.treat_as_nameref();
			} else {
				var.unset_treat_as_nameref();
			}
		}
		if let Some(value) = self.make_traced.to_bool() {
			if value {
				var.enable_trace();
			} else {
				var.disable_trace();
			}
		}
		if let Some(value) = self.uppercase_value_on_assignment.to_bool() {
			if value {
				var.set_update_transform(ShellVariableUpdateTransform::Uppercase);
			} else if matches!(var.get_update_transform(), ShellVariableUpdateTransform::Uppercase) {
				var.set_update_transform(ShellVariableUpdateTransform::None);
			}
		}
		if let Some(value) = self.make_exported.to_bool() {
			if value {
				var.export();
			} else {
				var.unexport();
			}
		}

		Ok(())
	}

	fn apply_attributes_after_update(
		&self,
		var: &mut ShellVariable,
		verb: DeclareVerb,
	) -> Result<(), brush_core::Error> {
		if matches!(verb, DeclareVerb::Readonly) {
			var.set_readonly();
		} else if let Some(value) = self.make_readonly.to_bool() {
			if value {
				var.set_readonly();
			} else {
				var.unset_readonly()?;
			}
		}

		Ok(())
	}
}

#[cfg(test)]
mod tests {
	//! Array subscripts in declarations, against what Bash 5.2 printed for
	//! the same scripts. Bash's diagnostic is `bash: line 1: <word>: bad array
	//! subscript`; brush's error formatter writes the same message as
	//! `error: <word>: bad array subscript`.

	use crate::host::run_script;

	/// Runs `script` and returns its status, stdout and stderr.
	async fn sh(script: &str) -> (i32, String, String) {
		run_script(script, "", &std::env::temp_dir()).await
	}

	struct Case {
		script: &'static str,
		stdout: &'static str,
		stderr: &'static str,
	}

	async fn differences(cases: &[Case]) -> Vec<String> {
		let mut differences = Vec::new();
		for &Case { script, stdout, stderr } in cases {
			let (status, out, err) = sh(script).await;
			if (status, out.as_str(), err.as_str()) != (0, stdout, stderr) {
				differences.push(format!(
					"{script}\n  got    ({status}, {out:?}, {err:?})\n  wanted (0, {stdout:?}, \
					 {stderr:?})"
				));
			}
		}
		differences
	}

	/// The reviewer's three scripts, as they wrote them.
	#[tokio::test]
	async fn a_negative_subscript_past_a_scalar_keeps_it() {
		let cases = [
			Case {
				script: r#"x=base; x+=([-2]=''); printf '<%s>\n' "${x[0]}""#,
				stdout: "<base>\n",
				stderr: "error: [-2]=: bad array subscript\n",
			},
			Case {
				script: r#"export x=base; x+=([-2]=''); printf '<%s>\n' "${x[0]}"; declare -p x"#,
				stdout: "<base>\ndeclare -ax x=([0]=\"base\")\n",
				stderr: "error: [-2]=: bad array subscript\n",
			},
			Case {
				script: r#"declare -u x=base; x+=([-2]=''); printf '<%s>\n' "${x[0]}"; declare -p x"#,
				stdout: "<BASE>\ndeclare -au x=([0]=\"BASE\")\n",
				stderr: "error: [-2]=: bad array subscript\n",
			},
		];
		let differences = differences(&cases).await;
		assert!(differences.is_empty(), "{}", differences.join("\n"));
	}

	/// The forms that assign an explicit empty value at `0` keep it there.
	#[tokio::test]
	async fn an_explicit_empty_zero_still_replaces_the_scalar() {
		let cases = [
			Case {
				script: r#"x=base; x+=([0]=''); printf '<%s>|<%s>\n' "${x[0]}" "${#x[@]}""#,
				stdout: "<>|<1>\n",
				stderr: "",
			},
			Case {
				script: r#"x=base; x+=([0]='' [1]=one); printf '<%s>|<%s>\n' "${x[0]}" "${x[1]}""#,
				stdout: "<>|<one>\n",
				stderr: "",
			},
			Case {
				script: r#"x=base; x+=([1]=one [0]=''); printf '<%s>|<%s>\n' "${x[0]}" "${x[1]}""#,
				stdout: "<>|<one>\n",
				stderr: "",
			},
			Case {
				script: r#"x=base; x+=([0]=new [0]=''); printf '<%s>\n' "${x[0]}""#,
				stdout: "<>\n",
				stderr: "",
			},
			Case {
				script: r#"x=base; x+=([0]="$(printf '')"); printf '<%s>\n' "${x[0]}""#,
				stdout: "<>\n",
				stderr: "",
			},
			Case {
				script: r#"declare -u x=base; x+=([0]=''); printf '<%s>\n' "${x[0]}""#,
				stdout: "<>\n",
				stderr: "",
			},
			Case {
				script: r#"x=base; x+=([00]=''); printf '<%s>\n' "${x[0]}""#,
				stdout: "<>\n",
				stderr: "",
			},
		];
		let differences = differences(&cases).await;
		assert!(differences.is_empty(), "{}", differences.join("\n"));
	}

	/// `declare`, `local`, `readonly` and `export` read a literal's
	/// subscripts as the plain assignment does.
	#[tokio::test]
	async fn declaration_literals_read_subscripts_like_bash() {
		let cases = [
			Case {
				script: "declare -a a=([-1]=x b); declare -p a",
				stdout: "declare -a a=([0]=\"b\")\n",
				stderr: "error: [-1]=x: bad array subscript\n",
			},
			Case {
				script: "a=(1 2 3); declare -a a=([-1]=z w); declare -p a",
				stdout: "declare -a a=([0]=\"w\")\n",
				stderr: "error: [-1]=z: bad array subscript\n",
			},
			Case {
				script: "declare -ai n=([1+1]=7); declare -p n",
				stdout: "declare -ai n=([2]=\"7\")\n",
				stderr: "",
			},
			Case {
				script: "i=0; declare a=([i++]=x [i++]=y); declare -p a i",
				stdout: "declare -a a=([0]=\"x\" [1]=\"y\")\ndeclare -- i=\"2\"\n",
				stderr: "",
			},
			Case {
				script: "f() { local a=([1+1]=x [-1]=y b); declare -p a; local b[1+1]=v; declare -p b; \
				         }; f",
				stdout: "declare -a a=([2]=\"y\" [3]=\"b\")\ndeclare -a b=([2]=\"v\")\n",
				stderr: "",
			},
			Case {
				script: "readonly r=([1+1]=x [-1]=y); declare -p r",
				stdout: "declare -ar r=([2]=\"y\")\n",
				stderr: "",
			},
			Case {
				script: "export a=([1+1]=x [-1]=y b); declare -p a",
				stdout: "declare -ax a=([2]=\"y\" [3]=\"b\")\n",
				stderr: "",
			},
			Case {
				script: "export a=([-1]=x b); declare -p a",
				stdout: "declare -ax a=([0]=\"b\")\n",
				stderr: "error: [-1]=x: bad array subscript\n",
			},
			Case {
				script: "declare -A A=([1+1]=v [-1]=w); declare -p A",
				stdout: "declare -A A=([-1]=\"w\" [1+1]=\"v\" )\n",
				stderr: "",
			},
		];
		let differences = differences(&cases).await;
		assert!(differences.is_empty(), "{}", differences.join("\n"));
	}

	/// `declare name[subscript]=value` evaluates the subscript and counts a
	/// negative one back from the array it names.
	#[tokio::test]
	async fn a_declared_element_reads_its_subscript_like_bash() {
		let cases = [
			Case {
				script: "declare a[1+1]=x; declare -p a",
				stdout: "declare -a a=([2]=\"x\")\n",
				stderr: "",
			},
			Case {
				script: "a=(1 2); declare a[-1]=x; declare -p a",
				stdout: "declare -a a=([0]=\"1\" [1]=\"x\")\n",
				stderr: "",
			},
			Case {
				script: "x=base; declare x[-1]=z; declare -p x",
				stdout: "declare -a x=([0]=\"z\")\n",
				stderr: "",
			},
		];
		let differences = differences(&cases).await;
		assert!(differences.is_empty(), "{}", differences.join("\n"));
	}

	/// An element subscript still negative fails that declaration, after it
	/// has created the array, and the declarations after it still run.
	#[tokio::test]
	async fn a_declared_element_past_the_start_fails() {
		let (status, out, err) = sh(r#"declare a[-1]=x b=2; echo "st=$? b=$b"; declare -p a"#).await;
		assert_eq!(
			(status, out.as_str(), err.as_str()),
			(0, "st=1 b=2\ndeclare -a a=()\n", "error: a[-1]: bad array subscript\n")
		);
	}
}
