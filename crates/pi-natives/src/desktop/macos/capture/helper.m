// Persistent capture-only worker: one JSON request line, then a JSON header and
// tightly packed premultiplied RGBA bytes for each requested image. AppKit owns
// the main run loop; no window is created and no temporary image file is used.
#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreVideo/CoreVideo.h>
#include <errno.h>
#include <math.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static BOOL WriteAll(const void *bytes, size_t count) {
	const uint8_t *cursor = bytes;
	while (count) {
		ssize_t written = write(STDOUT_FILENO, cursor, count);
		if (written < 0 && errno == EINTR) continue;
		if (written <= 0) return NO;
		cursor += written;
		count -= (size_t)written;
	}
	return YES;
}

static void Header(NSDictionary *value) {
	NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
	if (!data || !WriteAll(data.bytes, data.length) || !WriteAll("\n", 1)) _exit(74);
}

static void Failure(NSString *code, NSString *message) {
	Header(@{ @"kind": @"error", @"code": code, @"error": message ?: @"Native capture failed" });
}

static void CaptureNext(SCShareableContent *content, NSArray *requests, NSUInteger index,
	uint64_t maxPixels, dispatch_block_t done) API_AVAILABLE(macos(14.0));

static void CaptureNext(SCShareableContent *content, NSArray *requests, NSUInteger index,
	uint64_t maxPixels, dispatch_block_t done) {
	if (index == requests.count) { done(); return; }
	NSDictionary *request = requests[index];
	NSString *kind = request[@"kind"];
	uint32_t identifier = [request[@"id"] unsignedIntValue];
	SCContentFilter *filter = nil;
	CGRect bounds = CGRectZero;
	if ([kind isEqualToString:@"window"]) {
		for (SCWindow *window in content.windows) {
			if (window.windowID != identifier) continue;
			filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
			bounds = window.frame;
			break;
		}
	} else {
		for (SCDisplay *display in content.displays) {
			if (display.displayID != identifier) continue;
			filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
			bounds = display.frame;
			break;
		}
	}
	if (!filter) {
		Failure([kind isEqualToString:@"window"] ? @"WindowNotFound" : @"InvalidTarget", @"Capture target is no longer available");
		done(); return;
	}
	double width = ceil(filter.contentRect.size.width * filter.pointPixelScale);
	double height = ceil(filter.contentRect.size.height * filter.pointPixelScale);
	if (!isfinite(width) || !isfinite(height) || width < 1 || height < 1 ||
		width > UINT32_MAX || height > UINT32_MAX || width * height > maxPixels) {
		Failure(@"CaptureFailed", @"Native screenshot dimensions exceed the safety limit");
		done(); return;
	}
	SCStreamConfiguration *configuration = [SCStreamConfiguration new];
	configuration.width = (size_t)width;
	configuration.height = (size_t)height;
	configuration.pixelFormat = kCVPixelFormatType_32BGRA;
	configuration.colorSpaceName = kCGColorSpaceSRGB;
	configuration.showsCursor = NO;
	configuration.ignoreShadowsSingleWindow = YES;
	configuration.ignoreGlobalClipSingleWindow = YES;
	[SCScreenshotManager captureImageWithFilter:filter configuration:configuration completionHandler:^(CGImageRef image, NSError *error) {
		@autoreleasepool {
			if (error || !image) {
				Failure(error.code == -3801 || error.code == -3803 ? @"PermissionDenied" : @"CaptureFailed",
					error.localizedDescription ?: @"ScreenCaptureKit returned no image");
				done(); return;
			}
			size_t pixelWidth = CGImageGetWidth(image), pixelHeight = CGImageGetHeight(image);
			if (!pixelWidth || !pixelHeight || pixelWidth > UINT32_MAX || pixelHeight > UINT32_MAX ||
				pixelWidth > maxPixels / pixelHeight || pixelWidth > SIZE_MAX / 4 / pixelHeight) {
				Failure(@"CaptureFailed", @"Native screenshot buffer exceeds the safety limit");
				done(); return;
			}
			size_t stride = pixelWidth * 4, length = stride * pixelHeight;
			NSMutableData *pixels = [NSMutableData dataWithLength:length];
			CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
			CGContextRef bitmap = space ? CGBitmapContextCreate(pixels.mutableBytes, pixelWidth, pixelHeight, 8, stride,
				space, kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big) : NULL;
			if (space) CGColorSpaceRelease(space);
			if (!bitmap) {
				Failure(@"CaptureFailed", @"Could not create the screenshot pixel buffer");
				done(); return;
			}
			CGContextDrawImage(bitmap, CGRectMake(0, 0, pixelWidth, pixelHeight), image);
			CGContextRelease(bitmap);
			Header(@{ @"kind": @"frame", @"index": @(index), @"width": @(pixelWidth), @"height": @(pixelHeight),
				@"byteLength": @(length), @"bounds": @{ @"x": @(bounds.origin.x), @"y": @(bounds.origin.y),
					@"width": @(bounds.size.width), @"height": @(bounds.size.height) } });
			if (!WriteAll(pixels.bytes, pixels.length)) _exit(74);
			CaptureNext(content, requests, index + 1, maxPixels, done);
		}
	}];
}

