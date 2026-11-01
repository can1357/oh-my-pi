use std::{borrow::Cow, io::Write};

use brush_core::{
	ErrorKind, ExecutionResult, builtins,
	env::{self, EnvironmentLookup, EnvironmentScope},
	parser::ast,
	variables::{self, ShellValue, ShellValueUnsetType, ShellVariable},
};
use clap::Parser;
use itertools::Itertools;

/// Add or update exported shell variables.
#[derive(Parser)]
pub(crate) struct ExportCommand {
	/// Names are treated as function names.
	#[arg(short = 'f')]
	names_are_functions: bool,

	/// Un-export the names.
	#[arg(short = 'n')]
	unexport: bool,

	/// Display all exported names.
	#[arg(short = 'p')]
	display_exported_names: bool,

	//
	// Declarations
	//
	// N.B. These are skipped by clap, but filled in by the BuiltinDeclarationCommand trait.
	#[clap(skip)]
	declarations: Vec<brush_core::CommandArg>,
}

impl builtins::DeclarationCommand for ExportCommand {
	fn set_declarations(&mut self, declarations: Vec<brush_core::CommandArg>) {
		self.declarations = declarations;
	}
}

impl builtins::Command for ExportCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		mut context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		if self.declarations.is_empty() {
			display_all_exported_vars(&context)?;
			return Ok(ExecutionResult::success());
		}

		let mut result = ExecutionResult::success();
		for decl in &self.declarations {
			let current_result = self.process_decl(&mut context, decl)?;
			if !current_result.is_success() {
				result = current_result;
			}
		}

		Ok(result)
	}
}

impl ExportCommand {
	fn process_decl(
		&self,
		context: &mut brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		decl: &brush_core::CommandArg,
	) -> Result<ExecutionResult, brush_core::Error> {
		// With `-f` every word names a function, whatever it looks like:
		// `export -f 'v=1'` names no function and assigns nothing.
		if self.names_are_functions {
			let name = match decl {
				brush_core::CommandArg::String(s) => Cow::Borrowed(s.as_str()),
				brush_core::CommandArg::Assignment(assignment) => Cow::Owned(assignment.to_string()),
			};
			if let Some(func) = context.shell.func_mut(name.as_ref()) {
				if self.unexport {
					func.unexport();
				} else {
					func.export();
				}
				return Ok(ExecutionResult::success());
			}
			writeln!(context.stderr(), "{}: {name}: not a function", context.command_name)?;
			return Ok(ExecutionResult::general_error());
		}

		match decl {
			brush_core::CommandArg::String(s) => {
				if !env::valid_variable_name(s) {
					writeln!(context.stderr(), "{}: `{s}': not a valid identifier", context.command_name)?;
					return Ok(ExecutionResult::general_error());
				}
				// Try to find the variable already present; if we find it, then mark it
				// exported.
				else if let Some((_, variable)) = context.shell.env_mut().get_mut(s) {
					if self.unexport {
						variable.unexport();
					} else {
						variable.export();
					}
				}
				// A name with no variable yet is marked for export, so that a later
				// assignment exports it: `export v; v=1` gives children `v=1`.
				else if !self.unexport {
					let mut variable = ShellVariable::new(ShellValue::Unset(ShellValueUnsetType::Untyped));
					variable.export();
					context.shell.env_mut().add(s, variable, EnvironmentScope::Global)?;
				}
			},
			brush_core::CommandArg::Assignment(assignment) => {
				let name = match &assignment.name {
					ast::AssignmentName::VariableName(name) => name,
					ast::AssignmentName::ArrayElementName(name, index) => {
						writeln!(
							context.stderr(),
							"{}: `{name}[{index}]': not a valid identifier",
							context.command_name
						)?;
						return Ok(ExecutionResult::general_error());
					},
				};

				// A readonly variable keeps its value, and the words after this one
				// are still exported. In POSIX mode the refusal is the special
				// builtin's error, which ends the shell.
				if context
					.shell
					.env()
					.get_using_policy(name, EnvironmentLookup::Anywhere)
					.is_some_and(|var| var.is_readonly())
				{
					if context.shell.options().posix_mode {
						return Err(ErrorKind::ReadonlyVariable.into());
					}
					writeln!(context.stderr(), "{}: {name}: readonly variable", context.command_name)?;
					return Ok(ExecutionResult::general_error());
				}

				let value = match &assignment.value {
					ast::AssignmentValue::Scalar(s) => variables::ShellValueLiteral::Scalar(s.flatten()),
					ast::AssignmentValue::Array(a) => {
						variables::ShellValueLiteral::Array(variables::ArrayLiteral(
							a.iter()
								.map(|(k, v)| (k.as_ref().map(|k| k.flatten()), v.flatten()))
								.collect(),
						))
					},
				};

				let mark = |var: &mut ShellVariable| {
					if self.unexport {
						var.unexport();
					} else {
						var.export();
					}
				};

				// `export v+=x` appends to the value `v` has, as `v+=x` does.
				let env = context.shell.env_mut();
				if assignment.append
					&& let Some(var) = env.get_mut_using_policy(name, EnvironmentLookup::Anywhere)
				{
					var.assign(value, true)?;
					mark(var);
				} else {
					// Update the variable with the provided value and then mark it exported.
					env.update_or_add(
						name,
						value,
						|var| {
							mark(var);
							Ok(())
						},
						EnvironmentLookup::Anywhere,
						EnvironmentScope::Global,
					)?;
				}
			},
		}

		Ok(ExecutionResult::success())
	}
}

fn display_all_exported_vars(
	context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
) -> Result<(), brush_core::Error> {
	// Enumerate variables, sorted by key.
	for (name, variable) in context.shell.env().iter().sorted_by_key(|v| v.0) {
		if variable.is_exported() {
			let value = variable.value().try_get_cow_str(context.shell);
			if let Some(value) = value {
				writeln!(context.stdout(), "declare -x {name}=\"{value}\"")?;
			} else {
				writeln!(context.stdout(), "declare -x {name}")?;
			}
		}
	}

	Ok(())
}
