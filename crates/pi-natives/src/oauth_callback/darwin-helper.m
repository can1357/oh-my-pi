#import <AppKit/AppKit.h>
#import <errno.h>
#import <fcntl.h>
#import <limits.h>
#import <stdint.h>
#import <stdlib.h>
#import <sys/stat.h>
#import <unistd.h>

static const NSTimeInterval kOperationTimeoutSeconds = 120.0;
static int gExitStatus = 0;

static void PrintJSON(id value) {
	NSError *error = nil;
	NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
	if (data == nil) {
		fprintf(stderr, "cannot encode JSON: %s\n", error.localizedDescription.UTF8String);
		exit(70);
	}
	fwrite(data.bytes, 1, data.length, stdout);
	fputc('\n', stdout);
}

static NSDictionary *ApplicationDescription(NSURL *applicationURL) {
	if (applicationURL == nil) return @{ @"status": @"absent" };
	NSBundle *bundle = [NSBundle bundleWithURL:applicationURL];
	NSString *bundleIdentifier = bundle.bundleIdentifier;
	NSString *applicationPath = applicationURL.path;
	if (bundle == nil || bundleIdentifier.length == 0 || applicationPath.length == 0) {
		return @{ @"status": @"unknown" };
	}
	return @{
		@"status": @"found",
		@"appPath": applicationPath,
		@"bundleId": bundleIdentifier,
	};
}

static int QueryScheme(NSString *scheme) {
	NSURL *url = [NSURL URLWithString:[scheme stringByAppendingString:@"://"]];
	if (url == nil) {
		fprintf(stderr, "invalid URL scheme\n");
		return 64;
	}
	PrintJSON(ApplicationDescription([NSWorkspace.sharedWorkspace URLForApplicationToOpenURL:url]));
	return 0;
}

static int ResolveBundleIdentifier(NSString *bundleIdentifier) {
	PrintJSON(ApplicationDescription(
		[NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:bundleIdentifier]));
	return 0;
}

static int SetSchemeHandler(NSString *scheme, NSString *applicationPath) {
	NSURL *applicationURL = [NSURL fileURLWithPath:applicationPath isDirectory:YES];
	__block BOOL finished = NO;
	__block NSError *operationError = nil;
	[NSWorkspace.sharedWorkspace setDefaultApplicationAtURL:applicationURL
		toOpenURLsWithScheme:scheme
		completionHandler:^(NSError *error) {
			operationError = error;
			finished = YES;
		}];

	NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:kOperationTimeoutSeconds];
	while (!finished && deadline.timeIntervalSinceNow > 0) {
		@autoreleasepool {
			[NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode
				beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
		}
	}
	if (!finished) {
		fprintf(stderr, "timed out waiting for macOS default-application selection\n");
		return 75;
	}
	if (operationError != nil) {
		fprintf(stderr, "%s\n", operationError.localizedDescription.UTF8String);
		return 1;
	}
	PrintJSON(@{ @"status": @"ok" });
	return 0;
}

static BOOL WriteAll(int descriptor, const void *bytes, size_t length) {
	const uint8_t *cursor = bytes;
	while (length > 0) {
		ssize_t written = write(descriptor, cursor, length);
		if (written < 0 && errno == EINTR) continue;
		if (written <= 0) return NO;
		cursor += written;
		length -= (size_t)written;
	}
	return YES;
}

static BOOL PublishCallbackURL(NSString *configuredPath, NSString *callback, NSError **resultError) {
	if (![configuredPath isKindOfClass:NSString.class] || configuredPath.length == 0 ||
		!configuredPath.isAbsolutePath) {
		if (resultError != NULL) {
			*resultError = [NSError errorWithDomain:@"dev.omp.oauth-callback" code:1
				userInfo:@{NSLocalizedDescriptionKey:
					@"missing absolute OMPCallbackPath in application Info.plist"}];
		}
		return NO;
	}

	NSString *parent = configuredPath.stringByDeletingLastPathComponent;
	char resolvedParent[PATH_MAX];
	if (realpath(parent.fileSystemRepresentation, resolvedParent) == NULL) {
		if (resultError != NULL) {
			*resultError = [NSError errorWithDomain:NSPOSIXErrorDomain code:errno userInfo:nil];
		}
		return NO;
	}
	struct stat directoryStatus;
	if (lstat(resolvedParent, &directoryStatus) != 0 || !S_ISDIR(directoryStatus.st_mode) ||
		directoryStatus.st_uid != getuid() || (directoryStatus.st_mode & 0077) != 0) {
		if (resultError != NULL) {
			*resultError = [NSError errorWithDomain:@"dev.omp.oauth-callback" code:2
				userInfo:@{NSLocalizedDescriptionKey:
					@"callback directory is not private to the current user"}];
		}
		return NO;
	}

	NSString *resolvedDirectory = [NSString stringWithUTF8String:resolvedParent];
	NSString *resolvedDestination =
		[resolvedDirectory stringByAppendingPathComponent:configuredPath.lastPathComponent];
	NSString *temporaryPath = [resolvedDirectory stringByAppendingPathComponent:
		[NSString stringWithFormat:@".%@.%@.tmp", configuredPath.lastPathComponent,
			NSUUID.UUID.UUIDString]];
	NSData *data = [callback dataUsingEncoding:NSUTF8StringEncoding];
	int descriptor = open(temporaryPath.fileSystemRepresentation,
		O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
	if (descriptor < 0) {
		if (resultError != NULL) {
			*resultError = [NSError errorWithDomain:NSPOSIXErrorDomain code:errno userInfo:nil];
		}
		return NO;
	}

	BOOL success = WriteAll(descriptor, data.bytes, data.length) && fsync(descriptor) == 0;
	int savedError = success ? 0 : errno;
	if (close(descriptor) != 0 && success) {
		success = NO;
		savedError = errno;
	}
	if (success && link(temporaryPath.fileSystemRepresentation,
		resolvedDestination.fileSystemRepresentation) != 0) {
		success = NO;
		savedError = errno;
	}
	unlink(temporaryPath.fileSystemRepresentation);
	if (success) {
		int directoryDescriptor = open(resolvedParent, O_RDONLY);
		if (directoryDescriptor < 0 || fsync(directoryDescriptor) != 0) {
			success = NO;
			savedError = errno;
		}
		if (directoryDescriptor >= 0) close(directoryDescriptor);
	}
	if (!success && resultError != NULL) {
		*resultError = [NSError errorWithDomain:NSPOSIXErrorDomain code:savedError userInfo:nil];
	}
	return success;
}

@interface OMPCallbackDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic) BOOL delivered;
@end

