//! Facilities for tracking and persisting shell command history.

use std::{
	io::{BufRead, Read, Write},
	path::Path,
};

use chrono::Utc;

use crate::error;

/// Unique identifier for a history item.
pub type ItemId = i64;

/// Timestamp attached to a history item.
pub type ItemTimestamp = chrono::DateTime<Utc>;

/// A command recorded in shell history.
#[derive(Clone, Default)]
pub struct Item {
	/// Stable identifier assigned when the item is added.
	pub id:           ItemId,
	/// Command line as entered.
	pub command_line: String,
	/// Time at which the command was recorded.
	pub timestamp:    Option<ItemTimestamp>,
	/// Whether the item has not yet been written to persistent history.
	pub dirty:        bool,
}

impl Item {
	/// Creates a dirty history item for `command_line` with the current
	/// timestamp.
	pub fn new(command_line: impl Into<String>) -> Self {
		Self {
			id:           0,
			command_line: command_line.into(),
			timestamp:    Some(Utc::now()),
			dirty:        true,
		}
	}
}

/// In-memory command history with stable item identifiers.
#[derive(Clone, Default)]
pub struct History {
	items:   Vec<Item>,
	next_id: ItemId,
}

impl History {
	/// Imports newline-delimited history, recognizing Bash timestamp comments.
	pub fn import(reader: impl Read) -> Result<Self, error::Error> {
		let mut history = Self::default();
		let mut next_timestamp = None;
		for line in std::io::BufReader::new(reader).lines() {
			let line = match line {
				Ok(line) => line,
				Err(err) if err.kind() == std::io::ErrorKind::InvalidData => {
					tracing::warn!(error = %err, "unreadable shell history line");
					continue;
				},
				Err(err) => return Err(err.into()),
			};
			if let Some(comment) = line.strip_prefix('#') {
				next_timestamp = comment
					.trim()
					.parse::<i64>()
					.ok()
					.and_then(|seconds| ItemTimestamp::from_timestamp(seconds, 0));
				continue;
			}
			let mut item = Item::new(line);
			item.timestamp = next_timestamp.take();
			item.dirty = false;
			history.add(item)?;
		}
		Ok(history)
	}

	/// Returns an item by stable identifier.
	pub fn get_by_id(&self, id: ItemId) -> Result<Option<&Item>, error::Error> {
		Ok(self.items.iter().find(|item| item.id == id))
	}

	/// Replaces an item while preserving its position in the history.
	pub fn update_by_id(&mut self, id: ItemId, item: Item) -> Result<(), error::Error> {
		let existing = self
			.items
			.iter_mut()
			.find(|item| item.id == id)
			.ok_or(error::ErrorKind::HistoryItemNotFound)?;
		*existing = item;
		Ok(())
	}

	/// Removes the zero-based nth item, returning whether it existed.
	pub fn remove_nth_item(&mut self, n: usize) -> bool {
		if n < self.items.len() {
			self.items.remove(n);
			true
		} else {
			false
		}
	}

	/// Adds an item and returns its assigned stable identifier.
	pub fn add(&mut self, mut item: Item) -> Result<ItemId, error::Error> {
		let id = self.next_id;
		self.next_id = self
			.next_id
			.checked_add(1)
			.ok_or_else(|| error::ErrorKind::InternalError("history identifier overflow".into()))?;
		item.id = id;
		self.items.push(item);
		Ok(id)
	}

	/// Deletes an item by stable identifier.
	pub fn delete_item_by_id(&mut self, id: ItemId) -> Result<(), error::Error> {
		self.items.retain(|item| item.id != id);
		Ok(())
	}

	/// Clears all recorded commands.
	pub fn clear(&mut self) -> Result<(), error::Error> {
		self.items.clear();
		Ok(())
	}

	/// Writes history to `history_file_path`.
	pub fn flush(
		&mut self,
		history_file_path: impl AsRef<Path>,
		append: bool,
		unsaved_items_only: bool,
		write_timestamps: bool,
	) -> Result<(), error::Error> {
		let mut options = std::fs::File::options();
		if append {
			options.append(true);
		} else {
			options.write(true).truncate(true);
		}
		let mut file = options.create(true).open(history_file_path)?;
		for item in &mut self.items {
			if unsaved_items_only && !item.dirty {
				continue;
			}
			if write_timestamps && let Some(timestamp) = item.timestamp {
				writeln!(file, "#{}", timestamp.timestamp())?;
			}
			writeln!(file, "{}", item.command_line)?;
			if unsaved_items_only {
				item.dirty = false;
			}
		}
		file.flush()?;
		Ok(())
	}

