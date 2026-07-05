#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Store-then-send crash reporting for the iOS host (mirrors the Android
/// SDK's QuiverCrash and the OHOS QuiverCrashUploader): at crash time the
/// handler only writes crash-<ts>.txt plus a .meta.json signature sidecar to
/// disk; the next launch uploads each pending crash as a kind=crash Quiver
/// ticket and deletes local files on success. Captures uncaught NSExceptions
/// and fatal signals (SIGABRT/SIGSEGV/SIGBUS/SIGILL/SIGFPE/SIGTRAP).
@interface QuiverCrashReporter : NSObject

/// Install the exception and signal handlers. Call once, as early as
/// possible (app init). Previous NSException handlers are chained.
+ (void)install;

/// Upload pending crash reports after a delay (off the launch critical
/// path). Safe to call every launch; no-op when nothing is pending.
+ (void)uploadPendingAfterDelay:(NSTimeInterval)delay;

@end

NS_ASSUME_NONNULL_END
