#import "QuiverCrashReporter.h"

#import <execinfo.h>
#import <fcntl.h>
#import <signal.h>
#import <unistd.h>

#import "QuiverFeedbackClient.h"

static NSUInteger const QuiverMaxStoredCrashes = 5;

// Signal handlers cannot allocate; the crash directory path is captured as a
// C string at install time and file names are assembled with the safe
// append helpers below.
static char gQuiverCrashDir[512] = {0};
static NSUncaughtExceptionHandler *gQuiverPreviousExceptionHandler = NULL;

static int const kQuiverFatalSignals[] = {SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGTRAP};
static int const kQuiverFatalSignalCount = sizeof(kQuiverFatalSignals) / sizeof(int);

static NSString *QuiverCrashDirPath(void) {
    NSString *base = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
    return [base stringByAppendingPathComponent:@"quiver/crashes"];
}

static void QuiverWriteMetaFile(NSString *logPath,
                                     NSString *exceptionClass,
                                     NSString *exceptionMessage,
                                     NSString *topFrame,
                                     NSString *reason) {
    NSDictionary *meta = @{
        @"exception_class" : exceptionClass ?: @"IosCrash",
        @"exception_message" : exceptionMessage ?: @"",
        @"top_frame" : topFrame ?: @"",
        @"reason" : reason ?: @"",
        @"crash_at" : @((long long)(NSDate.date.timeIntervalSince1970 * 1000.0)),
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:meta options:0 error:nil];
    NSString *metaPath = [[logPath stringByDeletingPathExtension] stringByAppendingString:@".meta.json"];
    [data writeToFile:metaPath atomically:YES];
}

/// First stack frame that belongs to the app image rather than system
/// libraries — the same "top frame" notion the server groups crashes by.
static NSString *QuiverTopAppFrame(NSArray<NSString *> *frames) {
    NSString *executable = NSProcessInfo.processInfo.processName;
    for (NSString *frame in frames) {
        if (executable.length > 0 && [frame containsString:executable]) {
            return frame;
        }
    }
    return frames.count > 1 ? frames[1] : (frames.firstObject ?: @"");
}

