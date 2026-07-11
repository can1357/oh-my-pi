//! Call stack representations.

use std::{
	borrow::Cow,
	collections::{HashSet, VecDeque},
	sync::Arc,
};

use brush_parser::ast::SourceLocation;

use crate::{functions, traps};

/// Encapsulates info regarding a script call.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct ScriptCall {
	/// The type of script call.
	pub call_type:   ScriptCallType,
	/// The source info for the script called.
	pub source_info: crate::SourceInfo,
}

impl ScriptCall {
	/// Returns the name of the script that was called.
	pub fn name(&self) -> Cow<'_, str> {
		self.source_info.source.as_str().into()
	}
}

/// The type of script call.
#[derive(Clone, Copy, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum ScriptCallType {
	/// A script was sourced.
	Source,
	/// A script was executed.
	Run,
}

impl std::fmt::Display for ScriptCall {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self.call_type {
			ScriptCallType::Source => write!(f, "source({})", self.source_info),
			ScriptCallType::Run => write!(f, "script({})", self.source_info),
		}
	}
}

/// Represents the type of a frame, indicating how it was invoked from
/// a different source context.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum FrameType {
	/// A script was called (sourced or executed).
	Script(ScriptCall),
	/// A function was called.
	Function(FunctionCall),
	/// A trap handler was invoked.
	TrapHandler(traps::TrapSignal),
	/// A string was eval'd.
	Eval,
	/// A command-line string (i.e., -c) was executed.
	CommandString,
	/// An interactive command session was started.
	InteractiveSession,
}

impl FrameType {
	/// Returns a name for the frame (i.e., script path or function name).
	pub fn name(&self) -> Cow<'_, str> {
		match self {
			Self::Script(call) => call.name(),
			Self::Function(call) => call.name(),
			Self::TrapHandler(_) => "trap".into(),
			Self::Eval => "eval".into(),
			Self::CommandString => "-c".into(),
			Self::InteractiveSession => "interactive".into(),
		}
	}

	/// Returns `true` if the frame is for a function call.
	pub const fn is_function(&self) -> bool {
		matches!(self, Self::Function(..))
	}

	/// Returns `true` if the frame is for a script call.
	pub const fn is_script(&self) -> bool {
		matches!(self, Self::Script(..))
	}

	/// Returns `true` if the frame is for a trap handler.
	pub const fn is_trap_handler(&self) -> bool {
		matches!(self, Self::TrapHandler(_))
	}

	/// Returns `true` if the frame is for an interactive session.
	pub const fn is_interactive_session(&self) -> bool {
		matches!(self, Self::InteractiveSession)
	}

	/// Returns `true` if the frame is for a command string being executed.
	pub const fn is_command_string(&self) -> bool {
		matches!(self, Self::CommandString)
	}

	/// Returns `true` if the frame is for a sourced script.
	pub const fn is_sourced_script(&self) -> bool {
		matches!(self, Self::Script(call) if matches!(call.call_type, ScriptCallType::Source))
	}

	/// Returns `true` if the frame is for a run script.
	pub const fn is_run_script(&self) -> bool {
		matches!(self, Self::Script(call) if matches!(call.call_type, ScriptCallType::Run))
	}
}

impl std::fmt::Display for FrameType {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Script(call) => call.fmt(f),
			Self::Function(call) => call.fmt(f),
			Self::TrapHandler(_) => write!(f, "trap"),
			Self::Eval => write!(f, "eval"),
			Self::CommandString => write!(f, "-c"),
			Self::InteractiveSession => write!(f, "interactive"),
		}
	}
}

/// Describes the target of a function call.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct FunctionCall {
	/// The name of the function invoked.
	pub function_name: String,
	/// The invoked function.
	pub function:      functions::Registration,
}

impl FunctionCall {
	/// Returns the name of the function that was called.
	pub fn name(&self) -> Cow<'_, str> {
		self.function_name.as_str().into()
	}
}

impl std::fmt::Display for FunctionCall {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "func({})", self.function_name)
	}
}

