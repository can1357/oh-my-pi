//! Command completion support for shell instances.

use crate::{completion, error, extensions};

impl<SE: extensions::ShellExtensions> crate::Shell<SE> {
	/// Generates command completions for the shell.
	///
	/// # Arguments
	///
	/// * `input` - The input string to generate completions for.
	/// * `position` - The position in the input string to generate completions
	///   at.
	pub async fn complete(
		&mut self,
		input: &str,
		position: usize,
	) -> Result<completion::Completions, error::Error> {
		let completion_config = self.completion_config.clone();
		completion_config
			.get_completions(self, input, position)
			.await
	}
}
