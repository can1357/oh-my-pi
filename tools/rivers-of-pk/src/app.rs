//! Interactive TUI: sidebar, isometric city, inspect tabs, moving packets.
//!
//! Chrome matches the Rivers-of-Empire reference: hairline side rails,
//! no boxed city, hover-to-read packets, enter-inside / esc-out.

use crate::iso::{self, Camera, IsoCity, Packet};
use crate::model::{Graph, Section};
use crate::theme;
use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Tabs, Wrap};
use ratatui::Frame;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RightTab {
    What,
    How,
}

impl RightTab {
    fn titles() -> [&'static str; 2] {
        ["WHAT IT DOES", "HOW IT'S BUILT"]
    }
}

pub struct App {
    pub graph: Graph,
    pub camera: Camera,
    pub selected: usize,
    pub hovered: Option<usize>,
    pub inside: Option<usize>,
    pub tab: RightTab,
    pub packets: Vec<Packet>,
    pub hover_packet: Option<usize>,
    pub inspect_packet: Option<usize>,
    pub city_area: Rect,
    pub sidebar_area: Rect,
    pub dragging: bool,
    pub last_mouse: (u16, u16),
    pub last_tick: Instant,
    pub should_quit: bool,
    pub status: String,
    pub workspace: String,
}

impl App {
    pub fn new(graph: Graph, workspace: String) -> Self {
        let mut packets = Vec::new();
        for (ei, edge) in graph.edges.iter().enumerate() {
            let n = edge.payloads.len().max(1).min(3);
            for i in 0..n {
                let payload = edge
                    .payloads
                    .get(i)
                    .cloned()
                    .unwrap_or_else(|| edge.label.clone());
                packets.push(Packet {
                    edge_idx: ei,
                    t: (i as f32 + 0.12) / (n as f32 + 0.3),
                    glyph: match i % 3 {
                        0 => '·',
                        1 => '•',
                        _ => '▸',
                    },
                    payload,
                    screen: (0, 0),
                });
            }
        }
        Self {
            graph,
            camera: Camera::default(),
            selected: 0,
            hovered: None,
            inside: None,
            tab: RightTab::What,
            packets,
            hover_packet: None,
            inspect_packet: None,
            city_area: Rect::default(),
            sidebar_area: Rect::default(),
            dragging: false,
            last_mouse: (0, 0),
            last_tick: Instant::now(),
            should_quit: false,
            status: "scan complete".into(),
            workspace,
        }
    }

    pub fn tick(&mut self) {
        let now = Instant::now();
        let dt = (now - self.last_tick).as_secs_f32().min(0.08);
        self.last_tick = now;
        for (i, pkt) in self.packets.iter_mut().enumerate() {
            let speed = 0.07 + ((i % 5) as f32) * 0.012;
            pkt.advance(dt, speed);
            if let Some(xy) = iso::packet_screen(
                &self.graph,
                &self.camera,
                self.city_area,
                pkt.edge_idx,
                pkt.t,
            ) {
                pkt.screen = xy;
            }
        }
    }

    pub fn handle(&mut self, ev: Event) {
        match ev {
            Event::Key(k) if k.kind == KeyEventKind::Press || k.kind == KeyEventKind::Repeat => {
                self.on_key(k);
            }
            Event::Mouse(m) => self.on_mouse(m),
            Event::Resize(_, _) => {}
            _ => {}
        }
    }

