//! Choosing an option of a combo box without opening its list.
//!
//! Pressing a GTK 3 or Qt combo box (`press`; `Press` or `ShowMenu`) opens its
//! list as a popup that grabs the keyboard until it closes, so a user typing
//! in another window loses their keys to it. A closed GTK 3 combo box
//! publishes its options as the items of a `Menu` child, and Chromium a
//! `<select>`'s as the items of a `Menu` child; performing an item's own
//! action (`click`, `select`) chooses it with no popup. Qt publishes its
//! options as the rows of a `List` child, but their only action (`Toggle`)
//! selects the row in the hidden list without choosing it.

use std::fmt::Write as _;

use super::*;
use crate::desktop::control;

/// The option actions that choose the option: GTK 3's `click`, Chromium's
/// `select`.
const CHOOSE_ACTIONS: [&str; 2] = ["click", "select"];
/// The most options read of one combo box: the count comes from the app.
const OPTION_LIMIT: usize = 2048;
/// The most options an error lists.
const LISTED_OPTIONS: usize = 50;
/// How far below the combo box options sit: in its list, or in a group of
/// options in that list.
const OPTION_DEPTH: usize = 3;
/// How long a chosen option has to show as the combo box's choice.
#[cfg(not(test))]
const CHOICE_WAIT: Duration = Duration::from_millis(500);
#[cfg(test)]
const CHOICE_WAIT: Duration = Duration::ZERO;
const POLL_INTERVAL: Duration = Duration::from_millis(25);

fn failure(message: impl std::fmt::Display) -> DesktopError {
	DesktopError::ax_failed(format!("AT-SPI combo box: {message}"))
}

/// Whether a combo box's action `name` opens its list: GTK 3's `press`, Qt's
/// `Press` and `ShowMenu`. Chromium's `open` takes no keyboard grab.
pub(super) const fn opens_grabbing_list(name: &str) -> bool {
	name.eq_ignore_ascii_case("press") || name.eq_ignore_ascii_case("showmenu")
}

/// One option of a combo box and its title.
struct ComboOption {
	object: ObjectRefOwned,
	title:  String,
}

/// A combo box's options and the object publishing which one is chosen.
struct Options {
	options: Vec<ComboOption>,
	/// The combo box itself (GTK 3) or its list (Chromium), whichever has the
	/// `Selection` interface; `None` when neither does (Qt).
	chosen:  Option<ObjectRefOwned>,
}

/// Why a requested value chooses no option.
#[derive(Debug, PartialEq, Eq)]
enum Refusal {
	/// No option is titled exactly the value.
	Missing,
	/// Several options share the title, so the value cannot say which.
	Ambiguous,
}

/// The index of the option titled exactly `requested`, as macOS chooses a
/// popup button's option: options are the app's own strings, the refusal
/// lists them, and untitled items (Chromium's empty first `<option>`) are not
/// options.
fn choose_option<'a>(
	titles: impl Iterator<Item = &'a str>,
	requested: &str,
) -> Result<usize, Refusal> {
	let mut matches = titles
		.enumerate()
		.filter(|(_, title)| !title.is_empty() && *title == requested)
		.map(|(index, _)| index);
	match (matches.next(), matches.next()) {
		(Some(index), None) => Ok(index),
		(Some(_), Some(_)) => Err(Refusal::Ambiguous),
		(None, _) => Err(Refusal::Missing),
	}
}

/// The titled options, quoted, in list order, up to [`LISTED_OPTIONS`].
fn option_list(options: &[ComboOption]) -> String {
	let titled: Vec<_> = options
		.iter()
		.filter(|option| !option.title.is_empty())
		.collect();
	let mut list = titled
		.iter()
		.take(LISTED_OPTIONS)
		.map(|option| format!("\"{}\"", option.title))
		.collect::<Vec<_>>()
		.join(", ");
	if titled.len() > LISTED_OPTIONS {
		let _ = write!(list, " and {} more", titled.len() - LISTED_OPTIONS);
	}
	list
}

/// The index of the action among `names` that chooses an option.
fn choose_action<'a>(mut names: impl Iterator<Item = &'a str>) -> Option<usize> {
	names.position(|name| {
		CHOOSE_ACTIONS
			.iter()
			.any(|choose| name.eq_ignore_ascii_case(choose))
	})
}

const fn option_role(role: Role) -> bool {
	matches!(role, Role::MenuItem | Role::CheckMenuItem | Role::RadioMenuItem | Role::ListItem)
}

