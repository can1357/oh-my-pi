//! Environment-fed atomic theme updates for interactive surfaces.

use std::sync::Arc;

use arc_swap::ArcSwapOption;
use flume::Receiver;
use omp_tui::{Appearance, JsonTheme, Theme};
use parking_lot::Mutex;
use thiserror::Error;

/// One successfully parsed theme revision.
#[derive(Clone)]
pub struct ThemeRevision {
	/// Monotonic Environment catalog revision.
	pub revision: u64,
	/// Immutable parsed theme.
	pub theme:    Arc<JsonTheme>,
}

/// Rejection of an Environment theme update.
#[derive(Debug, Error)]
pub enum ThemeWatchError {
	/// A stale or duplicate revision was delivered.
	#[error("theme update revision is not newer than the active revision")]
	StaleRevision,
	/// Theme parsing failed before publication.
	#[error(transparent)]
	Theme(#[from] omp_tui::ThemeError),
}

struct WatchState {
	revision:    u64,
	subscribers: Vec<flume::Sender<ThemeRevision>>,
}

/// Atomically publishes validated theme revisions supplied by Environment.
///
/// The watcher never reads the filesystem. Environment ownership supplies the
/// source bytes and revision; UI readers load an immutable snapshot without a
/// lock and repaint only after a successful publication.
pub struct ThemeWatcher {
	active: ArcSwapOption<ThemeRevision>,
	state:  Mutex<WatchState>,
}

impl ThemeWatcher {
	/// Creates an empty watcher.
	pub fn new() -> Self {
		Self {
			active: ArcSwapOption::empty(),
			state:  Mutex::new(WatchState { revision: 0, subscribers: Vec::new() }),
		}
	}

	/// Clears the active custom theme at a newer revision.
	pub fn clear(&self, revision: u64) -> Result<(), ThemeWatchError> {
		let mut state = self.state.lock();
		if revision <= state.revision {
			return Err(ThemeWatchError::StaleRevision);
		}
		self.active.store(None);
		state.revision = revision;
		tracing::debug!(revision, "custom theme cleared");
		Ok(())
	}

	/// Parses and atomically publishes one Environment-authored update.
	pub fn apply_environment_update(
		&self,
		revision: u64,
		source: &str,
	) -> Result<ThemeRevision, ThemeWatchError> {
		let parsed = Arc::new(JsonTheme::parse(source)?);
		let mut state = self.state.lock();
		if revision <= state.revision {
			return Err(ThemeWatchError::StaleRevision);
		}
		let update = ThemeRevision { revision, theme: parsed };
		self.active.store(Some(Arc::new(update.clone())));
		state.revision = revision;
		state
			.subscribers
			.retain(|subscriber| subscriber.try_send(update.clone()).is_ok());
		tracing::debug!(
			revision,
			subscriber_count = state.subscribers.len(),
			"custom theme revision published"
		);
		Ok(update)
	}

	/// Loads the active immutable revision without locking.
	pub fn current(&self) -> Option<Arc<ThemeRevision>> {
		self.active.load_full()
	}

	/// Resolves the active semantic palette for an appearance and color mode.
	pub fn palette(&self, appearance: Appearance, truecolor: bool) -> Option<Theme> {
		let active = self.active.load_full()?;
		Some(if truecolor {
			active.theme.for_appearance(appearance)
		} else {
			active.theme.for_appearance_256(appearance)
		})
	}

	/// Subscribes to future successful publications.
	pub fn subscribe(&self) -> Receiver<ThemeRevision> {
		let (tx, rx) = flume::bounded(1);
		if let Some(active) = self.active.load_full() {
			let _ = tx.try_send((*active).clone());
		}
		self.state.lock().subscribers.push(tx);
		rx
	}
}

impl Default for ThemeWatcher {
	fn default() -> Self {
		Self::new()
	}
}

#[cfg(test)]
mod tests {
	use omp_tui::{Appearance, Color};

	use super::{ThemeWatchError, ThemeWatcher};

	#[test]
	fn publishes_only_valid_newer_revisions_atomically() {
		let watcher = ThemeWatcher::new();
		let updates = watcher.subscribe();
		watcher
			.apply_environment_update(4, r##"{"name":"hot","dark":{"accent":"#12ab34"}}"##)
			.expect("publish");
		let update = updates.recv().expect("subscriber");
		assert_eq!(update.revision, 4);
		assert_eq!(
			watcher
				.palette(Appearance::Dark, true)
				.map(|theme| theme.accent),
			Some(Color::Rgb(0x12, 0xab, 0x34))
		);
		assert!(matches!(
			watcher.apply_environment_update(4, r##"{"name":"stale","dark":{}}"##),
			Err(ThemeWatchError::StaleRevision)
		));
		assert_eq!(watcher.current().map(|active| active.revision), Some(4));
		watcher.clear(5).expect("clear custom theme");
		assert!(watcher.current().is_none());
		assert!(matches!(watcher.clear(5), Err(ThemeWatchError::StaleRevision)));
	}
}