/// Represents a single frame in a `CallStack`.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Frame {
	/// The type of frame.
	pub frame_type:          FrameType,
	/// The source information for the frame. The locations associated with AST
	/// nodes executed in this frame should be interpreted as being relative to
	/// this source info.
	pub source_info:         crate::SourceInfo,
	/// The location of the entry point into this frame, within the frame of
	/// reference of `source_info`. May be `None` if the entry point is not
	/// known.
	pub entry:               Option<Arc<crate::SourcePosition>>,
	/// Information about the currently executing location. For the topmost frame
	/// on the stack, this represents the current execution location. For older
	/// frames, this represents the site from which a control transfer was made
	/// to the next younger frame. May be `None` if the current location is not
	/// known. When present, it is relative to the frame of reference of
	/// `source_info`.
	pub current:             Option<Arc<crate::SourcePosition>>,
	/// Positional arguments (not including $0). May not be present for all
	/// frames.
	pub args:                Vec<String>,
	/// Optionally, indicates an additional line offset within the current source
	/// context.
	pub current_line_offset: usize,
}

impl Frame {
	/// Returns the adjusted source info for this frame, combining the
	/// frame's `source_info` and `current_line_offset`, if present.
	pub fn adjusted_source_info(&self) -> crate::SourceInfo {
		self.pos_as_source_info(None)
	}

	/// Returns the current position as a new `SourceInfo`, combining the
	/// frame's `source_info` and `current` position.
	pub fn current_pos_as_source_info(&self) -> crate::SourceInfo {
		self.pos_as_source_info(self.current.as_ref())
	}

	fn pos_as_source_info(&self, pos: Option<&Arc<crate::SourcePosition>>) -> crate::SourceInfo {
		let mut new_start = if let Some(existing_start) = &self.source_info.start {
			if let Some(current) = pos {
				Some(Arc::new(crate::SourcePosition {
					index:  existing_start.index + current.index,
					line:   existing_start.line + (current.line - 1),
					column: if current.line <= 1 {
						existing_start.column + (current.column - 1)
					} else {
						current.column
					},
				}))
			} else {
				Some(existing_start.clone())
			}
		} else {
			pos.cloned()
		};

		if self.current_line_offset > 0 {
			new_start = if let Some(new_start) = new_start {
				let mut pos = (*new_start).clone();
				pos.line += self.current_line_offset;

				Some(Arc::new(pos))
			} else {
				Some(Arc::new(crate::SourcePosition {
					index:  0,
					line:   self.current_line_offset + 1,
					column: 1,
				}))
			};
		}

		crate::SourceInfo { source: self.source_info.source.clone(), start: new_start }
	}

	/// Returns the current line number.
	pub fn current_line(&self) -> Option<usize> {
		let start_line = self.source_info.start.as_ref().map_or(1, |pos| pos.line);
		let current_line = self.current.as_ref().map(|pos| pos.line)?;

		Some(start_line.saturating_sub(1) + current_line + self.current_line_offset)
	}

	/// Returns the current line number, relative to the frame's entry.
	pub fn current_frame_relative_line(&self) -> Option<usize> {
		let current_line = self.current.as_ref().map(|pos| pos.line)?;
		let entry_line = self.entry.as_ref().map_or(1, |pos| pos.line);

		Some(current_line.saturating_sub(entry_line) + self.current_line_offset + 1)
	}
}

/// Options for formatting a call stack.
#[derive(Default)]
pub struct FormatOptions {
	/// Whether or not to show args.
	pub show_args:         bool,
	/// Whether or not to show frame entry points.
	pub show_entry_points: bool,
}

/// Helper struct for formatting a call stack with custom options.
///
/// This struct implements `Display` and can be used to write a formatted
/// call stack to any type that implements `io::Write`.
pub struct FormatCallStack<'a> {
	stack:   &'a CallStack,
	options: &'a FormatOptions,
}

