use super::{Codec, Entry, codec_allowed};
use crate::bash::Shell;

// Add built-in consumers here when their implementation is present. Reserving
// an allocation does not imply this build can interpret its payload.
pub(crate) const BUILT_IN: &[&dyn Codec] = &[
	#[cfg(all(test, debug_assertions))]
	&crate::bash::vm::TEST_VOCABULARY_CODEC,
];

pub(crate) fn find(entry: &Entry) -> Option<&'static dyn Codec> {
	BUILT_IN.iter().copied().find(|codec| {
		let definition = codec.definition();
		codec_allowed(definition.id)
			&& definition.id == entry.id
			&& definition.revision == entry.revision
	})
}

pub(crate) fn capture(shell: &Shell, entries: &mut Vec<Entry>) -> Result<(), postcard::Error> {
	for codec in BUILT_IN {
		let definition = codec.definition();
		if !codec_allowed(definition.id) {
			return Err(postcard::Error::SerdeSerCustom);
		}
		let start = entries.len();
		codec.capture(shell, entries)?;
		if entries[start..]
			.iter()
			.any(|entry| !definition.matches(entry))
		{
			return Err(postcard::Error::SerdeSerCustom);
		}
	}
	Ok(())
}
