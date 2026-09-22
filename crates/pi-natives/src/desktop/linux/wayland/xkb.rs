//! Group-aware character resolution for compositor-provided XKB keymaps.
//!
//! libei sends the already-compiled textual keymap, so this module reads its
//! keycodes, types, and per-group symbol levels directly. Resolution never
//! borrows a key from another group: libei has no portable request for changing
//! the compositor's active group, and doing so implicitly would type the wrong
//! glyph when the switch failed.

use std::{
	collections::{HashMap, HashSet},
	fs::File,
	io::Read,
	os::fd::OwnedFd,
	sync::Arc,
};

use xkeysym::Keysym;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct KeyStroke {
	pub keycode:   u32,
	pub modifiers: Vec<u32>,
}

#[derive(Clone, Copy, Default)]
struct ModifierState {
	depressed: u32,
	latched:   u32,
	locked:    u32,
	group:     u32,
}

#[derive(Clone, Copy)]
struct ModifierReq {
	active_mask: u32,
	keycode:     u32,
}

#[derive(Clone)]
struct Candidate {
	keycode:  u32,
	level:    usize,
	key_type: Arc<TypeDef>,
}

#[derive(Default)]
struct TypeDef {
	mask: u32,
	maps: HashMap<u32, usize>,
}

struct ParsedKey {
	keycode: u32,
	types:   HashMap<usize, String>,
	symbols: HashMap<usize, Vec<String>>,
}

pub(super) struct KeyboardLayout {
	groups:    Vec<HashMap<char, Vec<Candidate>>>,
	us_groups: Vec<bool>,
	virtuals:  HashMap<String, u32>,
	modifiers: ModifierState,
}

impl KeyboardLayout {
	pub(super) fn from_fd(fd: OwnedFd, size: usize) -> Option<Self> {
		let mut bytes = Vec::with_capacity(size);
		File::from(fd)
			.take(size as u64)
			.read_to_end(&mut bytes)
			.ok()?;
		let text = bytes.split(|&byte| byte == 0).next().unwrap_or(&bytes);
		Self::compile(std::str::from_utf8(text).ok()?)
	}

	fn compile(source: &str) -> Option<Self> {
		let keycodes = parse_keycodes(extract_section(source, "xkb_keycodes")?);
		let symbols_section = extract_section(source, "xkb_symbols")?;
		let keys = parse_keys(symbols_section, &keycodes);
		let group_count = keys
			.iter()
			.flat_map(|key| key.symbols.keys())
			.max()
			.copied()
			.map_or(0, |group| group + 1);
		if group_count == 0 {
			return None;
		}

		let types_section = extract_section(source, "xkb_types")?;
		let virtuals = parse_virtual_modifiers(types_section);
		let types = parse_types(types_section, &virtuals);
		let names = keys
			.iter()
			.flat_map(|key| key.symbols.values().flatten().cloned())
			.collect::<HashSet<_>>();
		let keysyms = resolve_keysyms(&names);
		let mut groups = (0..group_count).map(|_| HashMap::new()).collect::<Vec<_>>();

		for key in keys {
			let Some(group_one) = key.symbols.get(&0) else {
				continue;
			};
			for (group, table) in groups.iter_mut().enumerate() {
				let symbols = key.symbols.get(&group).unwrap_or(group_one);
				let type_name = key
					.types
					.get(&group)
					.or_else(|| key.types.get(&0))
					.map_or_else(|| infer_type(symbols, &keysyms), String::as_str);
				let Some(key_type) = types.get(type_name) else {
					continue;
				};
				for (level, symbol) in symbols.iter().enumerate() {
					let Some(&character) = keysyms.get(symbol) else {
						continue;
					};
					table
						.entry(character)
						.or_insert_with(Vec::new)
						.push(Candidate {
							keycode: key.keycode.saturating_sub(8),
							level,
							key_type: Arc::clone(key_type),
						});
				}
			}
		}

		let us_groups = groups
			.iter()
			.map(|group| group_is_us(group, &virtuals))
			.collect();
		Some(Self { groups, us_groups, virtuals, modifiers: ModifierState::default() })
	}

	pub(super) const fn update_modifiers(
		&mut self,
		depressed: u32,
		latched: u32,
		locked: u32,
		group: u32,
	) {
		self.modifiers = ModifierState { depressed, latched, locked, group };
	}

