//! Readline edit buffer support for shell instances.

use crate::{error, extensions, variables::ShellVariable};

impl<SE: extensions::ShellExtensions> crate::Shell<SE> {
	/// Updates the shell state to reflect the given edit buffer contents.
	///
	/// # Arguments
	///
	/// * `contents` - The contents of the edit buffer.
	/// * `cursor` - The cursor position in the edit buffer.
	pub fn set_edit_buffer(&mut self, contents: String, cursor: usize) -> Result<(), error::Error> {
		self
			.env
			.set_global("READLINE_LINE", ShellVariable::new(contents))?;

		self
			.env
			.set_global("READLINE_POINT", ShellVariable::new(cursor.to_string()))?;

		Ok(())
	}

	/// Returns the contents of the shell's edit buffer, if any. The buffer
	/// state is cleared from the shell.
	pub fn pop_edit_buffer(&mut self) -> Result<Option<(String, usize)>, error::Error> {
		let line = self
			.env
			.unset("READLINE_LINE")?
			.map(|line| line.value().to_cow_str(self).to_string());

		let point = self
			.env
			.unset("READLINE_POINT")?
			.and_then(|point| point.value().to_cow_str(self).parse::<usize>().ok())
			.unwrap_or(0);

		if let Some(line) = line {
			Ok(Some((line, point)))
		} else {
			Ok(None)
		}
	}
}