    fn on_key(&mut self, k: KeyEvent) {
        if k.modifiers.contains(KeyModifiers::CONTROL) && k.code == KeyCode::Char('c') {
            self.should_quit = true;
            return;
        }
        match k.code {
            KeyCode::Char('q') | KeyCode::Char('Q') => self.should_quit = true,
            KeyCode::Esc => {
                if self.inspect_packet.is_some() {
                    self.inspect_packet = None;
                } else if self.inside.is_some() {
                    self.inside = None;
                }
            }
            KeyCode::Enter => {
                if let Some(p) = self.hover_packet.or(self.inspect_packet) {
                    self.inspect_packet = Some(p);
                    self.hover_packet = Some(p);
                } else {
                    self.inside = Some(self.selected);
                }
            }
            KeyCode::Backspace => self.inside = None,
            KeyCode::Tab => {
                self.tab = match self.tab {
                    RightTab::What => RightTab::How,
                    RightTab::How => RightTab::What,
                };
            }
            KeyCode::Char('1') => self.tab = RightTab::What,
            KeyCode::Char('2') => self.tab = RightTab::How,
            KeyCode::Char('n') | KeyCode::Char(']') => self.move_sel(1),
            KeyCode::Char('N') | KeyCode::Char('[') => self.move_sel(-1),
            KeyCode::Char('p') => self.cycle_packet(1),
            KeyCode::Char('P') => self.cycle_packet(-1),
            KeyCode::Up | KeyCode::Char('k') | KeyCode::Char('w') => self.pan(0.0, 1.0),
            KeyCode::Down | KeyCode::Char('j') | KeyCode::Char('s') => self.pan(0.0, -1.0),
            KeyCode::Left | KeyCode::Char('h') | KeyCode::Char('a') => self.pan(1.2, 0.0),
            KeyCode::Right | KeyCode::Char('l') | KeyCode::Char('d') => self.pan(-1.2, 0.0),
            KeyCode::Char('+') | KeyCode::Char('=') | KeyCode::PageUp => self.camera.zoom_at(1.12),
            KeyCode::Char('-') | KeyCode::Char('_') | KeyCode::PageDown => self.camera.zoom_at(0.89),
            KeyCode::Char('r') => {
                self.camera = Camera::default();
                self.inside = None;
                self.inspect_packet = None;
                self.hover_packet = None;
            }
            KeyCode::Home => {
                self.selected = 0;
                self.center_on_selected();
            }
            KeyCode::End => {
                self.selected = self.graph.nodes.len().saturating_sub(1);
                self.center_on_selected();
            }
            _ => {}
        }
    }

    fn move_sel(&mut self, delta: i32) {
        let n = self.graph.nodes.len() as i32;
        if n == 0 {
            return;
        }
        self.selected = ((self.selected as i32 + delta).rem_euclid(n)) as usize;
        self.inside = None;
        self.center_on_selected();
    }

    fn pan(&mut self, dx: f32, dy: f32) {
        self.camera.pan_x += dx;
        self.camera.pan_y += dy;
        self.camera.clamp();
    }

    fn cycle_packet(&mut self, delta: i32) {
        let n = self.packets.len() as i32;
        if n == 0 {
            return;
        }
        let cur = self
            .inspect_packet
            .or(self.hover_packet)
            .map(|i| i as i32)
            .unwrap_or(-1);
        let next = (cur + delta).rem_euclid(n) as usize;
        self.hover_packet = Some(next);
        self.inspect_packet = Some(next);
        if let Some(edge) = self.graph.edges.get(self.packets[next].edge_idx) {
            self.status = format!("packet {} → {}", edge.from, edge.to);
        }
    }

    fn center_on_selected(&mut self) {
        if let Some(node) = self.graph.nodes.get(self.selected) {
            let (cx, cy, _) = node.r#box.center();
            self.camera.pan_x = -cx * 0.35;
            self.camera.pan_y = -cy * 0.25;
            self.camera.clamp();
        }
    }