static BOOL HasTargets(SCShareableContent *content, NSArray *requests) API_AVAILABLE(macos(14.0));

static BOOL HasTargets(SCShareableContent *content, NSArray *requests) {
	for (NSDictionary *request in requests) {
		uint32_t identifier = [request[@"id"] unsignedIntValue];
		BOOL found = NO;
		if ([request[@"kind"] isEqualToString:@"window"]) {
			for (SCWindow *window in content.windows) if ((found = window.windowID == identifier)) break;
		} else {
			for (SCDisplay *display in content.displays) if ((found = display.displayID == identifier)) break;
		}
		if (!found) return NO;
	}
	return YES;
}

static void FetchAndCapture(BOOL onScreenOnly, NSArray *requests, uint64_t maxPixels,
	dispatch_block_t done) API_AVAILABLE(macos(14.0));

// The on-screen list is a fraction of the full one, which also holds every
// minimized, other-Space and hidden-app window; the full list is fetched only
// when the on-screen fetch fails or omits a target.
static void FetchAndCapture(BOOL onScreenOnly, NSArray *requests, uint64_t maxPixels, dispatch_block_t done) {
	[SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:onScreenOnly completionHandler:^(SCShareableContent *content, NSError *error) {
		if (onScreenOnly && (error || !content || !HasTargets(content, requests))) {
			FetchAndCapture(NO, requests, maxPixels, done); return;
		}
		if (error || !content) {
			Failure(error.code == -3801 || error.code == -3803 ? @"PermissionDenied" : @"CaptureFailed",
				error.localizedDescription ?: @"ScreenCaptureKit returned no shareable content");
			done(); return;
		}
		CaptureNext(content, requests, 0, maxPixels, done);
	}];
}

static void Request(NSDictionary *request, dispatch_block_t done) {
	NSArray *targets = request[@"requests"];
	NSNumber *limit = request[@"maxPixels"];
	BOOL valid = [targets isKindOfClass:NSArray.class] && targets.count > 0 && targets.count <= 64 &&
		[limit isKindOfClass:NSNumber.class] && limit.unsignedLongLongValue > 0 && limit.unsignedLongLongValue <= 268435456;
	for (id target in valid ? targets : @[]) {
		if (![target isKindOfClass:NSDictionary.class]) { valid = NO; break; }
		id kind = target[@"kind"], identifier = target[@"id"];
		double number = [identifier isKindOfClass:NSNumber.class] ? [identifier doubleValue] : 0;
		if ((![@"window" isEqual:kind] && ![@"display" isEqual:kind]) || number < 1 || number > UINT32_MAX || floor(number) != number) {
			valid = NO; break;
		}
	}
	if (!valid) { Failure(@"InvalidTarget", @"Malformed native capture request"); done(); return; }
	if (!CGPreflightScreenCaptureAccess()) {
		Failure(@"PermissionDenied", @"Screen Recording permission is not granted"); done(); return;
	}
	if (@available(macOS 14.0, *)) {
		FetchAndCapture(YES, targets, limit.unsignedLongLongValue, done);
	} else {
		Failure(@"Unsupported", @"ScreenCaptureKit capture worker requires macOS 14 or later"); done();
	}
}

int main(void) {
	@autoreleasepool {
		signal(SIGPIPE, SIG_IGN);
		[NSApplication sharedApplication];
		[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
		(void)CGMainDisplayID();
		pid_t parent = getppid();
		__attribute__((objc_precise_lifetime)) dispatch_source_t death = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)parent,
			DISPATCH_PROC_EXIT, dispatch_get_main_queue());
		if (death) { dispatch_source_set_event_handler(death, ^{ _exit(0); }); dispatch_resume(death); }
		dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
			char *line = NULL;
			size_t capacity = 0;
			ssize_t length;
			while ((length = getline(&line, &capacity, stdin)) > 0) {
				@autoreleasepool {
					if (length > 65536) { Failure(@"InvalidTarget", @"Native capture request is too large"); break; }
					NSData *data = [NSData dataWithBytes:line length:(NSUInteger)length];
					id request = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
					if (![request isKindOfClass:NSDictionary.class]) { Failure(@"InvalidTarget", @"Invalid capture request JSON"); continue; }
					dispatch_semaphore_t completed = dispatch_semaphore_create(0);
					dispatch_async(dispatch_get_main_queue(), ^{ Request(request, ^{ dispatch_semaphore_signal(completed); }); });
					dispatch_semaphore_wait(completed, DISPATCH_TIME_FOREVER);
				}
			}
			free(line);
			_exit(0);
		});
		[NSApp run];
		return 0;
	}
}
