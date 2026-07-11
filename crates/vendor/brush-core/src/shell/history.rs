//! History management for shells.

use std::path::PathBuf;

use crate::{error, openfiles};

impl<SE: crate::extensions::ShellExtensions> crate::Shell<SE> {
	pub(super) fn load_history(&self) -> Result<Option<crate::history::History>, error::Error> {
		const MAX_FILE_SIZE_FOR_HISTORY_IMPORT: u64 = 1024 * 1024 * 1024; // 1 GiB

		let Some(history_path) = self.history_file_path() else {
			return Ok(None);
		};

		let mut options = std::fs::File::options();
		options.read(true);

		let mut history_file = self.open_file(&options, history_path, &self.default_exec_params())?;

		// Check on the file's size.
		if let openfiles::OpenFile::File(file) = &mut history_file {
			let file_metadata = file.metadata()?;
			let file_size = file_metadata.len();

			// If the file is empty, no reason to try reading it. Note that this will also
			// end up excluding non-regular files that report a 0 file size but appear
			// to have contents when read.
			if file_size == 0 {
				return Ok(None);
			}

			// Bail if the file is unrealistically large. For now we just refuse to import
			// it.
			if file_size > MAX_FILE_SIZE_FOR_HISTORY_IMPORT {
				return Err(error::ErrorKind::HistoryFileTooLargeToImport.into());
			}
		}

		Ok(Some(crate::history::History::import(history_file)?))
	}

	/// Returns the path to the history file used by the shell, if one is set.
	pub fn history_file_path(&self) -> Option<PathBuf> {
		self
			.env_str("HISTFILE")
			.map(|s| PathBuf::from(s.into_owned()))
	}

	/// Returns the path to the history file used by the shell, if one is set.
	pub fn history_time_format(&self) -> Option<String> {
		self.env_str("HISTTIMEFORMAT").map(|s| s.into_owned())
	}

	/// Saves history back to any backing storage.
	pub fn save_history(&mut self) -> Result<(), error::Error> {
		if let Some(history_file_path) = self.history_file_path()
			&& let Some(history) = &mut self.history
		{
			// See if there's *any* time format configured. That triggers writing out
			// timestamps.
			let write_timestamps = self.env.is_set("HISTTIMEFORMAT");

			// TODO(history): Observe options.append_to_history_file
			history.flush(
				history_file_path,
				true, /* append? */
				true, /* unsaved items only? */
				write_timestamps,
			)?;
		}

		Ok(())
	}

	/// Adds a command to history.
	pub fn add_to_history(&mut self, command: &str) -> Result<(), error::Error> {
		if let Some(history) = &mut self.history {
			// Trim.
			let command = command.trim();

			// For now, discard empty commands.
			if command.is_empty() {
				return Ok(());
			}

			// Add it to history.
			history.add(crate::history::Item {
				id:           0,
				command_line: command.to_owned(),
				timestamp:    Some(chrono::Utc::now()),
				dirty:        true,
			})?;
		}

		Ok(())
	}
}