impl<'a> FormatCallStack<'a> {
	/// Creates a new formatter for the given call stack with the specified
	/// options.
	///
	/// # Arguments
	///
	/// * `stack` - The call stack to format.
	/// * `options` - The formatting options to use.
	pub const fn new(stack: &'a CallStack, options: &'a FormatOptions) -> Self {
		Self { stack, options }
	}
}

impl std::fmt::Display for FormatCallStack<'_> {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		self.stack.fmt_with_options(f, self.options)
	}
}

/// Encapsulates a script call stack.
#[derive(Clone, Debug, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct CallStack {
	frames: VecDeque<Frame>,
	func_call_depth: usize,
	script_source_depth: usize,
	active_trap_signals: HashSet<traps::TrapSignal>,
	trap_delivery_suppress_count: usize,
}

impl CallStack {
	/// Creates a formatter for this call stack with the given options.
	///
	/// # Arguments
	///
	/// * `options` - The formatting options to use.
	pub const fn format<'a>(&'a self, options: &'a FormatOptions) -> FormatCallStack<'a> {
		FormatCallStack::new(self, options)
	}

	/// Formats the call stack with the given options.
	///
	/// # Arguments
	///
	/// * `f` - The formatter to write to.
	/// * `options` - The formatting options.
	fn fmt_with_options(
		&self,
		f: &mut std::fmt::Formatter<'_>,
		options: &FormatOptions,
	) -> std::fmt::Result {
		if self.is_empty() {
			return Ok(());
		}

		color_print::cwriteln!(f, "<underline>Call stack (most recent first):</underline>")?;

		for (index, frame) in self.iter().enumerate() {
			let si = frame.current_pos_as_source_info();

			color_print::cwrite!(
				f,
				"   <dim>#{index}</dim><yellow>|</yellow> <strong>{}</strong>",
				si.source
			)?;

			if let Some(pos) = &si.start {
				color_print::cwrite!(f, ":<cyan>{}</cyan>,<cyan>{}</cyan>", pos.line, pos.column)?;
			}

			color_print::cwrite!(f, " (<dim>{}</dim>", frame.frame_type)?;

			if options.show_entry_points {
				if let Some(entry) = &frame.entry {
					let entry_si = frame.pos_as_source_info(Some(entry));
					if let Some(entry_start) = &entry_si.start {
						color_print::cwrite!(
							f,
							" <dim>entered at {}:{}</dim>",
							entry_si.source,
							entry_start
						)?;
					}
				}
			}

			color_print::cwriteln!(f, ")")?;

			if !frame.args.is_empty() && options.show_args {
				for (i, arg) in frame.args.iter().enumerate() {
					color_print::cwriteln!(f, "     <yellow>${}</yellow>: <blue>{}</blue>", i + 1, arg)?;
				}
			}
		}

		Ok(())
	}
}

impl std::fmt::Display for CallStack {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		self.fmt_with_options(f, &FormatOptions::default())
	}
}

impl std::ops::Index<usize> for CallStack {
	type Output = Frame;

	fn index(&self, index: usize) -> &Self::Output {
		&self.frames[index]
	}
}

impl CallStack {
	/// Creates a new empty script call stack.
	pub fn new() -> Self {
		Self::default()
	}

	/// Removes the top from from the stack. If the stack is empty, does nothing
	/// and returns `None`; otherwise, returns the removed call frame.
	pub fn pop(&mut self) -> Option<Frame> {
		let frame = self.frames.pop_front()?;

		if frame.frame_type.is_function() {
			self.func_call_depth = self.func_call_depth.saturating_sub(1);
		}

		if frame.frame_type.is_sourced_script() {
			self.script_source_depth = self.script_source_depth.saturating_sub(1);
		}

		if let FrameType::TrapHandler(signal) = &frame.frame_type {
			self.active_trap_signals.remove(signal);
		}

		Some(frame)
	}

	/// Returns a reference to the current (topmost) call frame in the stack.
	/// Returns `None` if the stack is empty.
	pub fn current_frame(&self) -> Option<&Frame> {
		self.frames.front()
	}

