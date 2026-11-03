//! The text Bash prints for the command a job or one of its processes runs
//! (`make_command_string` in `print_cmd.c`), which a job listing and the
//! report of a job a signal ended show: a list on one line, with `; `,
//! ` & `, ` && ` and ` || ` between its commands, a pipeline's stages joined
//! by ` | `, `( … )` for a subshell and `{ …; }` for a group. A simple command
//! and any other compound command keep the parser's text.

use std::fmt::{self, Display, Write as _};

use brush_parser::ast;

/// The text Bash records for a `for` loop as each pass starts
/// (`print_for_command_head`): `for NAME in WORDS`, with `"$@"` for a loop
/// with no `in`.
pub(crate) struct ForHead<'a>(pub &'a ast::ForClauseCommand);

impl Display for ForHead<'_> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "for {} in ", self.0.variable_name)?;
		match &self.0.values {
			Some(values) => {
				for (index, value) in values.iter().enumerate() {
					if index > 0 {
						f.write_str(" ")?;
					}
					write!(f, "{value}")?;
				}
				Ok(())
			},
			None => f.write_str("\"$@\""),
		}
	}
}

/// The text Bash records for a `case` as it starts
/// (`print_case_command_head`): `case WORD in `.
pub(crate) struct CaseHead<'a>(pub &'a ast::CaseClauseCommand);

impl Display for CaseHead<'_> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "case {} in ", self.0.value)
	}
}

/// The text Bash records for a `[[ … ]]` as it starts
/// (`print_cond_command`).
pub(crate) struct CondCommand<'a>(pub &'a ast::ExtendedTestExprCommand);

impl Display for CondCommand<'_> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "[[ {} ]]", self.0.expr)
	}
}

/// The text Bash prints for `command`.
pub(crate) fn command(command: &ast::Command) -> String {
	let mut text = String::new();
	write_command(&mut text, command);
	text
}

/// The text Bash prints for `pipeline`.
pub(crate) fn pipeline(pipeline: &ast::Pipeline) -> String {
	let mut text = String::new();
	write_pipeline(&mut text, pipeline);
	text
}

/// The text Bash prints for `and_or`.
pub(crate) fn and_or(and_or: &ast::AndOrList) -> String {
	let mut text = String::new();
	write_and_or(&mut text, and_or);
	text
}

fn write_command(text: &mut String, command: &ast::Command) {
	match command {
		ast::Command::Compound(ast::CompoundCommand::Subshell(subshell), redirects) => {
			text.push_str("( ");
			write_list(text, &subshell.list);
			text.push_str(" )");
			write_redirects(text, redirects.as_ref());
		},
		ast::Command::Compound(ast::CompoundCommand::BraceGroup(group), redirects) => {
			text.push_str("{ ");
			write_list(text, &group.list);
			// `semicolon ()`: a group's last command ends with `;` unless it
			// already ends with a separator.
			if !text.ends_with([';', '&']) {
				text.push(';');
			}
			text.push_str(" }");
			write_redirects(text, redirects.as_ref());
		},
		other => {
			let _ = write!(text, "{other}");
		},
	}
}

fn write_redirects(text: &mut String, redirects: Option<&ast::RedirectList>) {
	for redirect in redirects.iter().flat_map(|redirects| redirects.0.iter()) {
		let _ = write!(text, " {redirect}");
	}
}

fn write_list(text: &mut String, list: &ast::CompoundList) {
	let ast::CompoundList(items) = list;
	for (index, ast::CompoundListItem(and_or, separator)) in items.iter().enumerate() {
		write_and_or(text, and_or);
		let last = index + 1 == items.len();
		match separator {
			ast::SeparatorOperator::Async if last => text.push_str(" &"),
			ast::SeparatorOperator::Async => text.push_str(" & "),
			ast::SeparatorOperator::Sequence if last => {},
			ast::SeparatorOperator::Sequence => text.push_str("; "),
		}
	}
}

fn write_and_or(text: &mut String, and_or: &ast::AndOrList) {
	write_pipeline(text, &and_or.first);
	for next in &and_or.additional {
		let (operator, pipeline) = match next {
			ast::AndOr::And(pipeline) => (" && ", pipeline),
			ast::AndOr::Or(pipeline) => (" || ", pipeline),
		};
		text.push_str(operator);
		write_pipeline(text, pipeline);
	}
}

fn write_pipeline(text: &mut String, pipeline: &ast::Pipeline) {
	if let Some(timed) = &pipeline.timed {
		let _ = write!(text, "{timed} ");
	}
	if pipeline.bang {
		text.push_str("! ");
	}
	for (index, stage) in pipeline.seq.iter().enumerate() {
		if index > 0 {
			text.push_str(" | ");
		}
		write_command(text, stage);
	}
}

#[cfg(test)]
mod tests {
	use brush_parser::ast;

	fn first_and_or(source: &str) -> ast::AndOrList {
		let mut parser = brush_parser::Parser::new(
			std::io::BufReader::new(source.as_bytes()),
			&brush_parser::ParserOptions::default(),
		);
		let program = parser.parse_program().expect("parse");
		program.complete_commands[0].0[0].0.clone()
	}

	/// The text Bash's `jobs` shows for each command, as Bash 5.2.21 prints
	/// it.
	#[test]
	fn lists_print_on_one_line_as_bash_prints_them() {
		for (source, printed) in [
			("( echo a; /bin/sh -c 'kill -KILL $$' )", "( echo a; /bin/sh -c 'kill -KILL $$' )"),
			("( echo a\necho b )", "( echo a; echo b )"),
			("{ echo a; echo b; }", "{ echo a; echo b; }"),
			("{ sleep 1 & }", "{ sleep 1 & }"),
			("( true && false || echo c )", "( true && false || echo c )"),
			("echo x | sleep 30", "echo x | sleep 30"),
			("( ( echo nested ) )", "( ( echo nested ) )"),
		] {
			assert_eq!(super::and_or(&first_and_or(source)), printed, "{source:?}");
		}
	}
}
