#ifndef HANDS_CRASH_BUILD_H
#define HANDS_CRASH_BUILD_H

// Crash-time build identity (botiverse/hands#858, mirrors Android #587).
//
// A pending crash is uploaded by a later launch, which may be a different
// build. The build that crashed is captured once at install time into static
// buffers, and the crash handlers copy it into the .meta.json sidecar. The
// signal handler only reads these buffers and calls write(): no ObjC, no
// malloc, no locks.
//
// Pure C so the host test (clients/ios/Tests/scripts/test_crash_build.sh) can
// compile it without Xcode.

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
    HandsCrashBuildNameMax = 256,
    HandsCrashBuildCommitMax = 128,
    // Escaped name + escaped commit (up to 6 bytes per input byte) + keys.
    HandsCrashBuildJSONMax = (HandsCrashBuildNameMax + HandsCrashBuildCommitMax) * 6 + 128,
};

/// Largest version code the server keeps exactly (JS Number.MAX_SAFE_INTEGER),
/// the same bound Android uses.
#define HANDS_CRASH_BUILD_MAX_VERSION_CODE 9007199254740991LL

/// Parses a CFBundleVersion the way the uploader's metadata does
/// (-[NSString longLongValue]: optional leading whitespace, then the leading
/// decimal digits; "1.2.3" -> 1). Returns 0 when there are no leading digits
/// or the value is outside 0..HANDS_CRASH_BUILD_MAX_VERSION_CODE.
int HandsCrashBuildParseVersionCode(const char *text, long long *out);

/// Stores the running build. Not async-signal-safe; call from install. NULL,
/// empty or over-long values are stored as unknown (never truncated, so a
/// multi-byte UTF-8 sequence is never split).
void HandsCrashBuildCapture(const char *versionName, const char *versionCode, const char *commit);

/// 1 once HandsCrashBuildCapture has run.
int HandsCrashBuildIsCaptured(void);

/// Captured values; "" when unknown.
const char *HandsCrashBuildVersionName(void);
const char *HandsCrashBuildCommit(void);
/// 1 and *out set when the captured version code is known.
int HandsCrashBuildVersionCode(long long *out);

/// Async-signal-safe. The sidecar fields with a trailing comma, e.g.
/// `"version_name":"1.2","version_code":12,"commit":"abc",`. Unknown values
/// are written as Android #587 does: "" for name/commit, null for the code.
/// Returns "" (length 0) before capture, so the keys are absent.
const char *HandsCrashBuildJSONFields(size_t *length);

#ifdef __cplusplus
}
#endif

#endif