	/// Returns the position in the current (topmost) call frame in the stack,
	/// expressed as a new `SourceInfo`. Note that this may not be identical
	/// to that frame's `SourceInfo` since it may include an offset representing
	/// the current execution position within that source.
	pub fn current_pos_as_source_info(&self) -> crate::SourceInfo {
		let Some(frame) = self.frames.front() else {
			return crate::SourceInfo::default();
		};

		frame.current_pos_as_source_info()
	}

	/// Updates the currently executing position in the top stack frame.
	pub fn set_current_pos(&mut self, position: Option<Arc<crate::SourcePosition>>) {
		if let Some(frame) = self.frames.front_mut() {
			frame.current = position;
		}
	}

	/// Increments the current line offset in the top stack frame by the given
	/// delta.
	///
	/// # Arguments
	///
	/// * `delta` - The number of lines to increment the current line offset by.
	pub(crate) fn increment_current_line_offset(&mut self, delta: usize) {
		let Some(frame) = self.frames.front_mut() else {
			return;
		};

		frame.current_line_offset += delta;
	}

	/// Pushes a new script call frame onto the stack.
	///
	/// # Arguments
	///
	/// * `call_type` - The type of script call (sourced or executed).
	/// * `source_info` - The source of the script.
	/// * `args` - The positional arguments for the script call.
	pub fn push_script(
		&mut self,
		call_type: ScriptCallType,
		source_info: &crate::SourceInfo,
		args: impl IntoIterator<Item = String>,
	) {
		self.frames.push_front(Frame {
			frame_type:          FrameType::Script(ScriptCall {
				call_type,
				source_info: source_info.to_owned(),
			}),
			args:                args.into_iter().collect(),
			source_info:         source_info.to_owned(),
			current_line_offset: 0,
			current:             None, // TODO(source-info): fill this out
			entry:               None, // TODO(source-info): fill this out
		});

		if matches!(call_type, ScriptCallType::Source) {
			self.script_source_depth += 1;
		}
	}

	/// Pushes a new trap handler frame onto the stack.
	///
	/// # Arguments
	///
	/// * `signal` - The signal being handled.
	/// * `handler` - The trap handler being invoked, if any.
	pub fn push_trap_handler(
		&mut self,
		signal: traps::TrapSignal,
		handler: Option<&traps::TrapHandler>,
	) {
		let source_info = handler.map_or_else(crate::SourceInfo::default, |h| h.source_info.clone());

		self.frames.push_front(Frame {
			frame_type: FrameType::TrapHandler(signal),
			args: vec![],
			source_info,
			current_line_offset: 0,
			current: None, // TODO(source-info): fill this out
			entry: None,   // TODO(source-info): fill this out
		});

		self.active_trap_signals.insert(signal);
	}

	/// Pushes a new eval frame onto the stack.
	pub fn push_eval(&mut self) {
		self.frames.push_front(Frame {
			frame_type:          FrameType::Eval,
			args:                vec![],
			source_info:         crate::SourceInfo::from("eval"), // TODO(source-info): fill this out
			current_line_offset: 0,
			current:             None, // TODO(source-info): fill this out
			entry:               None, // TODO(source-info): fill this out
		});
	}

	/// Pushes a new command string frame onto the stack.
	pub fn push_command_string(&mut self) {
		self.frames.push_front(Frame {
			frame_type:          FrameType::CommandString,
			args:                vec![],
			source_info:         crate::SourceInfo::from("environment"),
			current_line_offset: 0,
			current:             None, // TODO(source-info): fill this out
			entry:               None, // TODO(source-info): fill this out
		});
	}

	/// Pushes a new interactive session frame onto the stack.
	pub fn push_interactive_session(&mut self) {
		self.frames.push_front(Frame {
			frame_type:          FrameType::InteractiveSession,
			args:                vec![],
			current_line_offset: 0,
			source_info:         crate::SourceInfo::from("main"),
			current:             None, // TODO(source-info): fill this out
			entry:               None, // TODO(source-info): fill this out
		});
	}

