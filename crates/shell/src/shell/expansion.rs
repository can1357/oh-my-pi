//! Expansion support for shell instances.

use std::borrow::Cow;

use crate::{Shell, error, expansion, extensions, interp::ExecutionParameters};

impl<SE: extensions::ShellExtensions> Shell<SE> {
	/// Returns the current value of the IFS variable, or the default value if it
	/// is not set.
	pub fn ifs(&self) -> Cow<'_, str> {
		self.env_str("IFS").unwrap_or_else(|| " \t\n".into())
	}

	/// Returns the first character of `IFS`, a space if it is unset, or `None`
	/// when it is set to an empty string.
	pub(crate) fn get_ifs_first_char(&self) -> Option<char> {
		self
			.env_str("IFS")
			.map_or(Some(' '), |ifs| ifs.chars().next())
	}

	/// Applies basic shell expansion to the provided string.
	///
	/// # Arguments
	///
	/// * `s` - The string to expand.
	pub async fn basic_expand_string<S: AsRef<str>>(
		&mut self,
		params: &ExecutionParameters,
		s: S,
	) -> Result<String, error::Error> {
		let result = expansion::basic_expand_word(self, params, s.as_ref()).await?;
		Ok(result)
	}

	/// Applies full shell expansion and field splitting to the provided string;
	/// returns a sequence of fields.
	///
	/// # Arguments
	///
	/// * `s` - The string to expand and split.
	pub async fn full_expand_and_split_string<S: AsRef<str>>(
		&mut self,
		params: &ExecutionParameters,
		s: S,
	) -> Result<Vec<String>, error::Error> {
		let result = expansion::full_expand_and_split_word(self, params, s.as_ref()).await?;
		Ok(result)
	}
}
