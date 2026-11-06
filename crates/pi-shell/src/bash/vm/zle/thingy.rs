//! Thingies and widgets (zsh 5.9 `zle_thingy.c`): the names widgets are
//! known by and what each name runs.
//!
//! A thingy is a name; it names at most one widget, and several names may
//! name the same widget (`zle -A`). Every builtin widget is named twice:
//! by its canonical name and, immortal, by the same name with a leading
//! dot. Names that are bound in a keymap without naming a widget need no
//! entry here (zsh keeps disabled thingies for its reference counts; a
//! name without an entry behaves the same).

use std::collections::BTreeMap;

use bstr::{BString, ByteSlice};

use super::widgets;

/// What a widget runs.
#[derive(Clone, Debug)]
pub enum Kind {
	/// A builtin widget: its index in [`widgets::BUILTINS`].
	Builtin(u16),
	/// An internal widget a module added (zsh `addzlefunction`:
	/// zsh/deltochar's `delete-to-char`, …).
	Native(super::exec::WidgetFn),
	/// A user widget (`zle -N name func`): the shell function.
	User(BString),
	/// A completion widget (`zle -C name base func`): the builtin
	/// completion widget it behaves like and the completion function.
	Comp {
		/// The builtin widget named (`complete-word`, …), as given.
		base: BString,
		/// The completion function.
		func: BString,
	},
}

/// A widget (zsh `struct widget`).
#[derive(Clone, Debug)]
pub struct Widget {
	/// [`super::wflags`].
	pub flags: u32,
	/// What it runs.
	pub kind:  Kind,
}

/// A name's entry (zsh `struct thingy` of an enabled thingy).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Thingy {
	/// The widget's id in [`Widgets::defs`].
	widget:   u32,
	/// zsh `TH_IMMORTAL`: the name cannot be rebound or deleted.
	immortal: bool,
}

/// The thingy table (zsh `thingytab`) and the widgets it names.
#[derive(Clone, Debug)]
pub struct Widgets {
	/// Enabled thingies by name (zsh scans them sorted).
	names: BTreeMap<BString, Thingy>,
	/// Widgets by id; `None` once no name refers to one.
	defs:  Vec<Option<Widget>>,
}

/// Why a name could not be (re)bound or deleted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BindError {
	/// zsh `TH_IMMORTAL`: ``widget name `x' is protected``.
	Protected,
	/// ``no such widget `x'``.
	NoSuch,
}

impl Default for Widgets {
	/// zsh `init_thingies` + the builtin widgets (`zle_things.h`), each
	/// under its name and its immortal dotted name.
	fn default() -> Self {
		let mut w = Self { names: BTreeMap::new(), defs: Vec::new() };
		for (i, b) in widgets::BUILTINS.iter().enumerate() {
			let id = w.alloc(Widget {
				flags: super::wflags::INT | b.flags,
				kind:  Kind::Builtin(u16::try_from(i).unwrap_or(u16::MAX)),
			});
			let mut dotted = BString::from(".");
			dotted.extend_from_slice(b.name.as_bytes());
			w.names
				.insert(dotted, Thingy { widget: id, immortal: true });
			w.names
				.insert(BString::from(b.name), Thingy { widget: id, immortal: false });
		}
		w
	}
}

impl Widgets {
	fn alloc(&mut self, widget: Widget) -> u32 {
		if let Some(i) = self.defs.iter().position(Option::is_none) {
			self.defs[i] = Some(widget);
			return u32::try_from(i).unwrap_or(u32::MAX);
		}
		self.defs.push(Some(widget));
		u32::try_from(self.defs.len() - 1).unwrap_or(u32::MAX)
	}

	/// The widget `name` names (zsh `t->widget` of an enabled thingy).
	pub fn get(&self, name: &[u8]) -> Option<&Widget> {
		let t = self.names.get(name.as_bstr())?;
		self.defs.get(t.widget as usize)?.as_ref()
	}

