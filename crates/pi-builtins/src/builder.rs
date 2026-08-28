use crate::BuiltinSet;

/// Extension trait that simplifies adding default builtins to a shell builder.
pub trait ShellBuilderExt {
	/// Add default builtins to the shell being built.
	///
	/// # Arguments
	///
	/// * `set` - The well-known set of built-ins to add.
	#[must_use]
	fn default_builtins(self, set: BuiltinSet) -> Self;
}

impl<SE: brush_core::extensions::ShellExtensions, S: brush_core::ShellBuilderState> ShellBuilderExt
	for brush_core::ShellBuilder<SE, S>
{
	fn default_builtins(self, set: BuiltinSet) -> Self {
		self.builtins(crate::default_builtins(set))
	}
}
