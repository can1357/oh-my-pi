use std::borrow::Cow;

use brush_core::{ExecutionResult, Shell, ShellValue, builtins, variables::ShellValueUnsetType};
use clap::Parser;

/// Unset a variable.
#[derive(Parser)]
pub(crate) struct UnsetCommand {
	#[clap(flatten)]
	name_interpretation: UnsetNameInterpretation,

	/// Names of variables to unset.
	names: Vec<String>,
}

#[derive(Parser)]
#[clap(group = clap::ArgGroup::new("name-interpretation").multiple(false).required(false))]
pub(crate) struct UnsetNameInterpretation {
	/// Treat each name as a shell function.
	#[arg(short = 'f', group = "name-interpretation")]
	shell_functions: bool,

	/// Treat each name as a shell variable.
	#[arg(short = 'v', group = "name-interpretation")]
	shell_variables: bool,

	/// Treat each name as a name reference.
	#[arg(short = 'n', group = "name-interpretation")]
	name_references: bool,
}

impl UnsetNameInterpretation {
	pub const fn unspecified(&self) -> bool {
		!self.shell_functions && !self.shell_variables && !self.name_references
	}
}

impl builtins::Command for UnsetCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		if self.name_interpretation.name_references {
			for name in &self.names {
				unset_name_reference(context.shell, name)?;
			}

			return Ok(ExecutionResult::success());
		}

		let unspecified = self.name_interpretation.unspecified();

		#[expect(clippy::needless_continue)]
		for name in &self.names {
			if unspecified || self.name_interpretation.shell_variables {
				// Try to parse the name as a parameter. If we can't, don't bail; it may not be
				// a valid variable name/parameter but could still be a function name.
				if let Ok(parameter) =
					brush_parser::word::parse_parameter(name, &context.shell.parser_options())
				{
					let result = match parameter {
						brush_parser::word::Parameter::Positional(_) => continue,
						brush_parser::word::Parameter::Special(_) => continue,
						brush_parser::word::Parameter::Named(name) => {
							context.shell.env_mut().unset(name.as_str())?.is_some()
						},
						brush_parser::word::Parameter::NamedWithIndex { name, index } => {
							unset_array_index(context.shell, name.as_str(), index.as_str())?
						},
						brush_parser::word::Parameter::NamedWithAllIndices {
							name: _,
							concatenate: _,
						} => continue,
					};

					if result {
						continue;
					}
				}
			}

			// TODO(unset): Deal with readonly functions
			if unspecified || self.name_interpretation.shell_functions {
				if context.shell.undefine_func(name) {
					continue;
				}
			}
		}

		Ok(ExecutionResult::success())
	}
}
fn unset_name_reference(
	shell: &mut Shell<impl brush_core::ShellExtensions>,
	name: &str,
) -> Result<bool, brush_core::Error> {
	let Ok(brush_parser::word::Parameter::Named(name)) =
		brush_parser::word::parse_parameter(name, &shell.parser_options())
	else {
		return Ok(false);
	};

	if shell
		.env()
		.get(name.as_str())
		.is_some_and(|(_, var)| var.is_treated_as_nameref())
	{
		shell.env_mut().unset(name.as_str()).map(|v| v.is_some())
	} else {
		Ok(false)
	}
}


fn unset_array_index(
	shell: &mut Shell<impl brush_core::ShellExtensions>,
	name: &str,
	index: &str,
) -> Result<bool, brush_core::Error> {
	// First check to see if it's an associative array.
	let is_assoc_array = if let Some((_, var)) = shell.env().get(name) {
		matches!(
			var.value(),
			ShellValue::AssociativeArray(_) | ShellValue::Unset(ShellValueUnsetType::AssociativeArray)
		)
	} else {
		false
	};

	// Compute which index we should actually use. For indexed arrays, we need to
	// evaluate the index string as an arithmetic expression first.
	let index_to_use: Cow<'_, str> = if is_assoc_array {
		index.into()
	} else {
		// First evaluate the index expression.
		let index_as_expr = brush_parser::arithmetic::parse(index)?;
		let evaluated_index = shell.eval_arithmetic(&index_as_expr)?;
		evaluated_index.to_string().into()
	};

	// Now we can try to unset, and return the result.
	shell.env_mut().unset_index(name, index_to_use.as_ref())
}
