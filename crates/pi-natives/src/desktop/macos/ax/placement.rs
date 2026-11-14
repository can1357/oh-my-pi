//! Whether an element is where a person could click it.
//!
//! An `AppKit` control keeps answering `AXPress` after the app hides it, or
//! while its window shows a sheet: the button's action runs, though nobody
//! could have clicked it, and the press reports success. A toolbar shown only
//! while the pointer is over it is the common case: its buttons leave the tree
//! a moment after the pointer does, and a press of a ref read while they showed
//! still lands. A background click at such a control's center reports success
//! too, while the click reaches whatever the window shows there.
//!
//! A window that shows a sheet takes no click outside the sheet, while its
//! controls outside the sheet's frame still hit-test to themselves, so a
//! control the window itself draws is refused first, wherever the sheet is
//! drawn. Controls the sheet, a popover or another process draw are in other
//! window-server windows and pass, as do the window's title-bar buttons.
//!
//! Otherwise the test asks the element's own application what it would route
//! a click at the element's place to (`AXUIElementCopyElementAtPosition` on
//! the application, which hit-tests only that app's windows), and judges only
//! an answer inside the element's own window. Anything that keeps the window
//! itself out of reach is ordinary background work and is not judged: another
//! app's window over it, another Space, a minimised window, or a hit in
//! another window of the same app. Many controls never answer a hit-test
//! themselves: an answer that contains the element (its row, cell, group or
//! window) reaches it as long as each step down to the element is still listed
//! among its parent's children; a hidden `AppKit` view is not listed. A
//! table's column answers through the cells drawn in it, which are children of
//! the table's rows, not of the column: a cell that says it spans the column's
//! index, in a row of the column's own table, reaches the column while the
//! column is still listed. So does an answer drawn inside the element's frame
//! that takes no click of its own (a group or text that offers none of
//! [`CLICK_ACTIONS`]), since nothing else would act on the click. A different
//! control that covers the element is refused, naming it; an element whose
//! center alone is covered passes when another point of it reaches it, or when
//! it is scrolled out of view. Web content is not judged: an
//! element hidden there leaves the tree, while Chromium answers a hit-test
//! from a cache that lags behind the page (a visible dialog button hit-tested
//! to the web area once), clips the frame of an element scrolled out of view
//! to a one-point strip at the scroll view's edge, and `WebKit` routes a check
//! box's label text to the text.

use crate::desktop::{
	ax::{AxBounds, normalize_role_macos},
	error::{CoreResult, DesktopError},
};

/// How far up a hit's or an element's ancestry the test looks.
const MAX_DEPTH: usize = 64;

/// Subroles of the title-bar buttons, which a window showing a sheet still
/// takes clicks on.
const TITLE_BAR_BUTTONS: [&str; 4] =
	["AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"];

/// The actions a left click on an element triggers. Showing a context menu
/// or scrolling into view are not among them.
const CLICK_ACTIONS: [&str; 6] =
	["AXPress", "AXPick", "AXConfirm", "AXOpen", "AXIncrement", "AXDecrement"];

/// The application's answers the test reads, so it can run on a fake tree.
pub(super) trait Placement {
	type Element: PartialEq;
	fn bounds(&self, element: &Self::Element) -> Option<AxBounds>;
	fn parent(&self, element: &Self::Element) -> Option<Self::Element>;
	fn children(&self, element: &Self::Element) -> Vec<Self::Element>;
	fn role(&self, element: &Self::Element) -> Option<String>;
	fn subrole(&self, element: &Self::Element) -> Option<String>;
	/// The window holding `element`.
	fn window(&self, element: &Self::Element) -> Option<Self::Element>;
	/// Whether `element` is drawn in `window`'s own window-server window,
	/// rather than in a sheet's, a popover's or another process's.
	fn drawn_in(&self, element: &Self::Element, window: &Self::Element) -> bool;
	/// The element the application routes a click at global `(x, y)` to.
	fn hit(&self, x: f64, y: f64) -> Option<Self::Element>;
	/// The first nonempty of its title, description and value.
	fn label(&self, element: &Self::Element) -> Option<String>;
	/// Whether `element` is web content, or its app draws through Chromium.
	fn web_content(&self, element: &Self::Element) -> bool;
	/// The names of the actions `element` offers.
	fn actions(&self, element: &Self::Element) -> Vec<String>;
	/// A column's place among its table's columns (`AXIndex`).
	fn column_index(&self, element: &Self::Element) -> Option<i64>;
	/// The columns a table cell spans (`AXColumnIndexRange`): first and count.
	fn column_span(&self, element: &Self::Element) -> Option<(i64, i64)>;
}

