#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Store-then-send crash reporting for the iOS host (mirrors the Android
/// SDK's QuiverCrash and the OHOS QuiverCrashUploader): at crash time the
/// handler only writes crash-<ts>.txt plus a .meta.json signature sidecar to
/// disk; the next launch uploads each pending crash as a kind=crash Hands
/// ticket and deletes local files on success. Captures uncaught NSExceptions
/// and fatal signals (SIGABRT/SIGSEGV/SIGBUS/SIGILL/SIGFPE/SIGTRAP).

/// Supplies the host app's own diagnostics log files to attach alongside a
/// crash. Invoked on a background queue at crash-upload time (next launch),
/// once per pending crash. `crashAtMillis` is the crash time in Unix epoch
/// milliseconds (matching the ticket's crash_at and the on-disk crash log
/// name), or 0 when unknown — use it to return a per-crash snapshot/slice of
/// the app's logs. Return the absolute paths of the app-owned diagnostics
/// files to attach (e.g. a rolling slock-diagnostics.jsonl plus a
/// slock-diagnostics-summary.txt). Missing paths are skipped; return nil or an
/// empty array to attach nothing. The app only writes and hands over raw file
/// paths — the SDK owns packaging: it bundles the returned files into a single
/// diagnostics-<ts>.zip, caps the total size, and attaches it to the crash
/// ticket. The block must be cheap and non-blocking; do not do heavy work in it.
typedef NSArray<NSString *> *_Nullable (^HandsDiagnosticsProvider)(int64_t crashAtMillis);

@interface HandsCrashReporter : NSObject

/// Install the exception and signal handlers. Call once, as early as
/// possible (app init). Previous NSException handlers are chained.
+ (void)install;

/// Register the app diagnostics provider (see HandsDiagnosticsProvider).
/// Call once during app init, BEFORE -uploadPendingAfterDelay: so pending
/// crashes pick it up. Pass nil to clear. The SDK zips whatever the provider
/// returns and attaches it to each crash ticket; the app never zips.
+ (void)setDiagnosticsProvider:(nullable HandsDiagnosticsProvider)provider;

/// Upload pending crash reports after a delay (off the launch critical
/// path). Safe to call every launch; no-op when nothing is pending.
+ (void)uploadPendingAfterDelay:(NSTimeInterval)delay;

@end

NS_ASSUME_NONNULL_END