/// A list of options, or a group of options inside one.
const fn list_role(role: Role) -> bool {
	matches!(
		role,
		Role::Menu | Role::PopupMenu | Role::List | Role::ListBox | Role::Grouping | Role::Panel
	)
}

async fn has_interface(
	proxy: &AccessibleProxy<'_>,
	interface: atspi::Interface,
) -> CoreResult<bool> {
	proxy
		.get_interfaces()
		.await
		.map(|interfaces| interfaces.contains(interface))
		.map_err(failure)
}

/// The refusal of a combo box whose options no accessibility action chooses.
fn no_route(options: &[ComboOption]) -> DesktopError {
	failure(format!(
		"its options cannot be chosen through accessibility without opening its list (Qt selects a \
		 row of the hidden list without choosing it); nothing was chosen. Clicking it opens the \
		 same list, which holds the keyboard until an option is clicked or it closes, so that step \
		 needs the user's screen. Options: {}",
		option_list(options)
	))
}

impl AtSpiAx {
	/// The options of `combo`: the items of its list child, or its own item
	/// children, and of groups inside that list. An item with children (a
	/// submenu or an option group) is not an option.
	async fn combo_options(&self, combo: &ObjectRefOwned) -> CoreResult<Options> {
		let proxy = combo
			.as_accessible_proxy(&self.connection)
			.await
			.map_err(failure)?;
		let mut chosen = has_interface(&proxy, atspi::Interface::Selection)
			.await?
			.then(|| combo.clone());
		let mut pending = proxy.get_children().await.map_err(failure)?;
		drop(proxy);
		let mut options = Vec::new();
		for _ in 0..OPTION_DEPTH {
			let mut lists = Vec::new();
			for object in pending {
				if object.is_null() {
					continue;
				}
				let proxy = object
					.as_accessible_proxy(&self.connection)
					.await
					.map_err(failure)?;
				let role = proxy.get_role().await.map_err(failure)?;
				if !option_role(role) && !list_role(role) {
					continue;
				}
				let children = proxy.get_children().await.map_err(failure)?;
				if option_role(role) && children.is_empty() {
					if options.len() >= OPTION_LIMIT {
						return Err(failure("option limit exceeded"));
					}
					let title = proxy.name().await.map_err(failure)?;
					drop(proxy);
					options.push(ComboOption { object, title });
					continue;
				}
				if chosen.is_none() && has_interface(&proxy, atspi::Interface::Selection).await? {
					chosen = Some(object.clone());
				}
				if lists.len() + children.len() > OPTION_LIMIT {
					return Err(failure("option limit exceeded"));
				}
				lists.extend(children);
			}
			pending = lists;
		}
		Ok(Options { options, chosen })
	}

	/// The titles of the options `chosen` reports selected.
	async fn chosen_titles(&self, chosen: &ObjectRefOwned) -> CoreResult<Vec<String>> {
		let selection = atspi::proxy::selection::SelectionProxy::builder(&self.connection)
			.destination(
				chosen
					.name()
					.ok_or_else(|| failure("object has no bus name"))?
					.clone(),
			)
			.and_then(|builder| builder.path(chosen.path().clone()))
			.map_err(failure)?
			// Qt refuses `GetAll`; atk-bridge answers `Get`.
			.cache_properties(CacheProperties::No)
			.build()
			.await
			.map_err(failure)?;
		let count = selection.n_selected_children().await.map_err(failure)?;
		let mut titles = Vec::new();
		// One chosen option is the only answer that confirms a choice.
		for index in 0..count.clamp(0, 8) {
			let child = selection.get_selected_child(index).await.map_err(failure)?;
			if child.is_null() {
				continue;
			}
			let proxy = child
				.into_accessible_proxy(&self.connection)
				.await
				.map_err(failure)?;
			titles.push(proxy.name().await.map_err(failure)?);
		}
		Ok(titles)
	}