/// Refuses an action on `element` that a person could not click: its window
/// shows a sheet and draws the element itself, or, with `hit_test`, its
/// application would not route a click at the element's place to it because
/// its own window shows something else there (the element is hidden or
/// zero-sized). An element whose place cannot be judged passes.
pub(super) fn require_shown<P: Placement>(
	app: &P,
	element: &P::Element,
	hit_test: bool,
) -> CoreResult<()> {
	let Some(window) = app.window(element) else {
		return Ok(());
	};
	if behind_sheet(app, element, &window) && !app.web_content(element) {
		return Err(DesktopError::ax_failed(
			"the element's window shows a sheet, which takes every click in the window outside it \
			 until it closes, so a person could not click the element and nothing was sent; act in \
			 the sheet or close it first",
		));
	}
	if !hit_test {
		return Ok(());
	}
	let Some(bounds) = app.bounds(element) else {
		return Ok(());
	};
	let center = (bounds.x + bounds.width / 2.0, bounds.y + bounds.height / 2.0);
	let Some(hit) = app.hit(center.0, center.1) else {
		return Ok(());
	};
	if app.window(&hit).is_none_or(|of| of != window) || reaches(app, &hit, element) {
		return Ok(());
	}
	// A column's cell; something inside the element that takes no click of
	// its own; an element scrolled out of its view, which the press may
	// scroll to; a part of the element away from its center; or web content.
	if ((in_column(app, &hit, element) || (inside(app, &hit, &bounds) && !takes_clicks(app, &hit)))
		&& listed_under(app, &window, element))
		|| clipped(app, element, center)
		|| samples(&bounds).any(|(x, y)| app.hit(x, y).is_some_and(|hit| reaches(app, &hit, element)))
		|| app.web_content(element)
	{
		return Ok(());
	}
	let role = app
		.role(&hit)
		.map_or_else(|| "element".to_owned(), |role| normalize_role_macos(&role));
	let shown = app
		.label(&hit)
		.map_or_else(|| role.clone(), |label| format!("{role} \"{label}\""));
	Err(DesktopError::ax_failed(format!(
		"the element is not shown where it was read, so a person could not click it and nothing was \
		 sent: at its center ({:.0}, {:.0}) its window shows {shown} instead. It may be hidden or \
		 covered; read the window again. A control that appears only while the pointer is over its \
		 area is reached by a takeover click, which brings the pointer there first: el.click({{ \
		 takeover: true }})",
		center.0, center.1
	)))
}

/// Whether `window` shows a sheet that `element` is not part of: the window
/// itself draws the element, which is neither the window nor one of its
/// title-bar buttons.
fn behind_sheet<P: Placement>(app: &P, element: &P::Element, window: &P::Element) -> bool {
	if element == window
		|| app
			.subrole(element)
			.is_some_and(|subrole| TITLE_BAR_BUTTONS.contains(&subrole.as_str()))
	{
		return false;
	}
	let Some(sheet) = app
		.children(window)
		.into_iter()
		.find(|child| app.role(child).as_deref() == Some("AXSheet"))
	else {
		return false;
	};
	&sheet != element
		&& app.drawn_in(element, window)
		&& !ancestors(app, element).any(|ancestor| ancestor == sheet)
}

