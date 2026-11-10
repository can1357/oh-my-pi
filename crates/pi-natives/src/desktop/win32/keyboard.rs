/// Window input uses the receiving thread's layout; desktop input uses the foreground thread.
pub(super) fn target_layout<W, L>(
	target: Option<W>,
	foreground: impl FnOnce() -> W,
	layout: impl FnOnce(W) -> L,
) -> L {
	layout(target.unwrap_or_else(foreground))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn keyboard_mapping_uses_the_receiving_windows_layout() {
		let foreground = || 1;
		let layout = |window| if window == 2 { "de-DE" } else { "en-US" };
		let map_y = |layout| if layout == "de-DE" { (0x59, 0x2c) } else { (0x59, 0x15) };
		assert_eq!(map_y(target_layout(Some(2), foreground, layout)), (0x59, 0x2c));
		assert_eq!(map_y(target_layout(None, foreground, layout)), (0x59, 0x15));
	}
}
