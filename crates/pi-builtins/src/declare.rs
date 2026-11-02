use std::{io::Write, sync::LazyLock};

use brush_core::{
	ErrorKind, ExecutionResult,
	arithmetic::{EvalError, Evaluatable},
	builtins,
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
					match self.process_declaration(&mut context, declaration, verb) {
						Ok(true) => {},
						Ok(false) => result = ExecutionResult::general_error(),
						// A builtin's error fails only the builtin, so one that
						// ends the shell (see `element_key`) ends it here.
						Err(error) if error.is_fatal() => return Ok(error.into_result(context.shell)),
						Err(error) => return Err(error),
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

	fn process_declaration(
		&self,
		context: &mut brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		declaration: &brush_core::CommandArg,
		verb: DeclareVerb,
	) -> Result<bool, brush_core::Error> {
		// `-g` declares in the global scope, for `local` too, as in Bash.
		let create_var_local = !self.create_global
			&& (matches!(verb, DeclareVerb::Local)
				|| (matches!(verb, DeclareVerb::Declare) && context.shell.in_function()));

		if self.function_names_or_defs_only || self.function_names_only {
			return self.try_display_declaration(context, declaration, verb);
		}

		// Extract the variable name and the initial value being assigned (if any).
		let (name, assigned_index, initial_value, name_is_array, append) =
			Self::declaration_to_name_and_value(declaration)?;

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

		// A local that inherits (`local -I`, `shopt -s localvar_inherit`) takes
		// the outer variable's value and attributes, so its type too.
		let inherits = create_var_local
			&& (self.locals_inherit_from_prev_scope
				|| context.shell.options().local_vars_inherit_value_and_attrs);

		// Bash's order for one declaration word: resolve the variable the word
		// names and its attributes; refuse what must be refused; create the new
		// variable (a new local hides the outer one from here on); and only then
		// evaluate the subscript, once, against that variable. So a refused word
		// runs nothing in its subscript, and `local a[a[0]]=x` reads the new
		// local `a`. Each refusal returns 1 and the words after it still run.

		// `readonly` is a special builtin: in POSIX mode its error ends the
		// shell.
		let fatal = matches!(verb, DeclareVerb::Readonly) && context.shell.options().posix_mode;

		// `readonly` takes no element, and a name reference made by `declare`,
		// `local` or `typeset` must name a variable (`readonly -n` makes no name
		// reference).
		let makes_nameref =
			!matches!(verb, DeclareVerb::Readonly) && self.make_nameref.to_bool() == Some(true);
		if let Some(subscript) = &assigned_index {
			if matches!(verb, DeclareVerb::Readonly) {
				return Self::refuse(context, fatal, format_args!("`{name}[{subscript}]': not a valid identifier"));
			}
			if makes_nameref {
				return Self::refuse(
					context,
					fatal,
					format_args!("`{name}[{subscript}]': invalid variable name for name reference"),
				);
			}
		}
		if makes_nameref
			&& let Some(ShellValueLiteral::Scalar(target)) = &initial_value
			&& !env::valid_variable_name(target.split('[').next().unwrap_or_default())
		{
			return Self::refuse(
				context,
				fatal,
				format_args!("`{target}': invalid variable name for name reference"),
			);
		}

		// A readonly variable keeps its value, a local cannot hide one, and an
		// array keeps its kind.
		let env = context.shell.env();
		let existing = env.get_using_policy(name.as_str(), lookup);
		let exists = existing.is_some();
		let hides_readonly = existing.is_none()
			&& create_var_local
			&& env
				.get_using_policy(name.as_str(), EnvironmentLookup::Anywhere)
				.is_some_and(|var| var.is_readonly());
		let (readonly, associative, indexed) = existing.map_or((false, false, false), |var| {
			(
				var.is_readonly(),
				matches!(
					var.value(),
					ShellValue::AssociativeArray(_) | ShellValue::Unset(ShellValueUnsetType::AssociativeArray)
				),
				matches!(
					var.value(),
					ShellValue::IndexedArray(_) | ShellValue::Unset(ShellValueUnsetType::IndexedArray)
				),
			)
		});
		if (readonly && initial_value.is_some()) || hides_readonly {
			return Self::refuse(context, fatal, format_args!("{name}: readonly variable"));
		}
		if associative && self.make_indexed_array.is_some() {
			writeln!(
				context.stderr(),
				"{}: {name}: cannot convert associative to indexed array",
				context.command_name
			)?;
			return Ok(false);
		}
		if indexed && self.make_associative_array.is_some() {
			writeln!(
				context.stderr(),
				"{}: {name}: cannot convert indexed to associative array",
				context.command_name
			)?;
			return Ok(false);
		}

		// Create the new variable before the subscript is evaluated.
		let created = !exists;
		if created {
			let unset_type = if self.make_indexed_array.is_some() {
				ShellValueUnsetType::IndexedArray
			} else if self.make_associative_array.is_some() {
				ShellValueUnsetType::AssociativeArray
			} else if name_is_array {
				ShellValueUnsetType::IndexedArray
			} else {
				ShellValueUnsetType::Untyped
			};

			let mut var = if inherits
				&& let Some(prev_var) = context
					.shell
					.env()
					.get_using_policy(name.as_str(), EnvironmentLookup::Anywhere)
			{
				let mut var = prev_var.clone();
				var.unset_treat_as_nameref();
				var
			} else {
				ShellVariable::new(ShellValue::Unset(unset_type))
			};
			self.apply_attributes_before_update(&mut var)?;

			let scope = if create_var_local {
				EnvironmentScope::Local
			} else {
				EnvironmentScope::Global
			};
			context.shell.env_mut().add(name.clone(), var, scope)?;
		}

		// The element `name[subscript]=value` writes, as the same assignment
		// outside `declare` names it.
		let element = match assigned_index {
			Some(subscript) if initial_value.is_some() => {
				match self.element_key(context, name.as_str(), lookup, subscript)? {
					Some(key) => Some(key),
					None => return Ok(false),
				}
			},
			_ => None,
		};

		let export_on_modification = context.shell.options().export_variables_on_modification;
		let Some(var) = context
			.shell
			.env_mut()
			.get_mut_using_policy(name.as_str(), lookup)
		else {
			return Err(ErrorKind::InternalError(format!("{name}: declared variable vanished")).into());
		};
		if !created {
			if self.make_associative_array.is_some() {
				var.convert_to_associative_array()?;
			}
			if self.make_indexed_array.is_some() {
				var.convert_to_indexed_array()?;
			}
			self.apply_attributes_before_update(var)?;
		}

		if let Some(initial_value) = initial_value {
			// A value the variable cannot take (`a[-5]=x` past the start)
			// fails this word only.
			if let Err(error) = Self::assign_declared_value(var, element, initial_value, append) {
				writeln!(context.stderr(), "{}: {error}", context.command_name)?;
				return Ok(false);
			}
		}

		if created && export_on_modification && !var.value().is_array() {
			var.export();
		}

		self.apply_attributes_after_update(var, verb)?;

		Ok(true)
	}

	/// Refuses one declaration word: says why and fails it, so the words after
	/// it still run, or, for a special builtin in POSIX mode (`fatal`), ends
	/// the shell.
	fn refuse(
		context: &mut brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		fatal: bool,
		message: std::fmt::Arguments<'_>,
	) -> Result<bool, brush_core::Error> {
		if fatal {
			return Err(ErrorKind::ReadonlyVariable.into());
		}
		writeln!(context.stderr(), "{}: {message}", context.command_name)?;
		Ok(false)
	}

	/// The element a declaration's `name[subscript]` names in the variable
	/// `name`, which exists by now (a new local already hides the outer one):
	/// an associative array's key is the subscript as it stands, and an
	/// indexed array's index is the subscript's arithmetic value, evaluated
	/// once (`declare a[i++]=x` writes element `i` and increments `i`). Returns
	/// `None`, having said why, for an empty subscript, which names no element
	/// (the variable stays created, as in Bash), and for one that still holds
	/// `$` or a backquote and does not evaluate: Bash expands such a subscript
	/// a second time, which this does not. Any other index that does not
	/// evaluate ends the shell, as in Bash.
	fn element_key(
		&self,
		context: &mut brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		name: &str,
		lookup: EnvironmentLookup,
		subscript: String,
	) -> Result<Option<String>, brush_core::Error> {
		if subscript.is_empty() {
			writeln!(context.stderr(), "{}: {name}[]: bad array subscript", context.command_name)?;
			return Ok(None);
		}

		let associative = self.make_associative_array.is_some()
			|| (!self.make_indexed_array.is_some()
				&& context.shell.env().get_using_policy(name, lookup).is_some_and(|var| {
					matches!(
						var.value(),
						ShellValue::AssociativeArray(_) | ShellValue::Unset(ShellValueUnsetType::AssociativeArray)
					)
				}));
		if associative {
			return Ok(Some(subscript));
		}

		let index = match brush_parser::arithmetic::parse(subscript.as_str()) {
			Ok(expr) => expr.eval(context.shell),
			Err(_) => Err(EvalError::ParseError(subscript.clone())),
		};
		let error = match index {
			Ok(index) => return Ok(Some(index.to_string())),
			Err(error) => error,
		};
		writeln!(context.stderr(), "{}: {subscript}: {error}", context.command_name)?;
		if subscript.contains(['$', '`']) {
			Ok(None)
		} else {
			Err(brush_core::Error::from(error).into_fatal())
		}
	}

	/// Writes a declaration's value into `var` as the same assignment outside
	/// `declare` writes it: `declare v+=x` appends to the value `v` has,
	/// `declare a[i]+=x` appends to element `i`, and `declare a[i]=x` writes
	/// element `i`, leaving the others. Any other value replaces the
	/// variable's.
	fn assign_declared_value(
		var: &mut ShellVariable,
		element: Option<String>,
		value: ShellValueLiteral,
		append: bool,
	) -> Result<(), brush_core::Error> {
		match (element, value) {
			(Some(key), ShellValueLiteral::Scalar(value)) => var.assign_at_index(key, value, append),
			(Some(_), ShellValueLiteral::Array(_)) => Err(ErrorKind::AssigningListToArrayMember.into()),
			(None, value) => var.assign(value, append),
		}
	}

	fn declaration_to_name_and_value(
		declaration: &brush_core::CommandArg,
	) -> Result<(String, Option<String>, Option<ShellValueLiteral>, bool, bool), brush_core::Error>
	{
		let name;
		let assigned_index;
		let initial_value;
		let name_is_array;
		let append;

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

				if let Some(captures) = ARRAY_AND_INDEX_RE.captures(s)? {
					name = captures
						.get(1)
						.ok_or_else(|| {
							brush_core::ErrorKind::InternalError("declaration parse error".into())
						})?
						.as_str()
						.to_owned();

					assigned_index = captures.get(2).map(|m| m.as_str().to_owned());
					name_is_array = true;
				} else {
					name = s.clone();
					assigned_index = None;
					name_is_array = false;
				}
				initial_value = None;
				append = false;
			},
			brush_core::CommandArg::Assignment(assignment) => {
				match &assignment.name {
					ast::AssignmentName::VariableName(var_name) => {
						name = var_name.to_owned();
						assigned_index = None;
					},
					ast::AssignmentName::ArrayElementName(var_name, index) => {
						if matches!(assignment.value, ast::AssignmentValue::Array(_)) {
							return Err(ErrorKind::AssigningListToArrayMember.into());
						}

						name = var_name.to_owned();
						assigned_index = Some(index.to_owned());
					},
				}

				match &assignment.value {
					ast::AssignmentValue::Scalar(s) => {
						initial_value = Some(ShellValueLiteral::Scalar(s.value.clone()));
						name_is_array = assigned_index.is_some();
					},
					ast::AssignmentValue::Array(a) => {
						initial_value = Some(ShellValueLiteral::Array(ArrayLiteral(
							a.iter()
								.map(|(i, v)| (i.as_ref().map(|w| w.value.clone()), v.value.clone()))
								.collect(),
						)));
						name_is_array = true;
					},
				}
				append = assignment.append;
			},
		}

		Ok((name, assigned_index, initial_value, name_is_array, append))
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
