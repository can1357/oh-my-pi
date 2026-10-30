//! Prompt handling for shell instances.

use std::borrow::Cow;

use crate::{Shell, error, extensions, interp, prompt};

impl<SE: extensions::ShellExtensions> Shell<SE> {
	/// Returns the default prompt string for the shell.
	const fn default_prompt(&self) -> &'static str {
		if self.options.sh_mode {
			"$ "
		} else {
			"brush$ "
		}
	}

	/// Composes the shell's post-input, pre-command prompt, applying all
	/// appropriate expansions.
	pub async fn compose_precmd_prompt(&mut self) -> Result<String, error::Error> {
		self.expand_prompt_var("PS0", "").await
	}

	/// Composes the shell's prompt, applying all appropriate expansions.
	pub async fn compose_prompt(&mut self) -> Result<String, error::Error> {
		self.expand_prompt_var("PS1", self.default_prompt()).await
	}

	/// Composes the shell's alternate-side prompt, applying all appropriate
	/// expansions.
	pub async fn compose_alt_side_prompt(&mut self) -> Result<String, error::Error> {
		// This is a brush extension.
		self.expand_prompt_var("BRUSH_PS_ALT", "").await
	}

	/// Composes the shell's continuation prompt.
	pub async fn compose_continuation_prompt(&mut self) -> Result<String, error::Error> {
		self.expand_prompt_var("PS2", "> ").await
	}

	pub(super) async fn expand_prompt_var(
		&mut self,
		var_name: &str,
		default: &str,
	) -> Result<String, error::Error> {
		//
		// TODO(prompt): bash appears to do this in a subshell; we need to investigate
		// if that's required.
		//

		let params = self.default_exec_params();

		// Retrieve the spec. Expanding it needs the shell mutably, so it has to
		// be copied out of the variable first; for a PS1 that a variable grew
		// that copy is the first hold on the path, and it is divided above the
		// threshold like any other.
		let prompt_spec = {
			let prompt_spec = self.parameter_or_default(var_name, default);
			if prompt_spec.is_empty() {
				return Ok(String::new());
			}
			match prompt_spec {
				Cow::Owned(spec) => spec,
				Cow::Borrowed(spec) if spec.len() <= interp::DIVIDE_COPY_ABOVE_BYTES => {
					spec.to_owned()
				},
				Cow::Borrowed(spec) => interp::clone_in_strides(&params, spec).await?,
			}
		};

		// Save (and later restore) the last exit status.
		let prev_last_result = self.last_exit_status();
		let prev_last_pipeline_statuses = self.last_pipeline_statuses.clone();

		// Expand it.
		let result = prompt::expand_prompt(self, &params, prompt_spec).await;

		// Restore the last exit status.
		self.last_pipeline_statuses = prev_last_pipeline_statuses;
		self.set_last_exit_status(prev_last_result);

		// Strip out special characters that readline would typically drop:
		// \001 and \002 (start and end of non-printing sequences).
		prompt::strip_non_printing_markers(&params, result?).await
	}

	fn parameter_or_default<'a>(&'a self, name: &str, default: &'a str) -> Cow<'a, str> {
		self.env_str(name).unwrap_or_else(|| default.into())
	}
}