static void QuiverHandleException(NSException *exception) {
    NSString *dir = QuiverCrashDirPath();
    [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    long long ts = (long long)(NSDate.date.timeIntervalSince1970 * 1000.0);
    NSString *logPath = [dir stringByAppendingPathComponent:[NSString stringWithFormat:@"crash-%lld.txt", ts]];

    NSArray<NSString *> *frames = exception.callStackSymbols ?: @[];
    NSMutableString *log = [NSMutableString string];
    [log appendFormat:@"Uncaught exception: %@\n", exception.name ?: @"NSException"];
    [log appendFormat:@"Reason: %@\n\n", exception.reason ?: @""];
    [log appendString:@"Stack:\n"];
    [log appendString:[frames componentsJoinedByString:@"\n"]];
    [log appendString:@"\n"];
    [log writeToFile:logPath atomically:YES encoding:NSUTF8StringEncoding error:nil];

    QuiverWriteMetaFile(logPath,
                             exception.name ?: @"NSException",
                             exception.reason ?: @"",
                             QuiverTopAppFrame(frames),
                             @"uncaught_exception");

    if (gQuiverPreviousExceptionHandler) {
        gQuiverPreviousExceptionHandler(exception);
    }
}

// ---- async-signal-safe primitives (no snprintf/malloc/ObjC in handlers) ----

static size_t QuiverSafeStrLen(const char *text) {
    size_t n = 0;
    while (text[n] != '\0') n++;
    return n;
}

static void QuiverSafeAppend(char *buffer, size_t capacity, size_t *offset, const char *text) {
    size_t n = QuiverSafeStrLen(text);
    if (*offset + n >= capacity) return;
    for (size_t i = 0; i < n; i++) buffer[*offset + i] = text[i];
    *offset += n;
    buffer[*offset] = '\0';
}

static void QuiverSafeAppendNumber(char *buffer, size_t capacity, size_t *offset, long long value) {
    char digits[24];
    int i = 0;
    if (value <= 0) {
        QuiverSafeAppend(buffer, capacity, offset, "0");
        return;
    }
    while (value > 0 && i < 20) {
        digits[i++] = (char)('0' + (value % 10));
        value /= 10;
    }
    char out[24];
    for (int j = 0; j < i; j++) out[j] = digits[i - 1 - j];
    out[i] = '\0';
    QuiverSafeAppend(buffer, capacity, offset, out);
}

/// Async-signal context (task #76): the guaranteed record uses only
/// async-signal-safe calls — time/open/write/close plus local char math.
/// The meta sidecar is written FIRST so a report exists even if the
/// best-effort stack capture at the end deadlocks in a corrupted-runtime
/// crash; backtrace()/backtrace_symbols_fd() are not strictly safe and are
/// deliberately last.
static void QuiverHandleSignal(int signalNumber) {
    if (gQuiverCrashDir[0] == '\0') {
        signal(signalNumber, SIG_DFL);
        raise(signalNumber);
        return;
    }
    const char *name = "SIGNAL";
    switch (signalNumber) {
        case SIGABRT: name = "SIGABRT"; break;
        case SIGSEGV: name = "SIGSEGV"; break;
        case SIGBUS: name = "SIGBUS"; break;
        case SIGILL: name = "SIGILL"; break;
        case SIGFPE: name = "SIGFPE"; break;
        case SIGTRAP: name = "SIGTRAP"; break;
        default: break;
    }
    long long ts = (long long)time(NULL) * 1000LL;

    // Meta sidecar first — the minimal guaranteed record.
    char metaPath[640];
    size_t off = 0;
    QuiverSafeAppend(metaPath, sizeof(metaPath), &off, gQuiverCrashDir);
    QuiverSafeAppend(metaPath, sizeof(metaPath), &off, "/crash-");
    QuiverSafeAppendNumber(metaPath, sizeof(metaPath), &off, ts);
    QuiverSafeAppend(metaPath, sizeof(metaPath), &off, ".meta.json");
    int metaFd = open(metaPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (metaFd >= 0) {
        char meta[256];
        off = 0;
        QuiverSafeAppend(meta, sizeof(meta), &off, "{\"exception_class\":\"");
        QuiverSafeAppend(meta, sizeof(meta), &off, name);
        QuiverSafeAppend(meta, sizeof(meta), &off, "\",\"exception_message\":\"fatal signal\",\"reason\":\"signal\",\"crash_at\":");
        QuiverSafeAppendNumber(meta, sizeof(meta), &off, ts);
        QuiverSafeAppend(meta, sizeof(meta), &off, "}");
        write(metaFd, meta, off);
        close(metaFd);
    }

    // Log file with a fixed header (still fully safe calls only).
    char logPath[640];
    off = 0;
    QuiverSafeAppend(logPath, sizeof(logPath), &off, gQuiverCrashDir);
    QuiverSafeAppend(logPath, sizeof(logPath), &off, "/crash-");
    QuiverSafeAppendNumber(logPath, sizeof(logPath), &off, ts);
    QuiverSafeAppend(logPath, sizeof(logPath), &off, ".txt");
    int logFd = open(logPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (logFd >= 0) {
        char header[96];
        off = 0;
        QuiverSafeAppend(header, sizeof(header), &off, "Fatal signal: ");
        QuiverSafeAppend(header, sizeof(header), &off, name);
        QuiverSafeAppend(header, sizeof(header), &off, "\n\nStack (best-effort):\n");
        write(logFd, header, off);
        // Best-effort, LAST: backtrace can touch unwind/runtime state and is
        // not async-signal-safe; if it hangs or crashes, the record above is
        // already on disk.
        void *frames[64];
        int frameCount = backtrace(frames, 64);
        backtrace_symbols_fd(frames, frameCount, logFd);
        close(logFd);
    }

    signal(signalNumber, SIG_DFL);
    raise(signalNumber);
}

@implementation QuiverCrashReporter

+ (void)install {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSString *dir = QuiverCrashDirPath();
        [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
        [dir getCString:gQuiverCrashDir maxLength:sizeof(gQuiverCrashDir) encoding:NSUTF8StringEncoding];

        gQuiverPreviousExceptionHandler = NSGetUncaughtExceptionHandler();
        NSSetUncaughtExceptionHandler(&QuiverHandleException);
        for (int i = 0; i < kQuiverFatalSignalCount; i++) {
            signal(kQuiverFatalSignals[i], &QuiverHandleSignal);
        }
        [self enforceRetention];
    });
}

+ (void)enforceRetention {
    NSString *dir = QuiverCrashDirPath();
    NSArray<NSString *> *entries = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:dir error:nil];
    NSArray<NSString *> *logs = [[entries filteredArrayUsingPredicate:
        [NSPredicate predicateWithBlock:^BOOL(NSString *name, NSDictionary *bindings) {
            return [name hasPrefix:@"crash-"] && [name hasSuffix:@".txt"];
        }]] sortedArrayUsingSelector:@selector(compare:)];
    if (logs.count < QuiverMaxStoredCrashes) {
        return;
    }
    NSUInteger excess = logs.count - (QuiverMaxStoredCrashes - 1);
    for (NSUInteger i = 0; i < excess; i++) {
        [self deletePairForLogPath:[dir stringByAppendingPathComponent:logs[i]]];
    }
}

+ (void)deletePairForLogPath:(NSString *)logPath {
    NSFileManager *fm = NSFileManager.defaultManager;
    [fm removeItemAtPath:logPath error:nil];
    NSString *metaPath = [[logPath stringByDeletingPathExtension] stringByAppendingString:@".meta.json"];
    [fm removeItemAtPath:metaPath error:nil];
}

+ (void)uploadPendingAfterDelay:(NSTimeInterval)delay {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)),
                   dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        [self uploadPendingNow];
    });
}

