use crate::desktop::keys::KeyName;

/// Window input uses the receiving thread's layout; desktop input uses the
/// foreground thread.
pub(super) fn target_layout<W, L>(
	target: Option<W>,
	foreground: impl FnOnce() -> W,
	layout: impl FnOnce(W) -> Option<L>,
	fallback: impl FnOnce() -> L,
) -> L {
	layout(target.unwrap_or_else(foreground)).unwrap_or_else(fallback)
}

/// Decide whether posted keys lose modifiers using the same layout as emission.
pub(super) fn posted_keys_dropped<L: Copy>(
	keys: impl IntoIterator<Item = KeyName>,
	layout: L,
	mut implicit_modifiers: impl FnMut(KeyName, L) -> u8,
) -> Option<&'static str> {
	super::delivery::posted_modifiers_dropped(
		keys
			.into_iter()
			.map(|key| (key, implicit_modifiers(key, layout))),
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn keyboard_mapping_uses_the_receiving_windows_layout() {
		let foreground = || 1;
		let layout = |window| match window {
			1 => Some(0x040c),
			2 => Some(0x0407),
			_ => None,
		};
		let fallback = || 0x0409;
		assert_eq!(target_layout(Some(2), foreground, layout, fallback), 0x0407);
		assert_eq!(target_layout(None, foreground, layout, fallback), 0x040c);
		assert_eq!(target_layout(Some(3), foreground, layout, fallback), 0x0409);
	}

	#[test]
	fn posted_modifier_refusal_uses_the_receiving_windows_layout() {
		// VkKeyScanExW's high byte: French AZERTY needs Shift for '1',
		// en-US does not; French '&' needs none and AltGr supplies Ctrl+Alt.
		let map = |key, layout| match (key, layout) {
			(KeyName::Char('1'), 0x040c) => 1,
			(KeyName::Char('&'), 0x0409) => 1,
			(KeyName::Char('€'), 0x040c) => 6,
			_ => 0,
		};
		for (key, layout, refused) in [
			('1', 0x040c, true),
			('1', 0x0409, false),
			('&', 0x040c, false),
			('&', 0x0409, true),
			('€', 0x040c, true),
		] {
			let mut posted = Vec::new();
			let keys = [KeyName::Char(key)];
			if posted_keys_dropped(keys, layout, map).is_none() {
				posted.extend(keys);
			}
			assert_eq!(posted.is_empty(), refused, "{key} on layout {layout:#06x}");
		}
	}
}
