use super::ax::AtSpiAx;
use crate::desktop::{
	error::CoreResult,
	menus::{DesktopMenuItem, validate_path},
	types::DesktopWindow,
};

pub(crate) fn items(window: &DesktopWindow, path: &[String]) -> CoreResult<Vec<DesktopMenuItem>> {
	validate_path(path, true)?;
	AtSpiAx::new()?.menu_items(window, path)
}

pub(crate) fn select(window: &DesktopWindow, path: &[String]) -> CoreResult<()> {
	validate_path(path, false)?;
	AtSpiAx::new()?.menu_select(window, path)
}