	/// Pushes a new function call frame onto the stack.
	///
	/// # Arguments
	///
	/// * `name` - The name of the function being called.
	/// * `function` - The function being called.
	/// * `args` - The positional arguments for the function call.
	pub fn push_function(
		&mut self,
		name: impl Into<String>,
		function: &functions::Registration,
		args: impl IntoIterator<Item = String>,
	) {
		self.frames.push_front(Frame {
			frame_type:          FrameType::Function(FunctionCall {
				function_name: name.into(),
				function:      function.to_owned(),
			}),
			args:                args.into_iter().collect(),
			source_info:         function.source().clone(),
			entry:               function.definition().location().map(|span| span.start),
			current:             None, // TODO(source-info): fill this out
			current_line_offset: 0,
		});

		self.func_call_depth += 1;
	}

	/// Iterates through the function calls on the stack.
	pub fn iter_function_calls(&self) -> impl Iterator<Item = &FunctionCall> {
		self.iter().filter_map(|frame| {
			if let FrameType::Function(call) = &frame.frame_type {
				Some(call)
			} else {
				None
			}
		})
	}

	/// Iterates through the script calls on the stack.
	pub fn iter_script_calls(&self) -> impl Iterator<Item = &ScriptCall> {
		self.iter().filter_map(|frame| {
			if let FrameType::Script(call) = &frame.frame_type {
				Some(call)
			} else {
				None
			}
		})
	}

	/// Returns whether or not the current script stack frame is a sourced
	/// script.
	pub fn in_sourced_script(&self) -> bool {
		self
			.iter_script_calls()
			.next()
			.is_some_and(|call| matches!(call.call_type, ScriptCallType::Source))
	}

	/// Returns the current depth of function calls in the call stack.
	pub const fn function_call_depth(&self) -> usize {
		self.func_call_depth
	}

	/// Returns the current depth of sourced script calls in the call stack.
	pub const fn script_source_depth(&self) -> usize {
		self.script_source_depth
	}

	/// Returns whether the given trap signal is currently being handled
	/// (i.e., there is an active frame on the stack for this signal).
	pub fn is_trap_signal_active(&self, signal: traps::TrapSignal) -> bool {
		self.active_trap_signals.contains(&signal)
	}

	/// Clears the set of active trap signals. This should be called when
	/// creating subshells so they start with fresh trap execution state
	/// independent of the parent shell's currently-executing traps.
	pub fn clear_active_trap_signals(&mut self) {
		self.active_trap_signals.clear();
	}

	/// Returns whether the given trap signal is currently suppressed.
	pub const fn is_trap_delivery_suppressed(&self) -> bool {
		self.trap_delivery_suppress_count > 0
	}

	/// Acquires a block on trap delivery, preventing traps from being delivered
	/// until the block is released. Multiple blocks may be acquired, and trap
	/// delivery will remain suppressed until all blocks have been released.
	pub const fn acquire_trap_delivery_block(&mut self) {
		self.trap_delivery_suppress_count += 1;
	}

	/// Releases a block on trap delivery; note that trap delivery will remain
	/// suppressed until all blocks have been released.
	pub const fn release_trap_delivery_block(&mut self) {
		self.trap_delivery_suppress_count = self.trap_delivery_suppress_count.saturating_sub(1);
	}

	/// Returns whether or not the shell is actively executing in a shell
	/// function.
	pub fn in_function(&self) -> bool {
		self.iter_function_calls().next().is_some()
	}

	/// Returns the current depth of the call stack.
	pub fn depth(&self) -> usize {
		self.frames.len()
	}

	/// Returns whether or not the call stack is empty.
	pub fn is_empty(&self) -> bool {
		self.frames.is_empty()
	}

	/// Returns an iterator over the call frames, starting from the most
	/// recent.
	pub fn iter(&self) -> impl Iterator<Item = &Frame> {
		self.frames.iter()
	}

