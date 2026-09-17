#!/usr/bin/env python3
"""Minimal GTK3 fixture for computer.decide() e2e tests."""

import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gtk  # noqa: E402

APP_ID = "hermes.e2e.decide"
LABELS = sys.argv[1].split(",") if len(sys.argv) > 1 else ["Save", "Cancel"]


def main() -> None:
	Gdk.set_program_class(APP_ID)
	window = Gtk.Window(title="OMP E2E Decide")
	window.set_default_size(480, 240)
	window.set_wmclass("HermesE2E", "HermesE2E")

	box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, margin=24)
	box.add(Gtk.Label(label="OMP E2E Decide"))
	for label in LABELS:
		box.add(Gtk.Button(label=label.strip()))
	window.add(box)
	window.connect("destroy", Gtk.main_quit)
	window.show_all()
	Gtk.main()


if __name__ == "__main__":
	main()