    fn on_mouse(&mut self, m: MouseEvent) {
        let prev = self.last_mouse;
        self.last_mouse = (m.column, m.row);
        match m.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                if point_in(self.city_area, m.column, m.row) {
                    if let Some(p) = self.packet_at(m.column, m.row) {
                        self.inspect_packet = Some(p);
                        self.hover_packet = Some(p);
                    } else if let Some(idx) =
                        iso::hit_node(&self.graph, &self.camera, self.city_area, m.column, m.row)
                    {
                        self.selected = idx;
                        self.inside = Some(idx);
                    } else if self.inside.is_some() {
                        self.inside = None;
                    } else {
                        self.dragging = true;
                    }
                } else if point_in(self.sidebar_area, m.column, m.row) {
                    if let Some(idx) = self.sidebar_index_at(m.row) {
                        self.selected = idx;
                        self.center_on_selected();
                    }
                }
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if self.dragging {
                    let dx = m.column as i32 - prev.0 as i32;
                    let dy = m.row as i32 - prev.1 as i32;
                    self.camera.pan_x += dx as f32 * 0.08;
                    self.camera.pan_y += dy as f32 * 0.08;
                    self.camera.clamp();
                }
            }
            MouseEventKind::Up(MouseButton::Left) => self.dragging = false,
            MouseEventKind::ScrollUp => {
                if point_in(self.city_area, m.column, m.row) {
                    self.camera.zoom_at(1.10);
                } else {
                    self.move_sel(-1);
                }
            }
            MouseEventKind::ScrollDown => {
                if point_in(self.city_area, m.column, m.row) {
                    self.camera.zoom_at(0.91);
                } else {
                    self.move_sel(1);
                }
            }
            MouseEventKind::Moved => {
                self.hover_packet = self.packet_at(m.column, m.row);
                if point_in(self.city_area, m.column, m.row) {
                    self.hovered =
                        iso::hit_node(&self.graph, &self.camera, self.city_area, m.column, m.row);
                } else if point_in(self.sidebar_area, m.column, m.row) {
                    self.hovered = self.sidebar_index_at(m.row);
                } else {
                    self.hovered = None;
                }
            }
            MouseEventKind::Down(MouseButton::Right) => {
                if self.inspect_packet.is_some() {
                    self.inspect_packet = None;
                } else if self.inside.is_some() {
                    self.inside = None;
                }
            }
            _ => {}
        }
    }

    fn packet_at(&self, x: u16, y: u16) -> Option<usize> {
        self.packets.iter().position(|p| {
            (p.screen.0 - x as i32).abs() <= 1 && (p.screen.1 - y as i32).abs() <= 1
        })
    }

    fn sidebar_rows(&self) -> Vec<SidebarRow> {
        let mut rows = Vec::new();
        for section in Section::all() {
            let members: Vec<usize> = self
                .graph
                .nodes
                .iter()
                .enumerate()
                .filter(|(_, n)| n.section == section)
                .map(|(i, _)| i)
                .collect();
            if members.is_empty() {
                continue;
            }
            rows.push(SidebarRow::Header(section));
            for idx in members {
                rows.push(SidebarRow::Item(idx));
            }
        }
        rows
    }

    fn sidebar_index_at(&self, row: u16) -> Option<usize> {
        if !point_in(self.sidebar_area, self.sidebar_area.x, row) {
            return None;
        }
        let inner_y = row.saturating_sub(self.sidebar_area.y.saturating_add(1));
        let rows = self.sidebar_rows();
        match rows.get(inner_y as usize) {
            Some(SidebarRow::Item(i)) => Some(*i),
            _ => None,
        }
    }

    pub fn draw(&mut self, f: &mut Frame) {
        let area = f.area();
        f.render_widget(Block::default().style(theme::base()), area);

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(1),
                Constraint::Min(8),
                Constraint::Length(1),
            ])
            .split(area);

        self.draw_top(f, chunks[0]);

        let body = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Length(30),
                Constraint::Min(40),
                Constraint::Length(36),
            ])
            .split(chunks[1]);

        self.sidebar_area = body[0];
        self.city_area = body[1];
        self.draw_sidebar(f, body[0]);
        self.draw_city(f, body[1]);
        self.draw_right(f, body[2]);
        self.draw_bottom(f, chunks[2]);

        if let Some(pi) = self.inspect_packet {
            if let Some(pkt) = self.packets.get(pi) {
                self.draw_packet_popup(f, pkt);
            }
        } else if let Some(pi) = self.hover_packet {
            if let Some(pkt) = self.packets.get(pi) {
                self.draw_packet_tooltip(f, pkt);
            }
        } else if let Some(idx) = self.hovered.or(Some(self.selected)) {
            if let Some(node) = self.graph.nodes.get(idx) {
                self.draw_node_tooltip(f, node, idx == self.selected && self.hovered.is_none());
            }
        }
    }

    fn draw_top(&self, f: &mut Frame, area: Rect) {
        let m = &self.graph.metrics;
        let title = format!(
            "  {}  v{}   {}   packages {} · crates {} · tools {} · providers {} · models {} · tests {}",
            m.project_name,
            m.version,
            truncate(&self.workspace, 28),
            m.packages,
            m.crates,
            m.tools,
            m.providers,
            m.models,
            m.tests
        );
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(title, theme::title()))),
            area,
        );
    }

    fn draw_sidebar(&self, f: &mut Frame, area: Rect) {
        let block = Block::default()
            .borders(Borders::RIGHT)
            .border_style(Style::default().fg(theme::WIRE_DIM).bg(theme::BG_PANEL))
            .style(theme::panel());
        let inner = block.inner(area);
        f.render_widget(block, area);

        let rows = self.sidebar_rows();
        let mut lines: Vec<Line> = Vec::new();
        for row in rows {
            match row {
                SidebarRow::Header(sec) => {
                    lines.push(Line::from(Span::styled(
                        format!(" {}", sec.label()),
                        theme::header(),
                    )));
                }
                SidebarRow::Item(idx) => {
                    let n = &self.graph.nodes[idx];
                    let badge = if n.count > 0 {
                        format!("{}", n.count)
                    } else {
                        "·".into()
                    };
                    let label = format!(" {}  {:<16} {:>5}", n.code, truncate(&n.name, 16), badge);
                    let style = if idx == self.selected {
                        theme::selected()
                    } else if self.hovered == Some(idx) {
                        theme::focused_item()
                    } else {
                        Style::default().fg(theme::FG).bg(theme::BG_PANEL)
                    };
                    lines.push(Line::from(Span::styled(label, style)));
                }
            }
        }
        f.render_widget(Paragraph::new(lines).style(theme::panel()), inner);
    }

    fn draw_city(&self, f: &mut Frame, area: Rect) {
        let widget = IsoCity {
            graph: &self.graph,
            camera: self.camera,
            selected: Some(self.selected),
            hovered: self.hovered,
            inside: self.inside,
            packets: &self.packets,
            hover_packet: self.hover_packet,
        };
        f.render_widget(widget, area);
    }

    fn draw_right(&self, f: &mut Frame, area: Rect) {
        let block = Block::default()
            .borders(Borders::LEFT)
            .border_style(Style::default().fg(theme::WIRE_DIM).bg(theme::BG_PANEL))
            .style(theme::panel());
        let inner = block.inner(area);
        f.render_widget(block, area);

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(1),
                Constraint::Length(1),
                Constraint::Min(4),
                Constraint::Length(8),
            ])
            .split(inner);

        let titles = RightTab::titles();
        let selected = match self.tab {
            RightTab::What => 0,
            RightTab::How => 1,
        };
        let tabs = Tabs::new(titles)
            .select(selected)
            .style(theme::tab_inactive())
            .highlight_style(theme::tab_active())
            .divider(Span::styled(" │ ", Style::default().fg(theme::FG_DIM)));
        f.render_widget(tabs, chunks[0]);

        let Some(node) = self.graph.nodes.get(self.selected) else {
            return;
        };
        let head = format!(" [{}]  {}", node.code, node.name.to_uppercase());
        f.render_widget(
            Paragraph::new(Span::styled(
                head,
                Style::default()
                    .fg(theme::BEIGE)
                    .bg(theme::BG_PANEL)
                    .add_modifier(Modifier::BOLD),
            )),
            chunks[1],
        );

        let body = match self.tab {
            RightTab::What => node.what.as_str(),
            RightTab::How => node.how.as_str(),
        };
        let mut text = body.to_string();
        let flows = self.graph.neighbors(&node.id);
        if !flows.is_empty() {
            text.push_str("\n\nFLOWS\n");
            for e in flows {
                text.push_str(&format!("  {} → {}  {}\n", e.from, e.to, e.label));
            }
        }
        if !node.paths.is_empty() {
            text.push_str("\nPATHS\n");
            for p in &node.paths {
                text.push_str("  ");
                text.push_str(p);
                text.push('\n');
            }
        }
        f.render_widget(
            Paragraph::new(text)
                .style(Style::default().fg(theme::FG).bg(theme::BG_PANEL))
                .wrap(Wrap { trim: false }),
            chunks[2],
        );

        let mut child_lines = vec![Line::from(Span::styled(" INSIDE", theme::header()))];
        if node.children.is_empty() {
            child_lines.push(Line::from(Span::styled(
                "  (no nested surfaces)",
                theme::muted(),
            )));
        } else {
            for c in &node.children {
                let count = if c.count > 0 {
                    format!(" {}", c.count)
                } else {
                    String::new()
                };
                child_lines.push(Line::from(vec![
                    Span::styled(
                        format!("  {} ", c.code),
                        Style::default().fg(theme::ACCENT).bg(theme::BG_PANEL),
                    ),
                    Span::styled(
                        format!("{}{}", c.name, count),
                        Style::default().fg(theme::FG).bg(theme::BG_PANEL),
                    ),
                ]));
                if !c.note.is_empty() {
                    child_lines.push(Line::from(Span::styled(
                        format!("     {}", c.note),
                        theme::muted(),
                    )));
                }
            }
        }
        f.render_widget(Paragraph::new(child_lines), chunks[3]);
    }

    fn draw_bottom(&self, f: &mut Frame, area: Rect) {
        let node = self
            .graph
            .nodes
            .get(self.selected)
            .map(|n| n.name.as_str())
            .unwrap_or("—");
        let hint = "INSIDE · COME BACK OUT · MOVE · HOVER TO READ · DRAG TO PAN · SCROLL TO ZOOM";
        let left = format!(" {} ", node);
        let line = Line::from(vec![
            Span::styled(left, Style::default().fg(theme::ACCENT).bg(theme::BG)),
            Span::styled(format!(" {hint} "), theme::dim()),
        ]);
        f.render_widget(Paragraph::new(line), area);
    }

    fn draw_packet_popup(&self, f: &mut Frame, pkt: &Packet) {
        let area = f.area();
        let width = 56.min(area.width.saturating_sub(4));
        let height = 8.min(area.height.saturating_sub(4));
        let x = area.x.saturating_add(area.width.saturating_sub(width) / 2);
        let y = area
            .y
            .saturating_add(area.height.saturating_sub(height) / 2);
        let rect = Rect::new(x, y, width, height);
        f.render_widget(Clear, rect);
        let edge = self.graph.edges.get(pkt.edge_idx);
        let title = match edge {
            Some(e) => format!(" PACKET  {} → {} ", e.from, e.to),
            None => " PACKET ".into(),
        };
        let block = Block::default()
            .title(Span::styled(title, theme::title()))
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::BEIGE).bg(theme::BG_RAISED))
            .style(Style::default().fg(theme::FG).bg(theme::BG_RAISED));
        let body = match edge {
            Some(e) => format!("{}\n\n{}\nkind: {:?}", pkt.payload, e.label, e.kind),
            None => pkt.payload.clone(),
        };
        f.render_widget(
            Paragraph::new(body)
                .block(block)
                .wrap(Wrap { trim: true })
                .style(Style::default().fg(theme::FG).bg(theme::BG_RAISED)),
            rect,
        );
    }

    fn draw_packet_tooltip(&self, f: &mut Frame, pkt: &Packet) {
        let area = f.area();
        let edge = self.graph.edges.get(pkt.edge_idx);
        let text = match edge {
            Some(e) => format!("{} → {}  {}", e.from, e.to, pkt.payload),
            None => pkt.payload.clone(),
        };
        let width = ((text.len() as u16) + 4)
            .min(area.width.saturating_sub(2))
            .max(12);
        let height = 3u16;
        let max_x = area.x.saturating_add(area.width.saturating_sub(width));
        let max_y = area.y.saturating_add(area.height.saturating_sub(height));
        let x = (pkt.screen.0 + 2).clamp(area.x as i32, max_x as i32) as u16;
        let y = (pkt.screen.1 - 2).clamp(area.y as i32, max_y as i32) as u16;
        let rect = Rect::new(x, y, width, height);
        f.render_widget(Clear, rect);
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::ACCENT).bg(theme::BG_RAISED))
            .style(Style::default().fg(theme::FG).bg(theme::BG_RAISED));
        f.render_widget(
            Paragraph::new(truncate(&text, width.saturating_sub(2) as usize))
                .block(block)
                .style(Style::default().fg(theme::SELECT).bg(theme::BG_RAISED)),
            rect,
        );
    }

    fn draw_node_tooltip(&self, f: &mut Frame, node: &crate::model::Node, focused: bool) {
        if self.inside == Some(self.selected) && focused {
            return;
        }
        let area = f.area();
        let prefix = if focused { "FOCUS" } else { "HOVER" };
        let text = format!(
            "{}  [{}] {}  ·  {}",
            prefix,
            node.code,
            node.name,
            first_sentence(&node.what)
        );
        let width = ((text.len() as u16) + 4)
            .min(area.width.saturating_sub(2))
            .max(16);
        let height = 3u16;
        let (sx, sy) = iso::node_label_screen(node, &self.camera, self.city_area);
        let max_x = area.x.saturating_add(area.width.saturating_sub(width));
        let max_y = area.y.saturating_add(area.height.saturating_sub(height));
        let x = (sx + 2).clamp(area.x as i32, max_x as i32) as u16;
        let y = (sy - 3).clamp(area.y as i32, max_y as i32) as u16;
        let rect = Rect::new(x, y, width, height);
        f.render_widget(Clear, rect);
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::BEIGE).bg(theme::BG_RAISED))
            .style(Style::default().fg(theme::FG).bg(theme::BG_RAISED));
        f.render_widget(
            Paragraph::new(truncate(&text, width.saturating_sub(2) as usize))
                .block(block)
                .style(Style::default().fg(theme::SELECT).bg(theme::BG_RAISED)),
            rect,
        );
    }
}

enum SidebarRow {
    Header(Section),
    Item(usize),
}

fn point_in(area: Rect, x: u16, y: u16) -> bool {
    x >= area.x && y >= area.y && x < area.x + area.width && y < area.y + area.height
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let mut out: String = s.chars().take(n.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn first_sentence(s: &str) -> String {
    let cut = s.find(". ").unwrap_or(s.len().min(90));
    s[..cut].trim().to_string()
}