	pub(super) const fn active_group(&self) -> u32 {
		self.modifiers.group
	}

	pub(super) fn can_use_us_ascii_fast_path(&self) -> bool {
		let modifiers = self.modifiers;
		modifiers.depressed == 0
			&& modifiers.latched == 0
			&& modifiers.locked == 0
			&& self
				.us_groups
				.get(modifiers.group as usize)
				.copied()
				.unwrap_or(false)
	}

	pub(super) fn resolve_char(&self, character: char) -> Option<KeyStroke> {
		let active = expand_virtual_modifiers(
			self.modifiers.depressed | self.modifiers.latched | self.modifiers.locked,
			&self.virtuals,
		);
		let holdable = holdable_modifiers(&self.virtuals);
		self
			.groups
			.get(self.modifiers.group as usize)?
			.get(&character)?
			.iter()
			.filter_map(|candidate| candidate.stroke(active, &holdable))
			.min_by_key(|stroke| stroke.modifiers.len())
	}
}

impl Candidate {
	fn stroke(&self, active: u32, holdable: &[ModifierReq]) -> Option<KeyStroke> {
		let available = holdable
			.iter()
			.copied()
			.filter(|modifier| active & modifier.active_mask == 0)
			.collect::<Vec<_>>();
		let mut best: Option<Vec<u32>> = None;
		for subset in 0..(1_u32 << available.len()) {
			let mut state = active;
			let mut keycodes = Vec::new();
			for (index, modifier) in available.iter().enumerate() {
				if subset & (1 << index) != 0 {
					state |= modifier.active_mask;
					keycodes.push(modifier.keycode);
				}
			}
			if self.key_type.level(state) == self.level
				&& best
					.as_ref()
					.is_none_or(|existing| keycodes.len() < existing.len())
			{
				best = Some(keycodes);
			}
		}
		best.map(|modifiers| KeyStroke { keycode: self.keycode, modifiers })
	}
}

impl TypeDef {
	fn level(&self, state: u32) -> usize {
		self.maps.get(&(state & self.mask)).copied().unwrap_or(0)
	}
}

fn extract_section<'a>(source: &'a str, name: &str) -> Option<&'a str> {
	let start = source.find(name)?;
	let open = start + source[start..].find('{')?;
	let close = matching_brace(source, open)?;
	Some(&source[open + 1..close])
}

fn matching_brace(source: &str, open: usize) -> Option<usize> {
	let mut depth = 0_u32;
	for (offset, byte) in source.as_bytes()[open..].iter().enumerate() {
		match byte {
			b'{' => depth += 1,
			b'}' => {
				depth = depth.checked_sub(1)?;
				if depth == 0 {
					return Some(open + offset);
				}
			},
			_ => {},
		}
	}
	None
}

fn parse_keycodes(section: &str) -> HashMap<String, u32> {
	section
		.lines()
		.filter_map(|line| {
			let line = line.trim();
			let name = line.strip_prefix('<')?.split_once('>')?.0;
			let value = line.split_once('=')?.1.trim().trim_end_matches(';').trim();
			Some((name.to_owned(), value.parse().ok()?))
		})
		.collect()
}

fn parse_keys(section: &str, keycodes: &HashMap<String, u32>) -> Vec<ParsedKey> {
	let mut keys = Vec::new();
	let mut offset = 0;
	while let Some(relative) = section[offset..].find("key <") {
		let start = offset + relative;
		let Some(name_end) = section[start + 5..].find('>') else {
			break;
		};
		let name = &section[start + 5..start + 5 + name_end];
		let Some(open_relative) = section[start..].find('{') else {
			break;
		};
		let open = start + open_relative;
		let Some(close) = matching_brace(section, open) else {
			break;
		};
		if let Some(&keycode) = keycodes.get(name) {
			let body = &section[open + 1..close];
			keys.push(ParsedKey {
				keycode,
				types: parse_group_types(body),
				symbols: parse_group_symbols(body),
			});
		}
		offset = close + 1;
	}
	keys
}