	/// Returns a mutable iterator over the call frames, starting from the most
	/// recent.
	pub fn iter_mut(&mut self) -> impl Iterator<Item = &mut Frame> {
		self.frames.iter_mut()
	}
}

#[cfg(test)]
mod tests {
	use std::path::PathBuf;

	use pretty_assertions::assert_matches;

	use super::*;
	use crate::SourceInfo;

	#[test]
	fn test_call_stack_new() {
		let stack = CallStack::new();
		assert!(stack.is_empty());
		assert_eq!(stack.depth(), 0);
	}

	#[test]
	fn test_call_stack_default() {
		let stack = CallStack::default();
		assert!(stack.is_empty());
		assert_eq!(stack.depth(), 0);
	}

	#[test]
	fn test_call_stack_push_pop() {
		let mut stack = CallStack::new();

		stack.push_script(
			ScriptCallType::Source,
			&SourceInfo::from(PathBuf::from("script1.sh")),
			vec![],
		);
		assert!(!stack.is_empty());
		assert_eq!(stack.depth(), 1);

		stack.push_script(
			ScriptCallType::Run,
			&SourceInfo::from(PathBuf::from("script2.sh")),
			vec![],
		);
		assert_eq!(stack.depth(), 2);

		let frame = stack.pop().unwrap();
		assert_matches!(
			 frame.frame_type,
			 FrameType::Script(ScriptCall {
				  call_type: ScriptCallType::Run,
				  source_info: SourceInfo {
						source: file_path,
						..
				  },
			 }) if &file_path == "script2.sh"
		);
		assert_eq!(stack.depth(), 1);

		let frame = stack.pop().unwrap();
		assert_matches!(
			 frame.frame_type,
			 FrameType::Script(ScriptCall {
				  call_type: ScriptCallType::Source,
				  source_info: SourceInfo {
						source: file_path,
						..
				  },
			 }) if &file_path == "script1.sh"
		);
		assert_eq!(stack.depth(), 0);
		assert!(stack.is_empty());
	}

	#[test]
	fn test_call_stack_pop_empty() {
		let mut stack = CallStack::new();
		assert!(stack.pop().is_none());
	}

	#[test]
	fn test_in_sourced_script() {
		let mut stack = CallStack::new();
		assert!(!stack.in_sourced_script());

		stack.push_script(
			ScriptCallType::Run,
			&SourceInfo::from(PathBuf::from("script1.sh")),
			vec![],
		);
		assert!(!stack.in_sourced_script());

		stack.push_script(
			ScriptCallType::Source,
			&SourceInfo::from(PathBuf::from("script2.sh")),
			vec![],
		);
		assert!(stack.in_sourced_script());

		stack.pop();
		assert!(!stack.in_sourced_script());
	}

	#[test]
	fn test_call_stack_iter() {
		let mut stack = CallStack::new();
		stack.push_script(
			ScriptCallType::Source,
			&SourceInfo::from(PathBuf::from("script1.sh")),
			vec![],
		);
		stack.push_script(
			ScriptCallType::Run,
			&SourceInfo::from(PathBuf::from("script2.sh")),
			vec![],
		);
		stack.push_script(
			ScriptCallType::Source,
			&SourceInfo::from(PathBuf::from("script3.sh")),
			vec![],
		);

		let frames: Vec<_> = stack.iter().collect();
		assert_eq!(frames.len(), 3);
		assert_matches!(&frames[0].frame_type, FrameType::Script(ScriptCall { source_info: SourceInfo { source: file_path, .. }, .. }) if file_path == "script3.sh");
		assert_matches!(&frames[1].frame_type, FrameType::Script(ScriptCall { source_info: SourceInfo { source: file_path, .. }, .. }) if file_path == "script2.sh");
		assert_matches!(&frames[2].frame_type, FrameType::Script(ScriptCall { source_info: SourceInfo { source: file_path, .. }, .. }) if file_path == "script1.sh");
	}
}