@implementation OMPCallbackDelegate

- (void)publishAndQuit:(NSString *)callback {
	if (self.delivered) return;
	self.delivered = YES;
	NSString *callbackPath = [NSBundle.mainBundle objectForInfoDictionaryKey:@"OMPCallbackPath"];
	NSError *error = nil;
	if (!PublishCallbackURL(callbackPath, callback, &error)) {
		gExitStatus = 1;
		fprintf(stderr, "%s\n", error.localizedDescription.UTF8String);
	}
	[NSApp terminate:nil];
}

- (void)handleGetURLEvent:(NSAppleEventDescriptor *)event
	withReplyEvent:(NSAppleEventDescriptor *)replyEvent {
	(void)replyEvent;
	NSString *callback = [[event paramDescriptorForKeyword:keyDirectObject] stringValue];
	if (callback.length == 0) {
		gExitStatus = 1;
		[NSApp terminate:nil];
		return;
	}
	[self publishAndQuit:callback];
}

- (void)applicationWillFinishLaunching:(NSNotification *)notification {
	(void)notification;
	[NSAppleEventManager.sharedAppleEventManager setEventHandler:self
		andSelector:@selector(handleGetURLEvent:withReplyEvent:)
		forEventClass:kInternetEventClass
		andEventID:kAEGetURL];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
	(void)notification;
	[NSTimer scheduledTimerWithTimeInterval:kOperationTimeoutSeconds repeats:NO
		block:^(NSTimer *timer) {
			(void)timer;
			if (!self.delivered) {
				gExitStatus = 75;
				fprintf(stderr, "timed out waiting for callback URL event\n");
				[NSApp terminate:nil];
			}
		}];
}

- (void)applicationWillTerminate:(NSNotification *)notification {
	(void)notification;
	[NSAppleEventManager.sharedAppleEventManager
		removeEventHandlerForEventClass:kInternetEventClass andEventID:kAEGetURL];
}

@end

static int RunApplication(void) {
	@autoreleasepool {
		NSApplication *application = NSApplication.sharedApplication;
		OMPCallbackDelegate *delegate = [OMPCallbackDelegate new];
		application.delegate = delegate;
		[application setActivationPolicy:NSApplicationActivationPolicyProhibited];
		[application run];
		(void)delegate;
	}
	return gExitStatus;
}

int main(int argc, const char *argv[]) {
	@autoreleasepool {
		NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
		if (argc == 3 && [arguments[1] isEqualToString:@"query"]) {
			return QueryScheme(arguments[2]);
		}
		if (argc == 3 && [arguments[1] isEqualToString:@"resolve"]) {
			return ResolveBundleIdentifier(arguments[2]);
		}
		if (argc == 4 && [arguments[1] isEqualToString:@"set"]) {
			return SetSchemeHandler(arguments[2], arguments[3]);
		}
		if (argc == 4 && [arguments[1] isEqualToString:@"--self-test"]) {
			NSError *error = nil;
			if (!PublishCallbackURL(arguments[2], arguments[3], &error)) {
				fprintf(stderr, "%s\n", error.localizedDescription.UTF8String);
				return 1;
			}
			PrintJSON(@{ @"status": @"ok" });
			return 0;
		}
		if (argc > 1 && ![arguments[1] hasPrefix:@"-psn_"]) {
			fprintf(stderr, "usage: darwin-helper query SCHEME | resolve BUNDLE_ID | "
				"set SCHEME APP_PATH | --self-test CALLBACK_PATH CALLBACK_URL\n");
			return 64;
		}
	}
	return RunApplication();
}