fn parse_group_types(body: &str) -> HashMap<usize, String> {
	let mut types = HashMap::new();
	let mut offset = 0;
	while let Some(relative) = body[offset..].find("type[Group") {
		let start = offset + relative + "type[Group".len();
		let Some(end) = body[start..].find(']') else {
			break;
		};
		let Some(group) = body[start..start + end]
			.parse::<usize>()
			.ok()
			.and_then(|n| n.checked_sub(1))
		else {
			break;
		};
		let remainder = &body[start + end + 1..];
		if let Some(first_quote) = remainder.find('"')
			&& let Some(second_quote) = remainder[first_quote + 1..].find('"')
		{
			types.insert(group, remainder[first_quote + 1..first_quote + 1 + second_quote].to_owned());
		}
		offset = start + end + 1;
	}
	if types.is_empty()
		&& let Some(start) = body.find("type=")
		&& let Some(first_quote) = body[start..].find('"')
		&& let Some(second_quote) = body[start + first_quote + 1..].find('"')
	{
		let value_start = start + first_quote + 1;
		types.insert(0, body[value_start..value_start + second_quote].to_owned());
	}
	types
}

fn parse_group_symbols(body: &str) -> HashMap<usize, Vec<String>> {
	let mut symbols = HashMap::new();
	let mut offset = 0;
	while let Some(relative) = body[offset..].find("symbols[Group") {
		let start = offset + relative + "symbols[Group".len();
		let Some(group_end) = body[start..].find(']') else {
			break;
		};
		let Some(group) = body[start..start + group_end]
			.parse::<usize>()
			.ok()
			.and_then(|n| n.checked_sub(1))
		else {
			break;
		};
		let remainder_start = start + group_end + 1;
		let Some(open_relative) = body[remainder_start..].find('[') else {
			break;
		};
		let open = remainder_start + open_relative;
		let Some(close_relative) = body[open + 1..].find(']') else {
			break;
		};
		let close = open + 1 + close_relative;
		symbols.insert(group, split_symbols(&body[open + 1..close]));
		offset = close + 1;
	}
	if symbols.is_empty()
		&& let Some(open) = body.find('[')
		&& let Some(close_relative) = body[open + 1..].find(']')
	{
		let close = open + 1 + close_relative;
		symbols.insert(0, split_symbols(&body[open + 1..close]));
	}
	symbols
}

fn split_symbols(list: &str) -> Vec<String> {
	list
		.split(',')
		.map(str::trim)
		.filter(|symbol| !symbol.is_empty())
		.map(str::to_owned)
		.collect()
}

fn parse_virtual_modifiers(section: &str) -> HashMap<String, u32> {
	let Some(start) = section.find("virtual_modifiers") else {
		return HashMap::new();
	};
	let list = &section[start + "virtual_modifiers".len()..];
	let Some(end) = list.find(';') else {
		return HashMap::new();
	};
	list[..end]
		.split(',')
		.map(str::trim)
		.enumerate()
		.filter_map(|(index, name)| {
			let bit = 1_u32.checked_shl(index as u32 + 8)?;
			Some((name.to_owned(), bit))
		})
		.collect()
}

fn parse_types(section: &str, virtuals: &HashMap<String, u32>) -> HashMap<String, Arc<TypeDef>> {
	let mut types = HashMap::new();
	let mut offset = 0;
	while let Some(relative) = section[offset..].find("type \"") {
		let start = offset + relative + "type \"".len();
		let Some(name_end) = section[start..].find('"') else {
			break;
		};
		let name = section[start..start + name_end].to_owned();
		let Some(open_relative) = section[start + name_end..].find('{') else {
			break;
		};
		let open = start + name_end + open_relative;
		let Some(close) = matching_brace(section, open) else {
			break;
		};
		let mut definition = TypeDef::default();
		for line in section[open + 1..close].lines().map(str::trim) {
			if let Some(modifiers) = line.strip_prefix("modifiers=") {
				definition.mask =
					parse_modifier_mask(modifiers.trim().trim_end_matches(';'), virtuals).unwrap_or(0);
				continue;
			}
			let Some(map) = line.strip_prefix("map[") else {
				continue;
			};
			let Some((combination, level)) = map.split_once("]=") else {
				continue;
			};
			let Some(mask) = parse_modifier_mask(combination, virtuals) else {
				continue;
			};
			let Some(level) = level.trim().trim_end_matches(';').parse::<usize>().ok() else {
				continue;
			};
			definition.maps.insert(mask, level.saturating_sub(1));
		}
		types.insert(name, Arc::new(definition));
		offset = close + 1;
	}
	types
}