	/// The widget `name` names, for a flag change (`zle -f`).
	pub fn get_mut(&mut self, name: &[u8]) -> Option<&mut Widget> {
		let t = *self.names.get(name.as_bstr())?;
		self.defs.get_mut(t.widget as usize)?.as_mut()
	}

	/// Whether `name` is the immortal name of a builtin widget.
	pub fn immortal(&self, name: &[u8]) -> bool {
		self.names.get(name.as_bstr()).is_some_and(|t| t.immortal)
	}

	/// zsh `bindwidget(w, rthingy(name))` for a new widget.
	///
	/// # Errors
	/// [`BindError::Protected`] for an immortal name.
	pub fn define(&mut self, name: &[u8], widget: Widget) -> Result<(), BindError> {
		if self.immortal(name) {
			return Err(BindError::Protected);
		}
		self.unbind(name);
		let id = self.alloc(widget);
		self
			.names
			.insert(BString::from(name), Thingy { widget: id, immortal: false });
		Ok(())
	}

	/// zsh `bin_zle_link`: `new` names the widget `old` names.
	///
	/// # Errors
	/// [`BindError::NoSuch`] when `old` names no widget,
	/// [`BindError::Protected`] when `new` is immortal.
	pub fn link(&mut self, old: &[u8], new: &[u8]) -> Result<(), BindError> {
		let t = *self.names.get(old.as_bstr()).ok_or(BindError::NoSuch)?;
		if let Some(n) = self.names.get(new.as_bstr()) {
			if n.widget == t.widget {
				return Ok(());
			}
			if n.immortal {
				return Err(BindError::Protected);
			}
		}
		self.unbind(new);
		self
			.names
			.insert(BString::from(new), Thingy { widget: t.widget, immortal: false });
		Ok(())
	}

	/// zsh `unbindwidget(t, 0)` for `zle -D`.
	///
	/// # Errors
	/// [`BindError::NoSuch`] when `name` names nothing,
	/// [`BindError::Protected`] for an immortal name.
	pub fn delete(&mut self, name: &[u8]) -> Result<(), BindError> {
		match self.names.get(name.as_bstr()) {
			None => Err(BindError::NoSuch),
			Some(t) if t.immortal => Err(BindError::Protected),
			Some(_) => {
				self.unbind(name);
				Ok(())
			},
		}
	}

	/// Drop `name`'s entry, freeing its widget when no other name refers
	/// to it.
	fn unbind(&mut self, name: &[u8]) {
		let Some(t) = self.names.remove(name.as_bstr()) else {
			return;
		};
		if !self.names.values().any(|o| o.widget == t.widget)
			&& let Some(slot) = self.defs.get_mut(t.widget as usize)
		{
			*slot = None;
		}
	}

	/// The names that name widgets, sorted as zsh scans them, with their
	/// widget.
	pub fn iter(&self) -> impl Iterator<Item = (&BString, &Widget)> {
		self.names.iter().filter_map(|(n, t)| {
			self
				.defs
				.get(t.widget as usize)
				.and_then(Option::as_ref)
				.map(|w| (n, w))
		})
	}

	/// Whether `name` names a widget.
	pub fn exists(&self, name: &[u8]) -> bool {
		self.get(name).is_some()
	}

	/// zsh `addzlefunction`: `widget` named `.name` (immortal) and `name`;
	/// `false` when the dotted name is taken by an immortal widget.
	pub fn add_internal(&mut self, name: &[u8], widget: Widget) -> bool {
		let mut dotted = BString::from(".");
		dotted.extend_from_slice(name);
		if self.immortal(&dotted) {
			return false;
		}
		let id = self.alloc(widget);
		self.unbind(&dotted);
		self
			.names
			.insert(dotted, Thingy { widget: id, immortal: true });
		self.unbind(name);
		self
			.names
			.insert(BString::from(name), Thingy { widget: id, immortal: false });
		true
	}

	/// zsh `deletezlefunction` of one name, immortal or not.
	pub fn remove_internal(&mut self, name: &[u8]) {
		self.unbind(name);
	}
}
