#pragma once

#include <CoreGraphics/CGGeometry.h>
#include <stdbool.h>

// Keep the largest visible portion; ties retain the first display.
static inline bool WindowCaptureDisplay(CGRect window, bool onScreen, CGRect display,
	CGRect *bounds, CGRect *sourceRect) {
	if (!onScreen) return false;
	CGRect intersection = CGRectIntersection(window, display);
	if (CGRectIsEmpty(intersection) ||
		intersection.size.width * intersection.size.height <= bounds->size.width * bounds->size.height) return false;
	*bounds = intersection;
	*sourceRect = CGRectOffset(intersection, -display.origin.x, -display.origin.y);
	return true;
}
