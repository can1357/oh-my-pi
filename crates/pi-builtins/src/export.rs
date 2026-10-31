use std::io::Write;

use brush_core::{
	ExecutionExitCode, ExecutionResult, builtins,
	env::{EnvironmentLookup, EnvironmentScope},
	parser::ast,
	variables,
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
			let current_result = self.process_decl(&mut context, decl).await?;
			if !current_result.is_success() {
				result = current_result;
			}
		}

		Ok(result)
	}
}

impl ExportCommand {
	async fn process_decl(
		&self,
		context: &mut brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		decl: &brush_core::CommandArg,
	) -> Result<ExecutionResult, brush_core::Error> {
		match decl {
			brush_core::CommandArg::String(s) => {
				// See if this is supposed to be a function name.
				if self.names_are_functions {
					// Try to find the function already present; if we find it, then mark it
					// exported.
					if let Some(func) = context.shell.func_mut(s) {
						if self.unexport {
							func.unexport();
						} else {
							func.export();
						}
					} else {
						writeln!(context.stderr(), "{s}: not a function")?;
						return Ok(ExecutionExitCode::InvalidUsage.into());
					}
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
			},
			brush_core::CommandArg::Assignment(assignment) => {
				let name = match &assignment.name {
					ast::AssignmentName::VariableName(name) => name,
					ast::AssignmentName::ArrayElementName(..) => {
						writeln!(context.stderr(), "not a valid variable name")?;
						return Ok(ExecutionExitCode::InvalidUsage.into());
					},
				};

				// What the variable written makes of the value: where an indexed
				// literal counts its subscripts from — an empty array, since the
				// assignment below replaces the value; an associative array's
				// are keys — and whether it has the integer attribute, which
				// makes its values arithmetic (`declare -i g; export g=3*3` is
				// `9`).
				let (start, integer) =
					match context.shell.env().get_using_policy(name, EnvironmentLookup::Anywhere) {
						Some(var) => (
							var.takes_indexes().then(|| var.indexed_literal_start(false)),
							var.is_treated_as_integer(),
						),
						None => (Some(0), false),
					};

				// `Word::flatten` is a clone of the whole word, and
				// `export BIG="$big"` lets the caller size it: the copy that
				// feeds the divided write has to be divided as well, or the
				// hold simply moves one line earlier.
				let value = match &assignment.value {
					ast::AssignmentValue::Scalar(s) => {
						let value = brush_core::clone_in_strides(&context.params, s.as_ref()).await?;
						variables::ShellValueLiteral::Scalar(if integer {
							variables::integer_value(context.shell, value).await?
						} else {
							value
						})
					},
					ast::AssignmentValue::Array(a) => {
						let (literal, keyed) =
							variables::ArrayLiteral::from_assignment_elements(a, &context.params).await?;
						let literal = if keyed || integer {
							literal.evaluate_elements(context.shell, &context.params, start, integer).await?
						} else {
							literal
						};
						variables::ShellValueLiteral::Array(literal)
					},
				};

				// Update the variable with the provided value and then mark it exported.
				context
					.shell
					.env_mut()
					.update_or_add(
						name,
						value,
						|var| {
							if self.unexport {
								var.unexport();
							} else {
								var.export();
							}
							Ok(())
						},
						EnvironmentLookup::Anywhere,
						EnvironmentScope::Global,
						&context.params,
					)
					.await?;
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
