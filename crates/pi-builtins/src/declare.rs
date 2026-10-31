use std::io::Write;

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
					if !self.try_display_declaration(&context, declaration, verb).await? {
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
				self.display_matching_env_declarations(&context, verb).await?;
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
	async fn try_display_declaration(
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

			let resolved_value = variable.value_in_place(context.shell);
			let separator_str = if matches!(resolved_value.as_ref(), ShellValue::Unset(_)) {
				""
			} else {
				"="
			};

			// A value is as long as the script made it, and an array holds any
			// number of elements: `declare -p` of a million of them held the
			// worker 156 ms formatting them in one loop.
			let formatted = resolved_value
				.format_divided(variables::FormatStyle::DeclarePrint, context.shell, &context.params)
				.await?;
			write_declaration(context, &format!("declare -{cs} {name}{separator_str}"), &formatted).await?;

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
			return self.try_display_declaration(context, declaration, verb).await;
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
		let valid = if name.len() > brush_core::DIVIDE_COPY_ABOVE_BYTES {
			brush_core::valid_variable_name_in_strides(&context.params, &name).await?
		} else {
			env::valid_variable_name(name.as_str())
		};
		if !valid {
			// The name is the text the caller expanded, `declare "$big"`.
			let head = format!("{}: ", context.command_name);
			write_line_in_strides(&context.params, context.stderr(), &head, &name, ": not a valid variable name\n")
				.await?;
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
			let integer = var.is_treated_as_integer();
			let (initial_value, refused) = Self::evaluate_value(
				context,
				&name,
				assigned_index.as_deref(),
				initial_value,
				keyed,
				start,
				integer,
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
			let integer = var.is_treated_as_integer();
			let (initial_value, refused) = Self::evaluate_value(
				context,
				&name,
				assigned_index.as_deref(),
				initial_value,
				keyed,
				start,
				integer,
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

	/// Evaluates a declaration's value as Bash does for the variable it
	/// declares: its subscripts, when it names any and the variable's
	/// subscripts are indexes (`start` is where they count from; `None` for an
	/// associative array's keys), and its values, when the variable has the
	/// integer attribute once this declaration's attributes are applied
	/// (`integer`: `declare -i x=3+4` is `7`, `declare +i x=3+4` is `3+4`).
	///
	/// A literal's elements are evaluated and refused as an assignment's are
	/// ([`ArrayLiteral::evaluate_elements`]). `name[subscript]=value`
	/// (`element`) is one element, and a subscript of it that names no element
	/// is refused as Bash refuses it: `name[subscript]: bad array subscript`,
	/// and the declaration fails, though the variable is still declared an
	/// array. Returns the value to assign and whether it was refused.
	async fn evaluate_value(
		context: &mut brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		name: &str,
		element: Option<&str>,
		value: Option<ShellValueLiteral>,
		keyed: bool,
		start: Option<u64>,
		integer: bool,
	) -> Result<(Option<ShellValueLiteral>, bool), brush_core::Error> {
		let literal = match value {
			Some(ShellValueLiteral::Scalar(value)) if integer => {
				let value = variables::integer_value(context.shell, value).await?;
				return Ok((Some(ShellValueLiteral::Scalar(value)), false));
			},
			Some(ShellValueLiteral::Array(literal)) if keyed || integer => literal,
			other => return Ok((other, false)),
		};

		let Some(subscript) = element else {
			let literal = literal
				.evaluate_elements(context.shell, &context.params, start, integer)
				.await?;
			return Ok((Some(ShellValueLiteral::Array(literal)), false));
		};

		let mut elements = literal.0;
		let index = match start {
			Some(start) => {
				variables::evaluate_index_subscript(context.shell, &context.params, subscript, start)
					.await?
			},
			// An associative array's key is the subscript as it stands.
			None => None,
		};
		if start.is_some() && index.is_none() {
			// The subscript is text the caller expanded, of any length, so the
			// message is written a stride at a time rather than built.
			let mut stderr = context.params.stderr(context.shell);
			context
				.shell
				.display_error_around(&mut stderr, &context.params, ErrorKind::BadArraySubscript, &[
					name, "[", subscript, "]",
				])
				.await?;
			// Nothing is assigned, but an empty literal still makes the
			// variable the array its declaration names.
			return Ok((Some(ShellValueLiteral::Array(ArrayLiteral(Vec::new()))), true));
		}
		if let Some((key, value)) = elements.first_mut() {
			if let Some(index) = index {
				*key = Some(index.to_string());
			}
			// The value after its subscript, as in a literal.
			if integer {
				*value = variables::integer_value(context.shell, std::mem::take(value)).await?;
			}
		}
		Ok((Some(ShellValueLiteral::Array(ArrayLiteral(elements))), false))
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
				//
				// Every copy below is of text the caller expanded —
				// `declare "$big"`, `declare "a[$big]=$big"` — so each takes
				// the divided copy rather than `to_owned`, and so does the split.
				if let Some(open) = array_and_index_split(params, s).await? {
					name = brush_core::clone_in_strides(params, &s[..open]).await?;
					assigned_index =
						Some(brush_core::clone_in_strides(params, &s[open + 1..s.len() - 1]).await?);
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

	async fn display_matching_env_declarations(
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
		let mut filters: Vec<Box<dyn Fn((&String, &ShellVariable)) -> bool + Send + Sync>> =
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

				// Formatted in steps: one variable can be an array of any size.
				let formatted = variable
					.value()
					.format_divided(variables::FormatStyle::DeclarePrint, context.shell, &context.params)
					.await?;
				write_declaration(context, &format!("declare -{cs} {name}{separator_str}"), &formatted).await?;
			} else {
				let formatted = variable
					.value()
					.format_divided(variables::FormatStyle::Basic, context.shell, &context.params)
					.await?;
				write_declaration(context, &format!("{name}="), &formatted).await?;
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

/// Writes one line of `declare`'s output, `head` and then `formatted`, which
/// is as long as the variable it shows, a stride at a time.
///
/// Writing to a file copies into the page cache inside the system call, and
/// the formatted text of a million-element array is about 20 MiB: one
/// `writeln!` of it was one step.
async fn write_declaration(
	context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
	head: &str,
	formatted: &str,
) -> Result<(), brush_core::Error> {
	write_line_in_strides(&context.params, context.stdout(), head, formatted, "\n").await
}

/// Writes `head`, `body` a stride at a time, and `tail` to `out`: a line whose
/// middle is text of any length, such as a value or the name a caller
/// expanded.
async fn write_line_in_strides(
	params: &brush_core::ExecutionParameters,
	mut out: impl Write + Send,
	head: &str,
	body: &str,
	tail: &str,
) -> Result<(), brush_core::Error> {
	out.write_all(head.as_bytes())?;
	let mut budget = brush_core::ElementBudget::new();
	for stride in body.as_bytes().chunks(brush_core::DIVIDE_COPY_ABOVE_BYTES) {
		let due = budget.charge(stride.len());
		if due > 0 {
			brush_core::loop_checkpoints(params, due).await?;
		}
		out.write_all(stride)?;
	}
	out.write_all(tail.as_bytes())?;
	Ok(())
}

/// Where `s` splits into `name[index]`, as `^(.*?)\[(.*?)\]$` splits it: at
/// its first `[`, when it ends in `]` and holds no newline, since `.` takes
/// any character but a newline and both groups together with the brackets
/// cover the whole of it.
///
/// The declaration is text the caller expanded, `declare "$big"`, so it is
/// read a stride at a time; the regex read 64 MiB in one call.
async fn array_and_index_split(
	params: &brush_core::ExecutionParameters,
	s: &str,
) -> Result<Option<usize>, brush_core::Error> {
	if !s.ends_with(']') {
		return Ok(None);
	}
	const STRIDE: usize = 64 * 1024;
	let mut first_open = None;
	let mut budget = brush_core::ElementBudget::new();
	for (n, stride) in s.as_bytes().chunks(STRIDE).enumerate() {
		let due = budget.charge(stride.len());
		if due > 0 {
			brush_core::loop_checkpoints(params, due).await?;
		}
		if stride.contains(&b'\n') {
			return Ok(None);
		}
		if first_open.is_none() {
			first_open = stride.iter().position(|byte| *byte == b'[').map(|at| n * STRIDE + at);
		}
	}
	Ok(first_open)
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

	struct Case<'a> {
		script: &'a str,
		stdout: &'a str,
		stderr: &'a str,
	}

	async fn differences(cases: &[Case<'_>]) -> Vec<String> {
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
				script: "declare -ai n=([1+1]=3+4); declare -p n",
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

	/// Two subscripts Bash accepts and an earlier head refused with an
	/// arithmetic error, through every route that assigns a literal: a blank
	/// subscript is `0`, and a literal too long for 64 bits wraps, so
	/// `18446744073709551616` is `0`. Expected text is Bash 5.2's.
	#[tokio::test]
	async fn blank_and_overflowing_subscripts_are_what_bash_makes_them() {
		let expected = |flags: &str| format!("declare -{flags} x=([0]=\"7\" [1]=\"tail\")\n");
		let mut cases = Vec::new();
		for subscript in ["' '", "18446744073709551616"] {
			for (route, flags) in [
				("x=(10 20); x=([{s}]=7 tail); declare -p x", "a"),
				("x=(); x+=([{s}]=7 tail); declare -p x", "a"),
				("x=(10 20); declare x=([{s}]=7 tail); declare -p x", "a"),
				("x=(10 20); export x=([{s}]=7 tail); declare -p x", "ax"),
				("readonly x=([{s}]=7 tail); declare -p x", "ar"),
				("f() { local x=([{s}]=7 tail); declare -p x; }; f", "a"),
			] {
				cases.push((route.replace("{s}", subscript), expected(flags)));
			}
		}
		let cases: Vec<Case<'_>> = cases
			.iter()
			.map(|(script, stdout)| Case { script, stdout, stderr: "" })
			.collect();
		let differences = differences(&cases).await;
		assert!(differences.is_empty(), "{}", differences.join("\n"));
	}

	/// A variable with the integer attribute takes the arithmetic value of
	/// what it is given, by every route that writes it, as Bash does. Each
	/// expected text is Bash 5.2's.
	#[tokio::test]
	async fn an_integer_variable_evaluates_what_it_is_given() {
		let cases = [
			Case {
				script: "declare -i y=3+4; declare -p y",
				stdout: "declare -i y=\"7\"\n",
				stderr: "",
			},
			Case {
				script: "i=0; declare -ia z=([i++]=i++ [i++]=i++); declare -p z i",
				stdout: "declare -ai z=([0]=\"1\" [2]=\"3\")\ndeclare -- i=\"4\"\n",
				stderr: "",
			},
			Case {
				script: "i=0; declare -ia z; z+=([i++]=i++ [i++]=i++); declare -p z i",
				stdout: "declare -ai z=([0]=\"1\" [2]=\"3\")\ndeclare -- i=\"4\"\n",
				stderr: "",
			},
			Case {
				script: "i=0; declare -ia a; a[i++]=i++; declare -p a i",
				stdout: "declare -ai a=([0]=\"1\")\ndeclare -- i=\"2\"\n",
				stderr: "",
			},
			Case {
				script: "y=5; declare -i x; x='y*2'; echo $x; x+=y; echo $x; x+='3*3'; echo $x",
				stdout: "10\n15\n24\n",
				stderr: "",
			},
			Case {
				script: "declare -ia b; b[1+1]=3+4; b+=(1+1); declare -ia c=([1]=5); c[1]+=2; \
				         declare -p b c",
				stdout: "declare -ai b=([2]=\"7\" [3]=\"2\")\ndeclare -ai c=([1]=\"7\")\n",
				stderr: "",
			},
			Case {
				script: "declare -i s; s=(1+1 2+2); declare -p s",
				stdout: "declare -ai s=([0]=\"2\" [1]=\"4\")\n",
				stderr: "",
			},
			Case {
				script: "declare -iA m=([k]=1+1); m[j]+=2*3; echo ${m[k]} ${m[j]}",
				stdout: "2 6\n",
				stderr: "",
			},
			Case {
				script: "declare -i e='' f=' '; declare -p e f",
				stdout: "declare -i e=\"0\"\ndeclare -i f=\"0\"\n",
				stderr: "",
			},
			Case {
				script: "declare -i x; declare +i x=3+4; declare -p x; declare -i y=2; declare y=1+1; \
				         declare -p y",
				stdout: "declare -- x=\"3+4\"\ndeclare -i y=\"2\"\n",
				stderr: "",
			},
			Case {
				script: "declare -i z; z=010; echo $z; z=0x1f; echo $z; z=99999999999999999999; echo $z",
				stdout: "8\n31\n7766279631452241919\n",
				stderr: "",
			},
			Case {
				script: "declare -i g; export g=3*3; echo $g; f() { local -i v=2**10; echo $v; }; f",
				stdout: "9\n1024\n",
				stderr: "",
			},
			Case {
				script: "declare -i n; read n <<< '2+3'; echo $n; printf -v n %s '4*4'; echo $n; \
				         for n in 1+1; do echo $n; done; unset n; declare -i n; echo ${n:=2+3} $n",
				stdout: "5\n16\n2\n5 5\n",
				stderr: "",
			},
			Case {
				script: "declare -ia r; read -a r <<< '1+1 2+2'; declare -p r; declare -i REPLY; \
				         read <<< '3*3'; echo $REPLY",
				stdout: "declare -ai r=([0]=\"2\" [1]=\"4\")\n9\n",
				stderr: "",
			},
		];
		let differences = differences(&cases).await;
		assert!(differences.is_empty(), "{}", differences.join("\n"));
	}

	/// A value that is not an expression, and a subscript whose arithmetic
	/// fails, end the script as Bash's syntax and division errors do, through
	/// `declare` as through the assignment, rather than storing zero. Bash
	/// 5.2 prints nothing on stdout and exits `1` for each.
	#[tokio::test]
	async fn a_failed_value_or_subscript_ends_the_script() {
		for script in [
			"declare -i x; x=1+\necho after",
			"declare -i x=1+\necho after",
			"declare -i x; x='$y'\necho after",
			"x=(1); declare x=([1/0]=1)\necho after",
			"x=([1/0]=1)\necho after",
			"x=(1); x[-5]=v\necho after",
			"x=(1); x[@]=v\necho after",
			"x=(1); x[' ']=7\necho after",
		] {
			let (status, out, _) = sh(script).await;
			assert_eq!((status, out.as_str()), (1, ""), "{script}");
		}
	}

	/// Arithmetic text keeps its single quotes as Bash keeps them, so a
	/// single-quoted operand is a syntax error, while double quotes are
	/// removed and a blank expression is zero. Bash 5.2 prints `3` and `0`,
	/// and nothing for the single-quoted operand.
	#[tokio::test]
	async fn arithmetic_text_keeps_its_single_quotes() {
		let (status, out, _) = sh("echo $(( \"1\"+2 )); echo $(( \" \" ))").await;
		assert_eq!((status, out.as_str()), (0, "3\n0\n"));
		let (status, out, _) = sh("echo $(( ' ' ))").await;
		assert_eq!((status, out.as_str()), (1, ""));
	}

	/// `@` and `*` name every element: a literal's `[@]=v` is refused with
	/// Bash's message and skipped, the rest of the literal assigned, by every
	/// route; `declare x[@]=v` fails that declaration. Expected text is Bash
	/// 5.2's, with brush's `error: ` prefix.
	#[tokio::test]
	async fn every_element_subscripts_are_refused_like_bash() {
		let cases = [
			Case {
				script: "x=([@]=1 b c); echo st=$?; declare -p x",
				stdout: "st=0\ndeclare -a x=([0]=\"b\" [1]=\"c\")\n",
				stderr: "error: [@]=1: cannot assign to non-numeric index\n",
			},
			Case {
				script: "x=(old); x=([*]=1 b); declare -p x",
				stdout: "declare -a x=([0]=\"b\")\n",
				stderr: "error: [*]=1: cannot assign to non-numeric index\n",
			},
			Case {
				script: "x=(o); declare x=([@]=1 b); echo st=$?; declare -p x",
				stdout: "st=0\ndeclare -a x=([0]=\"b\")\n",
				stderr: "error: [@]=1: cannot assign to non-numeric index\n",
			},
			Case {
				script: "x=(o); x+=([@]=1 b); declare -p x",
				stdout: "declare -a x=([0]=\"o\" [1]=\"b\")\n",
				stderr: "error: [@]=1: cannot assign to non-numeric index\n",
			},
			Case {
				script: "x=(o); declare x[@]=1; echo st=$?; declare -p x",
				stdout: "st=1\ndeclare -a x=([0]=\"o\")\n",
				stderr: "error: x[@]: bad array subscript\n",
			},
			Case {
				script: "declare -A m=([@]=1); echo ${m[@]}",
				stdout: "1\n",
				stderr: "",
			},
		];
		let differences = differences(&cases).await;
		assert!(differences.is_empty(), "{}", differences.join("\n"));
	}
}
