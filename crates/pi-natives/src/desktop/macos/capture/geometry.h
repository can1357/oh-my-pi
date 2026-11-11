#pragma once

#include <CoreGraphics/CGGeometry.h>
#include <stdbool.h>

// An on-screen window that lies wholly on `display` is cropped from it at
// `sourceRect` (display-local points). Any other window (spanning displays,
// partly off screen, or not on screen) is captured on its own instead.
static inline bool WindowCaptureDisplay(CGRect window, bool onScreen, CGRect display, CGRect *sourceRect) {
	if (!onScreen || CGRectIsEmpty(window) || !CGRectContainsRect(display, window)) return false;
	*sourceRect = CGRectOffset(window, -display.origin.x, -display.origin.y);
	return true;
}