+ (void)uploadPendingNow {
    NSString *dir = QuiverCrashDirPath();
    NSArray<NSString *> *entries = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:dir error:nil];
    NSArray<NSString *> *sidecars = [[entries filteredArrayUsingPredicate:
        [NSPredicate predicateWithBlock:^BOOL(NSString *name, NSDictionary *bindings) {
            return [name hasSuffix:@".meta.json"];
        }]] sortedArrayUsingSelector:@selector(compare:)];

    for (NSString *sidecarName in sidecars) {
        NSString *sidecarPath = [dir stringByAppendingPathComponent:sidecarName];
        NSString *logName = [[sidecarName stringByReplacingOccurrencesOfString:@".meta.json"
                                                                    withString:@""] stringByAppendingString:@".txt"];
        NSString *logPath = [dir stringByAppendingPathComponent:logName];
        if (![NSFileManager.defaultManager fileExistsAtPath:logPath]) {
            [NSFileManager.defaultManager removeItemAtPath:sidecarPath error:nil];
            continue;
        }

        NSData *metaData = [NSData dataWithContentsOfFile:sidecarPath];
        NSDictionary *meta = metaData
            ? ([NSJSONSerialization JSONObjectWithData:metaData options:0 error:nil] ?: @{})
            : @{};
        NSString *exceptionClass = [meta[@"exception_class"] isKindOfClass:NSString.class]
            ? meta[@"exception_class"] : @"IosCrash";
        NSString *exceptionMessage = [meta[@"exception_message"] isKindOfClass:NSString.class]
            ? meta[@"exception_message"] : @"";
        NSString *topFrame = [meta[@"top_frame"] isKindOfClass:NSString.class] ? meta[@"top_frame"] : @"";

        NSMutableString *message = [NSMutableString stringWithFormat:@"Crash: %@", exceptionClass];
        if (exceptionMessage.length > 0) {
            [message appendFormat:@": %@", [exceptionMessage substringToIndex:MIN(exceptionMessage.length, (NSUInteger)200)]];
        }
        if (topFrame.length > 0) {
            [message appendFormat:@"\nat %@", topFrame];
        }

        NSDictionary<NSString *, NSString *> *extras = @{
            @"crash_exception_class" : exceptionClass,
            @"crash_top_frame" : topFrame,
            @"crash_reason" : [meta[@"reason"] isKindOfClass:NSString.class] ? meta[@"reason"] : @"",
            @"crash_at" : [NSString stringWithFormat:@"%@", meta[@"crash_at"] ?: @0],
        };

        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        [QuiverFeedbackClient submitWithMessage:message
                                                kind:@"crash"
                                     attachmentPaths:@[ logPath ]
                                              extras:extras
                                          completion:^(NSString *ticketId, NSError *error) {
            if (ticketId.length > 0 && !error) {
                [self deletePairForLogPath:logPath];
                NSLog(@"[Quiver] uploaded crash %@ as %@", logName, [ticketId substringToIndex:MIN(ticketId.length, (NSUInteger)8)]);
            } else {
                NSLog(@"[Quiver] crash upload failed for %@: %@", logName, error.localizedDescription ?: @"unknown");
            }
            dispatch_semaphore_signal(done);
        }];
        dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(60 * NSEC_PER_SEC)));
    }
}

@end