	/// Searches history according to `query`.
	pub fn search(&self, query: Query) -> Result<Search<'_>, error::Error> {
		Ok(Search::new(self, query))
	}

	/// Iterates from oldest to newest.
	pub fn iter(&self) -> impl Iterator<Item = &Item> {
		self.items.iter()
	}

	/// Returns the zero-based nth item.
	pub fn get(&self, index: usize) -> Option<&Item> {
		self.items.get(index)
	}

	/// Returns the number of recorded items.
	pub fn count(&self) -> usize {
		self.items.len()
	}
}

/// Search direction for command history.
#[derive(Default)]
pub enum Direction {
	/// Search from oldest to newest.
	#[default]
	Forward,
	/// Search from newest to oldest.
	Backward,
}

/// String predicate for a command line.
pub enum CommandLineFilter {
	/// Command starts with the string.
	Prefix(String),
	/// Command ends with the string.
	Suffix(String),
	/// Command contains the string.
	Contains(String),
	/// Command exactly equals the string.
	Exact(String),
}

/// Parameters controlling a history search.
#[derive(Default)]
pub struct Query {
	/// Search direction.
	pub direction:             Direction,
	/// Exclude timestamps at or before this value.
	pub not_at_or_before_time: Option<ItemTimestamp>,
	/// Exclude timestamps at or after this value.
	pub not_at_or_after_time:  Option<ItemTimestamp>,
	/// Exclude identifiers at or before this value.
	pub not_at_or_before_id:   Option<ItemId>,
	/// Exclude identifiers at or after this value.
	pub not_at_or_after_id:    Option<ItemId>,
	/// Maximum number of matching items.
	pub max_items:             Option<i64>,
	/// Optional command-line predicate.
	pub command_line_filter:   Option<CommandLineFilter>,
}

impl Query {
	fn includes(&self, item: &Item) -> bool {
		if self
			.not_at_or_before_time
			.is_some_and(|value| item.timestamp.is_some_and(|ts| ts <= value))
			|| self
				.not_at_or_after_time
				.is_some_and(|value| item.timestamp.is_some_and(|ts| ts >= value))
			|| self
				.not_at_or_before_id
				.is_some_and(|value| item.id <= value)
			|| self
				.not_at_or_after_id
				.is_some_and(|value| item.id >= value)
		{
			return false;
		}
		match &self.command_line_filter {
			Some(CommandLineFilter::Prefix(value)) => item.command_line.starts_with(value),
			Some(CommandLineFilter::Suffix(value)) => item.command_line.ends_with(value),
			Some(CommandLineFilter::Contains(value)) => item.command_line.contains(value),
			Some(CommandLineFilter::Exact(value)) => item.command_line == *value,
			None => true,
		}
	}
}

/// Iterator over history items matching a [`Query`].
pub struct Search<'a> {
	history: &'a History,
	query:   Query,
	next:    Option<usize>,
	matched: usize,
}

impl<'a> Search<'a> {
	/// Creates a search matching every history item.
	pub fn all(history: &'a History) -> Self {
		Self::new(history, Query::default())
	}

	/// Creates a search using `query`.
	pub fn new(history: &'a History, query: Query) -> Self {
		let next = match query.direction {
			Direction::Forward => (!history.items.is_empty()).then_some(0),
			Direction::Backward => history.items.len().checked_sub(1),
		};
		Self { history, query, next, matched: 0 }
	}
}

impl<'a> Iterator for Search<'a> {
	type Item = &'a Item;

	fn next(&mut self) -> Option<Self::Item> {
		loop {
			let index = self.next?;
			self.next = match self.query.direction {
				Direction::Forward => (index + 1 < self.history.items.len()).then_some(index + 1),
				Direction::Backward => index.checked_sub(1),
			};
			if self
				.query
				.max_items
				.is_some_and(|max| max <= self.matched as i64)
			{
				return None;
			}
			let item = &self.history.items[index];
			if self.query.includes(item) {
				self.matched += 1;
				return Some(item);
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn imported_timestamp_and_dirty_state_round_trip() {
		let history = History::import("#123\necho one\necho two\n".as_bytes()).unwrap();
		assert_eq!(history.count(), 2);
		assert_eq!(history.get(0).unwrap().timestamp.unwrap().timestamp(), 123);
		assert!(!history.get(0).unwrap().dirty);
	}

	#[test]
	fn stable_ids_survive_removal() {
		let mut history = History::default();
		let first = history.add(Item::new("one")).unwrap();
		let second = history.add(Item::new("two")).unwrap();
		assert!(history.remove_nth_item(0));
		assert!(history.get_by_id(first).unwrap().is_none());
		assert_eq!(history.get_by_id(second).unwrap().unwrap().command_line, "two");
	}
}