fn parse_modifier_mask(value: &str, virtuals: &HashMap<String, u32>) -> Option<u32> {
	if value == "none" {
		return Some(0);
	}
	value
		.split('+')
		.map(str::trim)
		.try_fold(0, |mask, name| Some(mask | modifier_bit(name, virtuals)?))
}

fn modifier_bit(name: &str, virtuals: &HashMap<String, u32>) -> Option<u32> {
	let bit = match name {
		"Shift" => 1 << 0,
		"Lock" => 1 << 1,
		"Control" => 1 << 2,
		"Mod1" => 1 << 3,
		"Mod2" => 1 << 4,
		"Mod3" => 1 << 5,
		"Mod4" => 1 << 6,
		"Mod5" => 1 << 7,
		virtual_name => *virtuals.get(virtual_name)?,
	};
	Some(bit)
}

fn holdable_modifiers(virtuals: &HashMap<String, u32>) -> Vec<ModifierReq> {
	[
		("Shift", 1 << 0, 42),
		("Control", 1 << 2, 29),
		("Alt", 1 << 3, 56),
		("Meta", 1 << 6, 125),
		("LevelThree", 1 << 7, 100),
	]
	.into_iter()
	.map(|(virtual_name, real_mask, keycode)| ModifierReq {
		active_mask: virtuals
			.get(virtual_name)
			.copied()
			.map_or(real_mask, |bit| real_mask | bit),
		keycode,
	})
	.collect()
}

fn expand_virtual_modifiers(mut state: u32, virtuals: &HashMap<String, u32>) -> u32 {
	for (real_bit, names) in [
		(1 << 3, &["Alt"][..]),
		(1 << 4, &["NumLock"][..]),
		(1 << 5, &["LevelFive"][..]),
		(1 << 6, &["Meta", "Super", "Hyper"][..]),
		(1 << 7, &["LevelThree"][..]),
	] {
		if state & real_bit != 0 {
			for name in names {
				state |= virtuals.get(*name).copied().unwrap_or(0);
			}
		}
	}
	state
}

fn infer_type(symbols: &[String], keysyms: &HashMap<String, char>) -> &'static str {
	let alphabetic = symbols.len() >= 2
		&& keysyms
			.get(&symbols[0])
			.zip(keysyms.get(&symbols[1]))
			.is_some_and(|(&lower, &upper)| {
				lower.is_lowercase() && upper == lower.to_uppercase().next().unwrap_or(lower)
			});
	match (symbols.len(), alphabetic) {
		(0 | 1, _) => "ONE_LEVEL",
		(2, true) => "ALPHABETIC",
		(2, false) => "TWO_LEVEL",
		(_, true) => "FOUR_LEVEL_ALPHABETIC",
		(_, false) => "FOUR_LEVEL",
	}
}

fn resolve_keysyms(names: &HashSet<String>) -> HashMap<String, char> {
	let mut resolved = HashMap::new();
	for name in names {
		let direct = name
			.strip_prefix('U')
			.and_then(|hex| u32::from_str_radix(hex, 16).ok())
			.and_then(char::from_u32)
			.or_else(|| {
				name
					.strip_prefix("0x")
					.and_then(|hex| u32::from_str_radix(hex, 16).ok())
					.and_then(|raw| Keysym::new(raw).key_char())
			});
		if let Some(character) = direct {
			resolved.insert(name.clone(), character);
		}
	}
	for raw in 0x20..=0xffff {
		let keysym = Keysym::new(raw);
		if let Some(debug_name) = keysym.name()
			&& let Some(name) = debug_name.strip_prefix("XK_")
			&& names.contains(name)
			&& let Some(character) = keysym.key_char()
		{
			resolved.insert(name.to_owned(), character);
		}
	}
	resolved
}

fn group_is_us(table: &HashMap<char, Vec<Candidate>>, virtuals: &HashMap<String, u32>) -> bool {
	const ROWS: &[(u32, &str, &str)] = &[
		(2, "1234567890-=", "!@#$%^&*()_+"),
		(16, "qwertyuiop[]", "QWERTYUIOP{}"),
		(30, "asdfghjkl;'`", "ASDFGHJKL:\"~"),
		(43, "\\", "|"),
		(44, "zxcvbnm,./", "ZXCVBNM<>?"),
	];
	ROWS.iter().all(|&(first, base, shifted)| {
		base
			.chars()
			.zip(shifted.chars())
			.enumerate()
			.all(|(offset, (base, shifted))| {
				let keycode = first + offset as u32;
				has_candidate(table, base, keycode, &[], virtuals)
					&& has_candidate(table, shifted, keycode, &[42], virtuals)
			})
	})
}