	/// The index of the action that chooses `option`, or `None` when it has
	/// none.
	async fn option_action<'a>(
		&'a self,
		option: &'a ObjectRefOwned,
	) -> CoreResult<Option<(atspi::proxy::action::ActionProxy<'a>, i32)>> {
		let proxy = option
			.as_accessible_proxy(&self.connection)
			.await
			.map_err(failure)?;
		if !has_interface(&proxy, atspi::Interface::Action).await? {
			return Ok(None);
		}
		let action = Self::action(&self.connection, option)
			.await
			.map_err(failure)?;
		let names = action_names(&action).await.map_err(failure)?;
		let Some(index) = choose_action(names.iter().map(String::as_str)) else {
			return Ok(None);
		};
		let index = i32::try_from(index).map_err(failure)?;
		Ok(Some((action, index)))
	}

	/// Chooses the option of `combo` titled exactly `value` by that option's
	/// own action, with no popup, and confirms it by reading back which option
	/// the combo box reports chosen.
	pub(super) async fn combo_choose(&self, combo: &ObjectRefOwned, value: &str) -> CoreResult<()> {
		let state = combo
			.as_accessible_proxy(&self.connection)
			.await
			.map_err(failure)?
			.get_state()
			.await
			.map_err(failure)?;
		if !state_enabled(state) {
			return Err(failure("it is disabled; nothing was chosen"));
		}
		let Options { options, chosen } = self.combo_options(combo).await?;
		let titles = || options.iter().map(|option| option.title.as_str());
		let index = choose_option(titles(), value).map_err(|refusal| {
			let list = option_list(&options);
			failure(match refusal {
				Refusal::Missing => {
					format!("no option is titled exactly {value:?}; nothing was chosen. Options: {list}")
				},
				Refusal::Ambiguous => format!(
					"several options are titled {value:?}, so the value cannot say which; nothing was \
					 chosen. Options: {list}"
				),
			})
		})?;
		let Some(chosen) = chosen else {
			return Err(no_route(&options));
		};
		if self.chosen_titles(&chosen).await? == [value] {
			return Ok(());
		}
		let Some((action, action_index)) = self.option_action(&options[index].object).await? else {
			return Err(no_route(&options));
		};
		control::check()?;
		if !action.do_action(action_index).await.map_err(failure)? {
			return Err(failure(format!("the app refused to choose {value:?}")));
		}
		let deadline = tokio::time::Instant::now() + CHOICE_WAIT;
		loop {
			let now = self.chosen_titles(&chosen).await?;
			if now == [value] {
				return Ok(());
			}
			if tokio::time::Instant::now() >= deadline {
				let shown = if now.is_empty() {
					"no option".to_owned()
				} else {
					now.iter()
						.map(|title| format!("\"{title}\""))
						.collect::<Vec<_>>()
						.join(", ")
				};
				return Err(failure(format!(
					"chose {value:?}, but it now shows {shown}; inspect it before choosing again"
				)));
			}
			tokio::time::sleep(POLL_INTERVAL).await;
		}
	}

	/// The refusal of a press that would open `combo`'s list, which takes the
	/// user's keyboard until it closes.
	pub(super) async fn combo_press_refusal(
		&self,
		combo: &ObjectRefOwned,
	) -> CoreResult<DesktopError> {
		let Options { options, chosen } = self.combo_options(combo).await?;
		let routed = match (&chosen, options.first()) {
			(Some(_), Some(option)) => self.option_action(&option.object).await?.is_some(),
			_ => false,
		};
		if !routed {
			return Ok(failure(format!(
				"pressing it opens its list, which takes the user's keyboard until it closes; nothing \
				 was pressed. Its options cannot be chosen through accessibility, and clicking it \
				 opens the same list, so that step needs the user's screen. Options: {}",
				option_list(&options)
			)));
		}
		Ok(failure(format!(
			"pressing it opens its list, which takes the user's keyboard until it closes; nothing \
			 was pressed. Choose an option with setValue(option) or press({{ menu: [option] }}). \
			 Options: {}",
			option_list(&options)
		)))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn options_match_exactly_and_untitled_items_are_not_options() {
		let titles = ["", "One", "Two", "two", "Two "];
		assert_eq!(choose_option(titles.into_iter(), "Two"), Ok(2));
		assert_eq!(choose_option(titles.into_iter(), ""), Err(Refusal::Missing));
		assert_eq!(choose_option(titles.into_iter(), "Three"), Err(Refusal::Missing));
		assert_eq!(choose_option(["A", "A"].into_iter(), "A"), Err(Refusal::Ambiguous));
	}

	#[test]
	fn errors_list_the_first_options() {
		let options: Vec<_> = (0..LISTED_OPTIONS + 3)
			.map(|index| ComboOption {
				object: ObjectRefOwned::from_static_str_unchecked(":1.7", "/option"),
				title:  index.to_string(),
			})
			.collect();
		let list = option_list(&options);
		assert_eq!(list.matches('"').count(), LISTED_OPTIONS * 2);
		assert!(list.ends_with(" and 3 more"), "{list}");
	}
}
