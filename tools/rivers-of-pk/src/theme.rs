//! Monochrome olive / beige wireframe palette.
//!
//! Approximates the Rivers-of-Empire schematic: dark ground, pale wire,
//! a single warm highlight. Truecolor first — modern Windows Terminal
//! and WezTerm speak RGB.

use ratatui::style::{Color, Modifier, Style};

pub const BG: Color = Color::Rgb(12, 12, 10);
pub const BG_PANEL: Color = Color::Rgb(16, 16, 13);
pub const BG_RAISED: Color = Color::Rgb(22, 22, 17);
pub const FG: Color = Color::Rgb(196, 184, 150);
pub const FG_DIM: Color = Color::Rgb(106, 98, 72);
pub const FG_MUTED: Color = Color::Rgb(138, 128, 96);
pub const OLIVE: Color = Color::Rgb(138, 138, 74);
pub const OLIVE_BRIGHT: Color = Color::Rgb(176, 172, 96);
pub const BEIGE: Color = Color::Rgb(201, 184, 150);
pub const WIRE: Color = Color::Rgb(154, 146, 96);
pub const WIRE_DIM: Color = Color::Rgb(82, 78, 52);
pub const SELECT: Color = Color::Rgb(232, 220, 192);
pub const PACKET: Color = Color::Rgb(240, 230, 192);
pub const ACCENT: Color = Color::Rgb(212, 196, 138);
pub const FACE_TOP: Color = Color::Rgb(42, 42, 24);
pub const FACE_LEFT: Color = Color::Rgb(28, 28, 18);
pub const FACE_RIGHT: Color = Color::Rgb(18, 18, 12);
pub const FACE_TOP_SEL: Color = Color::Rgb(72, 68, 36);
pub const FACE_LEFT_SEL: Color = Color::Rgb(52, 48, 26);
pub const FACE_RIGHT_SEL: Color = Color::Rgb(36, 34, 18);

pub fn base() -> Style {
    Style::default().fg(FG).bg(BG)
}

pub fn panel() -> Style {
    Style::default().fg(FG).bg(BG_PANEL)
}

pub fn title() -> Style {
    Style::default()
        .fg(BEIGE)
        .bg(BG)
        .add_modifier(Modifier::BOLD)
}

pub fn dim() -> Style {
    Style::default().fg(FG_DIM).bg(BG)
}

pub fn muted() -> Style {
    Style::default().fg(FG_MUTED).bg(BG_PANEL)
}

pub fn header() -> Style {
    Style::default()
        .fg(OLIVE_BRIGHT)
        .bg(BG_PANEL)
        .add_modifier(Modifier::BOLD)
}

pub fn selected() -> Style {
    Style::default()
        .fg(BG)
        .bg(SELECT)
        .add_modifier(Modifier::BOLD)
}

pub fn focused_item() -> Style {
    Style::default().fg(SELECT).bg(BG_RAISED)
}


pub fn tab_active() -> Style {
    Style::default()
        .fg(BG)
        .bg(BEIGE)
        .add_modifier(Modifier::BOLD)
}

pub fn tab_inactive() -> Style {
    Style::default().fg(FG_MUTED).bg(BG_RAISED)
}