fn has_candidate(
	table: &HashMap<char, Vec<Candidate>>,
	character: char,
	keycode: u32,
	modifiers: &[u32],
	virtuals: &HashMap<String, u32>,
) -> bool {
	let holdable = holdable_modifiers(virtuals);
	table.get(&character).is_some_and(|candidates| {
		candidates.iter().any(|candidate| {
			candidate.keycode == keycode
				&& candidate
					.stroke(0, &holdable)
					.is_some_and(|stroke| stroke.modifiers == modifiers)
		})
	})
}

#[cfg(test)]
mod tests {
	use super::{KeyStroke, KeyboardLayout};

	const FR: &str = include_str!("testdata/fr.xkb");
	const US_FR: &str = include_str!("testdata/us-fr.xkb");

	fn stroke(keycode: u32, modifiers: &[u32]) -> KeyStroke {
		KeyStroke { keycode, modifiers: modifiers.to_vec() }
	}

	#[test]
	fn resolves_french_levels_and_altgr() {
		let layout = KeyboardLayout::compile(FR).expect("French fixture must compile");
		assert_eq!(layout.resolve_char('a'), Some(stroke(16, &[])));
		assert_eq!(layout.resolve_char('A'), Some(stroke(16, &[42])));
		assert_eq!(layout.resolve_char('é'), Some(stroke(3, &[])));
		assert_eq!(layout.resolve_char('1'), Some(stroke(2, &[42])));
		assert_eq!(layout.resolve_char('#'), Some(stroke(4, &[100])));
	}

	#[test]
	fn resolves_only_the_active_group_in_a_multi_layout_keymap() {
		let mut layout = KeyboardLayout::compile(US_FR).expect("US/French fixture must compile");
		assert_eq!(layout.resolve_char('a'), Some(stroke(30, &[])));
		assert_eq!(layout.resolve_char('q'), Some(stroke(16, &[])));
		assert_eq!(layout.resolve_char('é'), None);
		layout.update_modifiers(0, 0, 0, 1);
		assert_eq!(layout.resolve_char('a'), Some(stroke(16, &[])));
		assert_eq!(layout.resolve_char('é'), Some(stroke(3, &[])));
	}

	#[test]
	fn modifier_event_group_change_updates_resolution() {
		let mut layout = KeyboardLayout::compile(US_FR).expect("US/French fixture must compile");
		assert_eq!(layout.resolve_char('a'), Some(stroke(30, &[])));
		layout.update_modifiers(0, 0, 0, 1);
		assert_eq!(layout.active_group(), 1);
		assert_eq!(layout.resolve_char('a'), Some(stroke(16, &[])));
	}

	#[test]
	fn serialized_modifier_fields_affect_resolution() {
		let mut layout = KeyboardLayout::compile(US_FR).expect("US/French fixture must compile");
		let shift = 1;
		layout.update_modifiers(shift, 0, 0, 0);
		assert_eq!(layout.resolve_char('A'), Some(stroke(30, &[])));
		layout.update_modifiers(0, shift, 0, 0);
		assert_eq!(layout.resolve_char('A'), Some(stroke(30, &[])));
		layout.update_modifiers(0, 0, shift, 0);
		assert_eq!(layout.resolve_char('A'), Some(stroke(30, &[])));
	}

	#[test]
	fn num_lock_does_not_change_non_keypad_levels() {
		let mut layout = KeyboardLayout::compile(FR).expect("French fixture must compile");
		layout.update_modifiers(0, 0, 1 << 4, 0);

		assert_eq!(layout.resolve_char('a'), Some(stroke(16, &[])));
		assert_eq!(layout.resolve_char('1'), Some(stroke(2, &[42])));
	}

	#[test]
	fn caps_lock_uses_the_alphabetic_type_map() {
		let mut layout = KeyboardLayout::compile(FR).expect("French fixture must compile");
		layout.update_modifiers(0, 0, 1 << 1, 0);

		assert_eq!(layout.resolve_char('a'), Some(stroke(16, &[42])));
		assert_eq!(layout.resolve_char('A'), Some(stroke(16, &[])));
		assert_eq!(layout.resolve_char('é'), Some(stroke(3, &[])));
	}
}