/// Whether a click routed to `hit` reaches `element`: `hit` is the element,
/// lies inside it, or contains it through parents that each still list the
/// next step down among their children.
fn reaches<P: Placement>(app: &P, hit: &P::Element, element: &P::Element) -> bool {
	hit == element
		|| ancestors(app, hit).any(|ancestor| &ancestor == element)
		|| listed_under(app, hit, element)
}

/// Whether `ancestor` contains `element` and each parent on the way lists the
/// next step among its children.
fn listed_under<P: Placement>(app: &P, ancestor: &P::Element, element: &P::Element) -> bool {
	let Some(mut parent) = app.parent(element) else {
		return false;
	};
	if !lists(app, &parent, element) {
		return false;
	}
	for _ in 0..MAX_DEPTH {
		if &parent == ancestor {
			return true;
		}
		if is_top(app, &parent) {
			return false;
		}
		let Some(next) = app.parent(&parent) else {
			return false;
		};
		if !lists(app, &next, &parent) {
			return false;
		}
		parent = next;
	}
	false
}

fn lists<P: Placement>(app: &P, parent: &P::Element, child: &P::Element) -> bool {
	app.children(parent).iter().any(|listed| listed == child)
}

/// `element`'s ancestors up to its window, nearest first.
fn ancestors<'a, P: Placement>(
	app: &'a P,
	element: &P::Element,
) -> impl Iterator<Item = P::Element> + use<'a, P> {
	let mut next = app.parent(element);
	std::iter::from_fn(move || {
		let current = next.take()?;
		if !is_top(app, &current) {
			next = app.parent(&current);
		}
		Some(current)
	})
	.take(MAX_DEPTH)
}

fn is_top<P: Placement>(app: &P, element: &P::Element) -> bool {
	matches!(app.role(element).as_deref(), Some("AXWindow" | "AXApplication"))
}

/// Whether `hit` is drawn within `bounds`.
fn inside<P: Placement>(app: &P, hit: &P::Element, bounds: &AxBounds) -> bool {
	app.bounds(hit).is_some_and(|inner| {
		inner.x >= bounds.x
			&& inner.y >= bounds.y
			&& inner.x + inner.width <= bounds.x + bounds.width
			&& inner.y + inner.height <= bounds.y + bounds.height
	})
}

/// Whether a click on `element` triggers an action of its own.
fn takes_clicks<P: Placement>(app: &P, element: &P::Element) -> bool {
	app.actions(element).iter().any(|action| {
		CLICK_ACTIONS
			.iter()
			.any(|click| action.eq_ignore_ascii_case(click))
	})
}

/// Whether `hit` is, or lies in, a cell of the column `element`: an `AXCell`
/// that says it spans the column's index, in an `AXRow` of the column's own
/// table.
fn in_column<P: Placement>(app: &P, hit: &P::Element, element: &P::Element) -> bool {
	if app.role(element).as_deref() != Some("AXColumn") {
		return false;
	}
	let (Some(index), Some(table)) = (app.column_index(element), app.parent(element)) else {
		return false;
	};
	let cell_of_column = |candidate: &P::Element| {
		app.role(candidate).as_deref() == Some("AXCell")
			&& app
				.column_span(candidate)
				.is_some_and(|(first, count)| first <= index && index - first < count)
			&& app.parent(candidate).is_some_and(|row| {
				app.role(&row).as_deref() == Some("AXRow")
					&& app.parent(&row).is_some_and(|of| of == table)
			})
	};
	cell_of_column(hit)
		|| ancestors(app, hit)
			.take_while(|ancestor| !is_top(app, ancestor))
			.any(|ancestor| cell_of_column(&ancestor))
}

