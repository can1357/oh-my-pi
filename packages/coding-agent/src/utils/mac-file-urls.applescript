-- Returns the POSIX paths of every file URL currently on the macOS
-- pasteboard, one path per line. `pbpaste(1)` only surfaces plain text,
-- EPS, or RTF, so a Finder Cmd+C (which puts only a `public.file-url`
-- representation on the pasteboard) makes `pbpaste` empty.
--
-- Uses NSPasteboard directly rather than Standard Additions' clipboard
-- commands, which can cause LaunchServices to register osascript as a
-- foreground application and flicker the Dock.
use framework "AppKit"

on run
	set output to ""
	set boardItems to current application's NSPasteboard's generalPasteboard()'s pasteboardItems()
	repeat with anItem in boardItems
		set urlText to anItem's stringForType:"public.file-url"
		if urlText is not missing value then
			set fileURL to current application's NSURL's URLWithString:urlText
			if fileURL is not missing value then
				if fileURL's isFileURL() as boolean then
					set output to output & (fileURL's |path|() as text) & linefeed
				end if
			end if
		end if
	end repeat
	return output
end run