/// Whether `(x, y)`, the element's center, lies outside an ancestor's bounds:
/// the element is scrolled out of a view, where a press acts on it as before.
fn clipped<P: Placement>(app: &P, element: &P::Element, (x, y): (f64, f64)) -> bool {
	ancestors(app, element)
		.take_while(|ancestor| !is_top(app, ancestor))
		.any(|ancestor| {
			app.bounds(&ancestor).is_some_and(|b| {
				b.width > 0.0
					&& b.height > 0.0
					&& !(b.x <= x && x <= b.x + b.width && b.y <= y && y <= b.y + b.height)
			})
		})
}

/// Four points inside the element besides its center, a quarter in from each
/// side; none for an element without area.
fn samples(bounds: &AxBounds) -> impl Iterator<Item = (f64, f64)> + '_ {
	let has_area = bounds.width >= 1.0 && bounds.height >= 1.0;
	[(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)]
		.into_iter()
		.filter(move |_| has_area)
		.map(|(fx, fy)| (bounds.width.mul_add(fx, bounds.x), bounds.height.mul_add(fy, bounds.y)))
}

#[cfg(test)]
mod tests {
	use super::{Placement, require_shown};
	use crate::desktop::{ax::AxBounds, error::ErrorCode};

	struct Node {
		parent:  Option<usize>,
		role:    &'static str,
		subrole: &'static str,
		label:   &'static str,
		bounds:  Option<AxBounds>,
		/// Left out of its parent's children, as a hidden view is.
		hidden:  bool,
		/// The window-server window that draws it: its nearest window, sheet
		/// or popover ancestor.
		drawn:   Option<usize>,
		/// What a click on it triggers: `AXPress` for controls.
		actions: &'static [&'static str],
		/// A column's `AXIndex`.
		column:  Option<i64>,
		/// A cell's `AXColumnIndexRange`.
		span:    Option<(i64, i64)>,
	}

	/// A fake application: nodes by index, and the nodes a click reaches,
	/// topmost last.
	#[derive(Default)]
	struct App {
		nodes:    Vec<Node>,
		hittable: Vec<usize>,
	}

	const fn rect(x: f64, y: f64, width: f64, height: f64) -> AxBounds {
		AxBounds { x, y, width, height }
	}

	impl App {
		fn add(
			&mut self,
			parent: Option<usize>,
			role: &'static str,
			label: &'static str,
			bounds: impl Into<Option<AxBounds>>,
		) -> usize {
			let index = self.nodes.len();
			let drawn = if matches!(role, "AXWindow" | "AXSheet" | "AXPopover") {
				Some(index)
			} else {
				parent.and_then(|parent| self.nodes[parent].drawn)
			};
			self.nodes.push(Node {
				parent,
				role,
				subrole: "",
				label,
				bounds: bounds.into(),
				hidden: false,
				drawn,
				actions: if matches!(role, "AXButton" | "AXCheckBox" | "AXPopUpButton") {
					&["AXPress"]
				} else {
					&[]
				},
				column: None,
				span: None,
			});
			index
		}

		/// An application with one window and a button in it, both hittable.
		fn window_with_button() -> (Self, usize, usize) {
			let mut app = Self::default();
			let window = app.add(None, "AXWindow", "Main", rect(0.0, 0.0, 400.0, 300.0));
			let button = app.add(Some(window), "AXButton", "Export", rect(100.0, 100.0, 80.0, 20.0));
			app.hittable = vec![window, button];
			(app, window, button)
		}

		/// Hides `node` as `AppKit` hides a view: it stays readable but leaves
		/// its parent's children and takes no clicks.
		fn hide(&mut self, node: usize) {
			self.nodes[node].hidden = true;
			self.hittable.retain(|&hit| hit != node);
		}

		fn check(&self, element: usize) -> Result<(), (ErrorCode, String)> {
			require_shown(self, &element, true).map_err(|error| (error.code, error.message))
		}
	}

	impl Placement for App {
		type Element = usize;

		fn bounds(&self, element: &usize) -> Option<AxBounds> {
			self.nodes[*element].bounds
		}

		fn parent(&self, element: &usize) -> Option<usize> {
			self.nodes[*element].parent
		}

		fn children(&self, element: &usize) -> Vec<usize> {
			(0..self.nodes.len())
				.filter(|&node| self.nodes[node].parent == Some(*element) && !self.nodes[node].hidden)
				.collect()
		}

		fn role(&self, element: &usize) -> Option<String> {
			Some(self.nodes[*element].role.to_owned())
		}

		fn subrole(&self, element: &usize) -> Option<String> {
			Some(self.nodes[*element].subrole.to_owned()).filter(|subrole| !subrole.is_empty())
		}

		fn window(&self, element: &usize) -> Option<usize> {
			let mut current = Some(*element);
			while let Some(node) = current {
				if self.nodes[node].role == "AXWindow" {
					return Some(node);
				}
				current = self.nodes[node].parent;
			}
			None
		}

		fn drawn_in(&self, element: &usize, window: &usize) -> bool {
			self.nodes[*element].drawn == Some(*window)
		}

		fn hit(&self, x: f64, y: f64) -> Option<usize> {
			self.hittable.iter().rev().copied().find(|&node| {
				self.nodes[node]
					.bounds
					.is_some_and(|b| b.x <= x && x < b.x + b.width && b.y <= y && y < b.y + b.height)
			})
		}

		fn label(&self, element: &usize) -> Option<String> {
			Some(self.nodes[*element].label.to_owned()).filter(|label| !label.is_empty())
		}

		fn web_content(&self, element: &usize) -> bool {
			let mut current = self.nodes[*element].parent;
			while let Some(node) = current {
				if self.nodes[node].role == "AXWebArea" {
					return true;
				}
				current = self.nodes[node].parent;
			}
			false
		}

		fn actions(&self, element: &usize) -> Vec<String> {
			self.nodes[*element]
				.actions
				.iter()
				.map(|&action| action.to_owned())
				.collect()
		}

		fn column_index(&self, element: &usize) -> Option<i64> {
			self.nodes[*element].column
		}

		fn column_span(&self, element: &usize) -> Option<(i64, i64)> {
			self.nodes[*element].span
		}
	}

	#[test]
	fn an_element_its_click_reaches_through_itself_a_part_a_container_or_another_point_passes() {
		let (mut app, window, button) = App::window_with_button();
		assert_eq!(app.check(button), Ok(()));
		let text = app.add(Some(button), "AXStaticText", "Export", rect(105.0, 102.0, 70.0, 16.0));
		app.hittable.push(text);
		assert_eq!(app.check(button), Ok(()));
		// A badge over the center, while the rest of the button takes the click.
		app.hittable.retain(|&node| node != text);
		let badge = app.add(Some(window), "AXImage", "badge", rect(130.0, 104.0, 20.0, 12.0));
		app.hittable.push(badge);
		assert_eq!(app.check(button), Ok(()));
		// Its row, window or cell takes the click.
		let (mut app, window, _) = App::window_with_button();
		let table = app.add(Some(window), "AXTable", "", rect(0.0, 180.0, 400.0, 120.0));
		let row = app.add(Some(table), "AXRow", "", rect(0.0, 200.0, 400.0, 20.0));
		let cell = app.add(Some(row), "AXCell", "", rect(0.0, 200.0, 200.0, 20.0));
		let item = app.add(Some(cell), "AXButton", "Open", rect(10.0, 202.0, 40.0, 16.0));
		app.hittable.extend([table, row]);
		assert_eq!(app.check(item), Ok(()));
		app.hittable.retain(|&node| node != row && node != table);
		assert_eq!(app.check(item), Ok(()));
	}

	#[test]
	fn a_column_passes_through_a_cell_of_its_own_only() {
		let (mut app, window, _) = App::window_with_button();
		let table = app.add(Some(window), "AXTable", "", rect(0.0, 180.0, 400.0, 120.0));
		let row = app.add(Some(table), "AXRow", "", rect(0.0, 200.0, 400.0, 20.0));
		// The first column's cell is wider than the column, as in Finder's list
		// view, so only the cell's own column range ties it to the column.
		let name_cell = app.add(Some(row), "AXCell", "", rect(0.0, 200.0, 214.0, 20.0));
		let size_cell = app.add(Some(row), "AXCell", "", rect(214.0, 200.0, 186.0, 20.0));
		app.nodes[name_cell].span = Some((0, 1));
		app.nodes[size_cell].span = Some((1, 1));
		let name = app.add(Some(table), "AXColumn", "Name", rect(0.0, 200.0, 200.0, 20.0));
		let size = app.add(Some(table), "AXColumn", "Size", rect(200.0, 200.0, 200.0, 20.0));
		app.nodes[name].column = Some(0);
		app.nodes[size].column = Some(1);
		app.hittable.extend([table, row, name_cell, size_cell]);
		assert_eq!(app.check(name), Ok(()));
		assert_eq!(app.check(size), Ok(()));
		// The hit is often the cell's content, here a field that takes clicks.
		let field = app.add(Some(name_cell), "AXTextField", "", rect(10.0, 202.0, 150.0, 16.0));
		app.nodes[field].actions = &["AXConfirm"];
		app.hittable.push(field);
		assert_eq!(app.check(name), Ok(()));
		app.hittable.retain(|&node| node != field);
		// A cell of another column does not reach this one, nor does a cell
		// with an empty range, which menus and splitters also answer.
		app.nodes[name_cell].span = Some((1, 1));
		assert!(app.check(name).is_err());
		app.nodes[name_cell].span = Some((0, 0));
		assert!(app.check(name).is_err());
		app.nodes[name_cell].span = Some((0, 1));
		// Nor does a control in the row that is not a cell, whatever range it
		// answers.
		let tool = app.add(Some(row), "AXButton", "Tool", rect(40.0, 200.0, 120.0, 20.0));
		app.nodes[tool].span = Some((0, 1));
		app.hittable.push(tool);
		assert!(app.check(name).unwrap_err().1.contains("button \"Tool\""));
		app.hittable.retain(|&node| node != tool);
		// Nor a cell that is not in a row of the table.
		let group = app.add(Some(table), "AXGroup", "", rect(0.0, 200.0, 400.0, 20.0));
		let stray = app.add(Some(group), "AXCell", "", rect(0.0, 200.0, 300.0, 20.0));
		app.nodes[stray].span = Some((0, 1));
		app.hittable.push(stray);
		assert!(app.check(name).is_err());
		app.hittable.retain(|&node| node != stray);
		// Nor a cell of another table drawn over this one.
		let other = app.add(Some(window), "AXTable", "", rect(0.0, 190.0, 400.0, 40.0));
		let other_row = app.add(Some(other), "AXRow", "", rect(0.0, 195.0, 400.0, 30.0));
		let other_cell = app.add(Some(other_row), "AXCell", "", rect(0.0, 195.0, 300.0, 30.0));
		app.nodes[other_cell].span = Some((0, 1));
		app.hittable.extend([other, other_row, other_cell]);
		assert!(app.check(name).is_err());
	}

	#[test]
	fn a_different_control_drawn_over_the_element_is_refused_and_a_non_control_passes() {
		let (mut app, window, button) = App::window_with_button();
		// A sibling control with the button's own frame.
		let cover = app.add(Some(window), "AXButton", "Cover", rect(100.0, 100.0, 80.0, 20.0));
		app.hittable.push(cover);
		assert!(
			app.check(button)
				.unwrap_err()
				.1
				.contains("button \"Cover\"")
		);
		// A smaller control at the button's center, while a panel drawn over the
		// button takes the clicks elsewhere on it.
		app.hittable.retain(|&node| node != cover);
		let panel = app.add(Some(window), "AXGroup", "", rect(90.0, 90.0, 100.0, 40.0));
		let small = app.add(Some(window), "AXButton", "Small", rect(130.0, 105.0, 20.0, 10.0));
		app.hittable.extend([panel, small]);
		assert!(
			app.check(button)
				.unwrap_err()
				.1
				.contains("button \"Small\"")
		);
		// The same shapes drawn by elements a click does not act on pass.
		app.hittable.retain(|&node| node != small);
		let text = app.add(Some(window), "AXStaticText", "Title", rect(130.0, 105.0, 20.0, 10.0));
		app.hittable.push(text);
		assert_eq!(app.check(button), Ok(()));
		app.hittable.retain(|&node| node != text && node != panel);
		let twin = app.add(Some(window), "AXGroup", "", rect(100.0, 100.0, 80.0, 20.0));
		app.hittable.push(twin);
		assert_eq!(app.check(button), Ok(()));
	}

	#[test]
	fn a_hidden_element_is_refused_naming_what_its_window_shows_there() {
		let (mut app, window, button) = App::window_with_button();
		// Hidden: the window still contains it, but no longer lists it, and
		// takes the click itself.
		app.hide(button);
		let (code, message) = app.check(button).unwrap_err();
		assert_eq!(code, ErrorCode::AxFailed);
		assert!(message.contains("nothing was sent"), "{message}");
		assert!(message.contains("window \"Main\""), "{message}");
		assert!(message.contains("takeover: true"), "{message}");
		// A hover toolbar: the buttons' hidden group no longer lists them.
		let bar = app.add(Some(window), "AXGroup", "", rect(200.0, 20.0, 180.0, 40.0));
		let action = app.add(Some(bar), "AXButton", "Share", rect(210.0, 30.0, 60.0, 20.0));
		app.hittable.push(bar);
		assert_eq!(app.check(action), Ok(()));
		app.hide(action);
		assert!(app.check(action).unwrap_err().1.contains("group"));
		// Only the hit-test judges it.
		assert!(require_shown(&app, &action, false).is_ok());
	}

	#[test]
	fn an_element_of_a_window_showing_a_sheet_is_refused_wherever_the_sheet_is() {
		let (mut app, window, button) = App::window_with_button();
		// The sheet is drawn away from the button, which still takes a click
		// at its center: the sheet blocks it anyway.
		let sheet = app.add(Some(window), "AXSheet", "", rect(50.0, 150.0, 300.0, 140.0));
		let cancel = app.add(Some(sheet), "AXButton", "Cancel", rect(90.0, 200.0, 100.0, 30.0));
		app.hittable.extend([sheet, cancel]);
		let (code, message) = app.check(button).unwrap_err();
		assert_eq!(code, ErrorCode::AxFailed);
		assert!(message.contains("shows a sheet"), "{message}");
		assert!(message.contains("nothing was sent"), "{message}");
		assert_eq!(
			require_shown(&app, &button, false).map_err(|error| error.code),
			Err(ErrorCode::AxFailed)
		);
		// The sheet and what it draws, the window, and its title-bar buttons
		// take clicks.
		assert_eq!(app.check(cancel), Ok(()));
		assert_eq!(app.check(sheet), Ok(()));
		assert_eq!(app.check(window), Ok(()));
		let minimize = app.add(Some(window), "AXButton", "", rect(20.0, 4.0, 12.0, 12.0));
		app.nodes[minimize].subrole = "AXMinimizeButton";
		app.hittable.push(minimize);
		assert_eq!(app.check(minimize), Ok(()));
	}

	#[test]
	fn an_element_drawn_in_another_window_than_the_one_showing_a_sheet_passes() {
		let (mut app, window, _) = App::window_with_button();
		let sheet = app.add(Some(window), "AXSheet", "", rect(50.0, 150.0, 300.0, 140.0));
		app.hittable.push(sheet);
		// A popover a sheet control opened, parented to the window.
		let popover = app.add(Some(window), "AXPopover", "", rect(200.0, 40.0, 150.0, 60.0));
		let done = app.add(Some(popover), "AXButton", "Done", rect(220.0, 60.0, 60.0, 20.0));
		app.hittable.extend([popover, done]);
		assert_eq!(app.check(done), Ok(()));
		// A Save panel's control, drawn by another process, whose parents reach
		// the window without passing the sheet.
		let remote = app.add(Some(window), "AXButton", "Save", rect(260.0, 250.0, 60.0, 20.0));
		app.nodes[remote].drawn = Some(sheet);
		assert!(require_shown(&app, &remote, false).is_ok());
	}

	#[test]
	fn web_content_is_not_judged() {
		let (mut app, window, _) = App::window_with_button();
		let web = app.add(Some(window), "AXWebArea", "page", rect(0.0, 0.0, 400.0, 300.0));
		let page_button = app.add(Some(web), "AXButton", "OK", rect(100.0, 100.0, 80.0, 20.0));
		app.hittable.push(web);
		app.hide(page_button);
		assert_eq!(app.check(page_button), Ok(()));
		let sheet = app.add(Some(window), "AXSheet", "", rect(50.0, 150.0, 300.0, 140.0));
		app.hittable.push(sheet);
		assert_eq!(app.check(page_button), Ok(()));
	}

	#[test]
	fn an_element_under_another_view_of_its_window_is_refused() {
		let (mut app, window, button) = App::window_with_button();
		let panel = app.add(Some(window), "AXGroup", "", rect(50.0, 50.0, 300.0, 200.0));
		let other = app.add(Some(panel), "AXButton", "Cancel", rect(90.0, 95.0, 100.0, 30.0));
		app.hittable.extend([panel, other]);
		let (_, message) = app.check(button).unwrap_err();
		assert!(message.contains("at its center (140, 110)"), "{message}");
		assert!(message.contains("button \"Cancel\""), "{message}");
	}

	#[test]
	fn an_element_out_of_reach_or_without_window_or_bounds_is_not_judged() {
		let (mut app, window, button) = App::window_with_button();
		// Another Space, minimised, or under another app: no window of the
		// app takes the click.
		app.hittable.clear();
		assert_eq!(app.check(button), Ok(()));
		// Another window of the same app over it.
		let front = app.add(None, "AXWindow", "Other", rect(0.0, 0.0, 400.0, 300.0));
		app.hittable.push(front);
		assert_eq!(app.check(button), Ok(()));
		let unbounded = app.add(Some(window), "AXButton", "Odd", None::<AxBounds>);
		assert_eq!(app.check(unbounded), Ok(()));
		let mut app = App::default();
		let menu = app.add(None, "AXApplication", "Fixture", None::<AxBounds>);
		let bar = app.add(Some(menu), "AXMenuBarItem", "File", rect(0.0, 0.0, 30.0, 20.0));
		let item = app.add(Some(bar), "AXMenuItem", "Mark", rect(0.0, 0.0, 0.0, 0.0));
		assert_eq!(app.check(item), Ok(()));
	}

	#[test]
	fn an_element_scrolled_out_of_its_view_is_not_judged() {
		let (mut app, window, button) = App::window_with_button();
		let scroll = app.add(Some(window), "AXScrollArea", "", rect(0.0, 150.0, 200.0, 100.0));
		// Below the visible part of the scroll area, still inside the window,
		// where the window's button takes the click.
		let deep = app.add(Some(scroll), "AXButton", "Deep", rect(100.0, 105.0, 80.0, 20.0));
		app.hittable.push(scroll);
		assert_eq!(app.hit(140.0, 115.0), Some(button));
		assert_eq!(app.check(deep), Ok(()));
	}
}
