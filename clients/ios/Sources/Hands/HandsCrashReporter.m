#import "HandsCrashReporter.h"

#import <execinfo.h>
#import <dlfcn.h>
#import <fcntl.h>
#import <mach-o/dyld.h>
#import <mach-o/loader.h>
#import <pthread.h>
#import <signal.h>
#import <stdio.h>
#import <stdint.h>
#import <string.h>
#import <unistd.h>

#import "HandsFeedbackClient.h"

static NSUInteger const HandsMaxStoredCrashes = 5;
enum {
    HandsMaxBinaryImages = 256,
    HandsMaxCrashFrames = 64,
    HandsImagePathMax = 512,
    HandsImageNameMax = 128,
    HandsImageJsonMax = 1536,
};

// Signal handlers cannot allocate; the crash directory path is captured as a
// C string at install time and file names are assembled with the safe
// append helpers below.
static char gHandsCrashDir[512] = {0};
static NSUncaughtExceptionHandler *gHandsPreviousExceptionHandler = NULL;

// App-registered diagnostics provider (see HandsCrashReporter.h). Written
// once at init; read at upload time on a background queue. Guarded by a lock
// so set/get never tears across threads.
static HandsDiagnosticsProvider gHandsDiagnosticsProvider = nil;
static pthread_mutex_t gHandsDiagnosticsProviderLock = PTHREAD_MUTEX_INITIALIZER;

static HandsDiagnosticsProvider HandsCurrentDiagnosticsProvider(void) {
    pthread_mutex_lock(&gHandsDiagnosticsProviderLock);
    HandsDiagnosticsProvider provider = gHandsDiagnosticsProvider;
    pthread_mutex_unlock(&gHandsDiagnosticsProviderLock);
    return provider;
}

typedef struct {
    char uuid[37];
    char path[HandsImagePathMax];
    char name[HandsImageNameMax];
    char json[HandsImageJsonMax];
    uintptr_t loadAddress;
    uintptr_t baseAddress;
    uintptr_t endAddress;
    intptr_t slide;
} HandsBinaryImage;

static HandsBinaryImage gHandsBinaryImages[HandsMaxBinaryImages];
static volatile sig_atomic_t gHandsBinaryImageCount = 0;
static pthread_mutex_t gHandsBinaryImageLock = PTHREAD_MUTEX_INITIALIZER;

static int const kHandsFatalSignals[] = {SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGTRAP};
static int const kHandsFatalSignalCount = sizeof(kHandsFatalSignals) / sizeof(int);

static NSString *HandsCrashDirPath(void) {
    NSString *base = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
    return [base stringByAppendingPathComponent:@"quiver/crashes"];
}

static NSString *HandsStringFromCString(const char *text) {
    return text && text[0] != '\0' ? ([NSString stringWithUTF8String:text] ?: @"") : @"";
}

static NSDictionary *HandsDictionaryFromImage(HandsBinaryImage image) {
    return @{
        @"uuid" : HandsStringFromCString(image.uuid),
        @"load_address" : [NSString stringWithFormat:@"0x%016llx", (unsigned long long)image.loadAddress],
        @"base_address" : [NSString stringWithFormat:@"0x%016llx", (unsigned long long)image.baseAddress],
        @"end_address" : [NSString stringWithFormat:@"0x%016llx", (unsigned long long)image.endAddress],
        @"slide" : [NSString stringWithFormat:@"0x%016llx", (unsigned long long)image.slide],
        @"path" : HandsStringFromCString(image.path),
        @"name" : HandsStringFromCString(image.name),
    };
}

static NSArray<NSDictionary *> *HandsCurrentBinaryImages(void) {
    NSMutableArray<NSDictionary *> *images = [NSMutableArray array];
    pthread_mutex_lock(&gHandsBinaryImageLock);
    int count = (int)gHandsBinaryImageCount;
    for (int i = 0; i < count && i < HandsMaxBinaryImages; i++) {
        [images addObject:HandsDictionaryFromImage(gHandsBinaryImages[i])];
    }
    pthread_mutex_unlock(&gHandsBinaryImageLock);
    return images;
}

static NSArray<NSDictionary *> *HandsFrameAddressesFromReturnAddresses(NSArray<NSNumber *> *returnAddresses) {
    NSMutableArray<NSDictionary *> *frames = [NSMutableArray array];
    NSUInteger maxFrames = MIN(returnAddresses.count, (NSUInteger)HandsMaxCrashFrames);
    for (NSUInteger i = 0; i < maxFrames; i++) {
        unsigned long long address = returnAddresses[i].unsignedLongLongValue;
        if (address == 0) continue;
        [frames addObject:@{
            @"index" : @(i),
            @"address" : [NSString stringWithFormat:@"0x%016llx", address],
        }];
    }
    return frames;
}

static NSString *HandsJSONString(id object) {
    if (!object) return @"";
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
    return data ? ([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"") : @"";
}

static void HandsWriteMetaFile(NSString *logPath,
                                     NSString *exceptionClass,
                                     NSString *exceptionMessage,
                                     NSString *topFrame,
                                     NSString *reason,
                                     NSArray<NSDictionary *> *frames) {
    NSArray<NSDictionary *> *binaryImages = HandsCurrentBinaryImages();
    NSDictionary *meta = @{
        @"exception_class" : exceptionClass ?: @"IosCrash",
        @"exception_message" : exceptionMessage ?: @"",
        @"top_frame" : topFrame ?: @"",
        @"reason" : reason ?: @"",
        @"crash_at" : @((long long)(NSDate.date.timeIntervalSince1970 * 1000.0)),
        @"binary_images" : binaryImages,
        @"frames" : frames ?: @[],
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:meta options:0 error:nil];
    NSString *metaPath = [[logPath stringByDeletingPathExtension] stringByAppendingString:@".meta.json"];
    [data writeToFile:metaPath atomically:YES];
}

/// First stack frame that belongs to the app image rather than system
/// libraries — the same "top frame" notion the server groups crashes by.
static NSString *HandsTopAppFrame(NSArray<NSString *> *frames) {
    NSString *executable = NSProcessInfo.processInfo.processName;
    for (NSString *frame in frames) {
        if (executable.length > 0 && [frame containsString:executable]) {
            return frame;
        }
    }
    return frames.count > 1 ? frames[1] : (frames.firstObject ?: @"");
}

static void HandsHandleException(NSException *exception) {
    NSString *dir = HandsCrashDirPath();
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

    HandsWriteMetaFile(logPath,
                             exception.name ?: @"NSException",
                             exception.reason ?: @"",
                             HandsTopAppFrame(frames),
                             @"uncaught_exception",
                             HandsFrameAddressesFromReturnAddresses(exception.callStackReturnAddresses ?: @[]));

    if (gHandsPreviousExceptionHandler) {
        gHandsPreviousExceptionHandler(exception);
    }
}

// ---- async-signal-safe primitives (no snprintf/malloc/ObjC in handlers) ----

static size_t HandsSafeStrLen(const char *text) {
    size_t n = 0;
    while (text[n] != '\0') n++;
    return n;
}

static void HandsSafeAppend(char *buffer, size_t capacity, size_t *offset, const char *text) {
    size_t n = HandsSafeStrLen(text);
    if (*offset + n >= capacity) return;
    for (size_t i = 0; i < n; i++) buffer[*offset + i] = text[i];
    *offset += n;
    buffer[*offset] = '\0';
}

static void HandsSafeAppendNumber(char *buffer, size_t capacity, size_t *offset, long long value) {
    char digits[24];
    int i = 0;
    if (value <= 0) {
        HandsSafeAppend(buffer, capacity, offset, "0");
        return;
    }
    while (value > 0 && i < 20) {
        digits[i++] = (char)('0' + (value % 10));
        value /= 10;
    }
    char out[24];
    for (int j = 0; j < i; j++) out[j] = digits[i - 1 - j];
    out[i] = '\0';
    HandsSafeAppend(buffer, capacity, offset, out);
}

static void HandsSafeAppendHex(char *buffer, size_t capacity, size_t *offset, uint64_t value) {
    char digits[19];
    int i = 18;
    digits[i--] = '\0';
    if (value == 0) digits[i--] = '0';
    while (value != 0 && i >= 1) {
        static const char alphabet[] = "0123456789abcdef";
        digits[i--] = alphabet[value & 0xf];
        value >>= 4;
    }
    HandsSafeAppend(buffer, capacity, offset, "0x");
    HandsSafeAppend(buffer, capacity, offset, &digits[i + 1]);
}

static void HandsSafeWriteAll(int fd, const char *buffer, size_t length) {
    size_t written = 0;
    while (written < length) {
        ssize_t n = write(fd, buffer + written, length - written);
        if (n <= 0) break;
        written += (size_t)n;
    }
}

static void HandsWriteBinaryImagesJSON(int fd) {
    HandsSafeWriteAll(fd, "\"binary_images\":[", 17);
    int count = (int)gHandsBinaryImageCount;
    if (count > HandsMaxBinaryImages) count = HandsMaxBinaryImages;
    for (int i = 0; i < count; i++) {
        if (i > 0) HandsSafeWriteAll(fd, ",", 1);
        HandsSafeWriteAll(fd, gHandsBinaryImages[i].json, HandsSafeStrLen(gHandsBinaryImages[i].json));
    }
    HandsSafeWriteAll(fd, "]", 1);
}

static void HandsWriteRawFrames(int fd, void **frames, int frameCount) {
    HandsSafeWriteAll(fd, "\n\nHandsFrames:\n", 15);
    int count = frameCount < HandsMaxCrashFrames ? frameCount : HandsMaxCrashFrames;
    for (int i = 0; i < count; i++) {
        char line[48];
        size_t off = 0;
        HandsSafeAppendHex(line, sizeof(line), &off, (uint64_t)(uintptr_t)frames[i]);
        HandsSafeAppend(line, sizeof(line), &off, "\n");
        HandsSafeWriteAll(fd, line, off);
    }
    HandsSafeWriteAll(fd, "EndHandsFrames\n", 15);
}

static BOOL HandsParseHexLine(NSString *line, unsigned long long *value) {
    NSString *trimmed = [line stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (![trimmed hasPrefix:@"0x"] || trimmed.length <= 2) return NO;
    NSScanner *scanner = [NSScanner scannerWithString:[trimmed substringFromIndex:2]];
    unsigned long long parsed = 0;
    if (![scanner scanHexLongLong:&parsed]) return NO;
    if (!scanner.isAtEnd) return NO;
    if (value) *value = parsed;
    return YES;
}

static NSArray<NSDictionary *> *HandsFramesFromLogFile(NSString *logPath) {
    NSString *text = [NSString stringWithContentsOfFile:logPath encoding:NSUTF8StringEncoding error:nil];
    if (text.length == 0) return @[];
    NSMutableArray<NSDictionary *> *frames = [NSMutableArray array];
    BOOL inFrames = NO;
    NSArray<NSString *> *lines = [text componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet];
    for (NSString *line in lines) {
        if ([line isEqualToString:@"HandsFrames:"]) {
            inFrames = YES;
            continue;
        }
        if ([line isEqualToString:@"EndHandsFrames"]) {
            break;
        }
        if (!inFrames) continue;
        unsigned long long address = 0;
        if (!HandsParseHexLine(line, &address) || address == 0) continue;
        [frames addObject:@{
            @"index" : @(frames.count),
            @"address" : [NSString stringWithFormat:@"0x%016llx", address],
        }];
        if (frames.count >= (NSUInteger)HandsMaxCrashFrames) break;
    }
    return frames;
}

static void HandsFormatUUID(const uint8_t uuid[16], char out[37]) {
    snprintf(out, 37,
             "%02X%02X%02X%02X-%02X%02X-%02X%02X-%02X%02X-%02X%02X%02X%02X%02X%02X",
             uuid[0], uuid[1], uuid[2], uuid[3],
             uuid[4], uuid[5],
             uuid[6], uuid[7],
             uuid[8], uuid[9],
             uuid[10], uuid[11], uuid[12], uuid[13], uuid[14], uuid[15]);
}

static BOOL HandsReadMachOInfo(const struct mach_header *header,
                                intptr_t slide,
                                char uuid[37],
                                uintptr_t *baseAddress,
                                uintptr_t *endAddress) {
    if (!header) return NO;
    const struct mach_header_64 *header64 = (const struct mach_header_64 *)header;
    const uint8_t *cursor = NULL;
    uint32_t commandCount = 0;
    if (header->magic == MH_MAGIC_64 || header->magic == MH_CIGAM_64) {
        cursor = (const uint8_t *)(header64 + 1);
        commandCount = header64->ncmds;
    } else if (header->magic == MH_MAGIC || header->magic == MH_CIGAM) {
        cursor = (const uint8_t *)(header + 1);
        commandCount = header->ncmds;
    } else {
        return NO;
    }

    BOOL foundUUID = NO;
    uintptr_t minAddress = UINTPTR_MAX;
    uintptr_t maxAddress = 0;
    for (uint32_t i = 0; i < commandCount; i++) {
        const struct load_command *cmd = (const struct load_command *)cursor;
        if (cmd->cmd == LC_UUID) {
            const struct uuid_command *uuidCmd = (const struct uuid_command *)cmd;
            HandsFormatUUID(uuidCmd->uuid, uuid);
            foundUUID = YES;
        } else if (cmd->cmd == LC_SEGMENT_64 && cmd->cmdsize >= sizeof(struct segment_command_64)) {
            const struct segment_command_64 *segment = (const struct segment_command_64 *)cmd;
            if (segment->vmsize > 0 && strcmp(segment->segname, "__PAGEZERO") != 0) {
                uintptr_t start = (uintptr_t)(segment->vmaddr + slide);
                uintptr_t end = (uintptr_t)(segment->vmaddr + segment->vmsize + slide);
                if (start < minAddress) minAddress = start;
                if (end > maxAddress) maxAddress = end;
            }
        } else if (cmd->cmd == LC_SEGMENT && cmd->cmdsize >= sizeof(struct segment_command)) {
            const struct segment_command *segment = (const struct segment_command *)cmd;
            if (segment->vmsize > 0 && strcmp(segment->segname, "__PAGEZERO") != 0) {
                uintptr_t start = (uintptr_t)(segment->vmaddr + slide);
                uintptr_t end = (uintptr_t)(segment->vmaddr + segment->vmsize + slide);
                if (start < minAddress) minAddress = start;
                if (end > maxAddress) maxAddress = end;
            }
        }
        if (cmd->cmdsize == 0) break;
        cursor += cmd->cmdsize;
    }
    if (minAddress == UINTPTR_MAX) minAddress = (uintptr_t)header;
    if (maxAddress == 0) maxAddress = minAddress;
    if (baseAddress) *baseAddress = minAddress;
    if (endAddress) *endAddress = maxAddress;
    return foundUUID;
}

static void HandsCopyCString(const char *input, char *output, size_t capacity) {
    if (capacity == 0) return;
    size_t off = 0;
    for (; input && input[off] != '\0' && off + 1 < capacity; off++) {
        output[off] = input[off];
    }
    output[off] = '\0';
}

static void HandsCopyEscapedJSONString(const char *input, char *output, size_t capacity) {
    size_t off = 0;
    for (size_t i = 0; input && input[i] != '\0' && off + 1 < capacity; i++) {
        unsigned char ch = (unsigned char)input[i];
        if ((ch == '"' || ch == '\\') && off + 2 < capacity) {
            output[off++] = '\\';
            output[off++] = (char)ch;
        } else if (ch >= 0x20) {
            output[off++] = (char)ch;
        }
    }
    output[off] = '\0';
}

static void HandsCacheBinaryImage(const struct mach_header *header, intptr_t slide) {
    if (!header) return;
    HandsBinaryImage image;
    memset(&image, 0, sizeof(image));
    uintptr_t baseAddress = 0;
    uintptr_t endAddress = 0;
    if (!HandsReadMachOInfo(header, slide, image.uuid, &baseAddress, &endAddress)) {
        return;
    }
    Dl_info info;
    memset(&info, 0, sizeof(info));
    if (dladdr(header, &info) != 0 && info.dli_fname) {
        HandsCopyCString(info.dli_fname, image.path, sizeof(image.path));
        const char *slash = strrchr(info.dli_fname, '/');
        HandsCopyCString(slash ? slash + 1 : info.dli_fname, image.name, sizeof(image.name));
    }
    image.loadAddress = (uintptr_t)header;
    image.baseAddress = baseAddress;
    image.endAddress = endAddress;
    image.slide = slide;
    char escapedPath[HandsImagePathMax * 2];
    char escapedName[HandsImageNameMax * 2];
    HandsCopyEscapedJSONString(image.path, escapedPath, sizeof(escapedPath));
    HandsCopyEscapedJSONString(image.name, escapedName, sizeof(escapedName));
    snprintf(image.json, sizeof(image.json),
             "{\"uuid\":\"%s\",\"load_address\":\"0x%016llx\",\"base_address\":\"0x%016llx\",\"end_address\":\"0x%016llx\",\"slide\":\"0x%016llx\",\"path\":\"%s\",\"name\":\"%s\"}",
             image.uuid,
             (unsigned long long)image.loadAddress,
             (unsigned long long)image.baseAddress,
             (unsigned long long)image.endAddress,
             (unsigned long long)image.slide,
             escapedPath,
             escapedName);

    pthread_mutex_lock(&gHandsBinaryImageLock);
    int count = (int)gHandsBinaryImageCount;
    if (count < HandsMaxBinaryImages) {
        gHandsBinaryImages[count] = image;
        gHandsBinaryImageCount = count + 1;
    }
    pthread_mutex_unlock(&gHandsBinaryImageLock);
}

static void HandsDyldAddImageCallback(const struct mach_header *header, intptr_t slide) {
    HandsCacheBinaryImage(header, slide);
}

static void HandsInstallBinaryImageCache(void) {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        _dyld_register_func_for_add_image(&HandsDyldAddImageCallback);
    });
}

/// Async-signal context (task #76): the guaranteed record uses only
/// async-signal-safe calls — time/open/write/close plus local char math.
/// The meta sidecar is written FIRST so a report exists even if the
/// best-effort stack capture at the end deadlocks in a corrupted-runtime
/// crash; backtrace()/backtrace_symbols_fd() are not strictly safe and are
/// deliberately last.
static void HandsHandleSignal(int signalNumber) {
    if (gHandsCrashDir[0] == '\0') {
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
    HandsSafeAppend(metaPath, sizeof(metaPath), &off, gHandsCrashDir);
    HandsSafeAppend(metaPath, sizeof(metaPath), &off, "/crash-");
    HandsSafeAppendNumber(metaPath, sizeof(metaPath), &off, ts);
    HandsSafeAppend(metaPath, sizeof(metaPath), &off, ".meta.json");
    int metaFd = open(metaPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (metaFd >= 0) {
        char meta[256];
        off = 0;
        HandsSafeAppend(meta, sizeof(meta), &off, "{\"exception_class\":\"");
        HandsSafeAppend(meta, sizeof(meta), &off, name);
        HandsSafeAppend(meta, sizeof(meta), &off, "\",\"exception_message\":\"fatal signal\",\"reason\":\"signal\",\"crash_at\":");
        HandsSafeAppendNumber(meta, sizeof(meta), &off, ts);
        HandsSafeAppend(meta, sizeof(meta), &off, ",");
        HandsSafeWriteAll(metaFd, meta, off);
        HandsWriteBinaryImagesJSON(metaFd);
        HandsSafeWriteAll(metaFd, ",\"frames\":[]}", 13);
        close(metaFd);
    }

    // Log file with a fixed header (still fully safe calls only).
    char logPath[640];
    off = 0;
    HandsSafeAppend(logPath, sizeof(logPath), &off, gHandsCrashDir);
    HandsSafeAppend(logPath, sizeof(logPath), &off, "/crash-");
    HandsSafeAppendNumber(logPath, sizeof(logPath), &off, ts);
    HandsSafeAppend(logPath, sizeof(logPath), &off, ".txt");
    int logFd = open(logPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (logFd >= 0) {
        char header[96];
        off = 0;
        HandsSafeAppend(header, sizeof(header), &off, "Fatal signal: ");
        HandsSafeAppend(header, sizeof(header), &off, name);
        HandsSafeAppend(header, sizeof(header), &off, "\n\nStack (best-effort):\n");
        write(logFd, header, off);
        // Best-effort, LAST: backtrace can touch unwind/runtime state and is
        // not async-signal-safe; if it hangs or crashes, the record above is
        // already on disk.
        void *frames[64];
        int frameCount = backtrace(frames, 64);
        HandsWriteRawFrames(logFd, frames, frameCount);
        backtrace_symbols_fd(frames, frameCount, logFd);
        close(logFd);
    }

    signal(signalNumber, SIG_DFL);
    raise(signalNumber);
}

// Bundles the app-provided diagnostics files into a single zip for upload.
// The app hands over raw file paths; the SDK owns packaging. Returns the zip
// path (inside a fresh temp dir the caller cleans up) or nil when there is
// nothing to attach. Runs at upload time (next launch), not in the crash
// handler, so ordinary Foundation APIs are safe. NSFileCoordinator's
// forUploading option is the dependency-free way to produce a real .zip on
// iOS: coordinated-reading a directory yields a zipped copy.
static NSString *HandsZipDiagnostics(NSArray<NSString *> *paths, NSString *stamp) {
    if (![paths isKindOfClass:NSArray.class] || paths.count == 0) return nil;
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *stageRoot = [NSTemporaryDirectory()
        stringByAppendingPathComponent:[@"hands-diag-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    NSString *stageDir = [stageRoot stringByAppendingPathComponent:@"diagnostics"];
    if (![fm createDirectoryAtPath:stageDir withIntermediateDirectories:YES attributes:nil error:nil]) {
        return nil;
    }

    NSUInteger staged = 0;
    for (NSString *path in paths) {
        if (![path isKindOfClass:NSString.class] || path.length == 0) continue;
        BOOL isDir = NO;
        if (![fm fileExistsAtPath:path isDirectory:&isDir] || isDir) continue;
        NSString *name = path.lastPathComponent;
        NSString *dest = [stageDir stringByAppendingPathComponent:name];
        for (NSUInteger n = 1; [fm fileExistsAtPath:dest]; n++) {
            NSString *ext = name.pathExtension;
            NSString *base = name.stringByDeletingPathExtension;
            NSString *alt = ext.length > 0
                ? [NSString stringWithFormat:@"%@-%lu.%@", base, (unsigned long)n, ext]
                : [NSString stringWithFormat:@"%@-%lu", base, (unsigned long)n];
            dest = [stageDir stringByAppendingPathComponent:alt];
        }
        if ([fm copyItemAtPath:path toPath:dest error:nil]) staged++;
    }
    if (staged == 0) {
        [fm removeItemAtPath:stageRoot error:nil];
        return nil;
    }

    __block NSString *zipPath = nil;
    NSFileCoordinator *coordinator = [[NSFileCoordinator alloc] initWithFilePresenter:nil];
    NSError *coordError = nil;
    [coordinator coordinateReadingItemAtURL:[NSURL fileURLWithPath:stageDir]
                                    options:NSFileCoordinatorReadingForUploading
                                      error:&coordError
                                 byAccessor:^(NSURL *zippedURL) {
        NSString *dest = [stageRoot stringByAppendingPathComponent:
            [NSString stringWithFormat:@"diagnostics-%@.zip", stamp.length > 0 ? stamp : @"crash"]];
        if ([fm copyItemAtPath:zippedURL.path toPath:dest error:nil]) {
            zipPath = dest;
        }
    }];

    [fm removeItemAtPath:stageDir error:nil];
    if (!zipPath) {
        [fm removeItemAtPath:stageRoot error:nil];
    }
    return zipPath;
}

@implementation HandsCrashReporter

+ (void)install {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSString *dir = HandsCrashDirPath();
        [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
        [dir getCString:gHandsCrashDir maxLength:sizeof(gHandsCrashDir) encoding:NSUTF8StringEncoding];
        HandsInstallBinaryImageCache();

        gHandsPreviousExceptionHandler = NSGetUncaughtExceptionHandler();
        NSSetUncaughtExceptionHandler(&HandsHandleException);
        for (int i = 0; i < kHandsFatalSignalCount; i++) {
            signal(kHandsFatalSignals[i], &HandsHandleSignal);
        }
        [self enforceRetention];
    });
}

+ (void)enforceRetention {
    NSString *dir = HandsCrashDirPath();
    NSArray<NSString *> *entries = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:dir error:nil];
    NSArray<NSString *> *logs = [[entries filteredArrayUsingPredicate:
        [NSPredicate predicateWithBlock:^BOOL(NSString *name, NSDictionary *bindings) {
            return [name hasPrefix:@"crash-"] && [name hasSuffix:@".txt"];
        }]] sortedArrayUsingSelector:@selector(compare:)];
    if (logs.count < HandsMaxStoredCrashes) {
        return;
    }
    NSUInteger excess = logs.count - (HandsMaxStoredCrashes - 1);
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

+ (void)setDiagnosticsProvider:(HandsDiagnosticsProvider)provider {
    pthread_mutex_lock(&gHandsDiagnosticsProviderLock);
    gHandsDiagnosticsProvider = [provider copy];
    pthread_mutex_unlock(&gHandsDiagnosticsProviderLock);
}

+ (void)uploadPendingAfterDelay:(NSTimeInterval)delay {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)),
                   dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        [self uploadPendingNow];
    });
}

+ (void)uploadPendingNow {
    NSString *dir = HandsCrashDirPath();
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
        NSArray *binaryImages = [meta[@"binary_images"] isKindOfClass:NSArray.class] ? meta[@"binary_images"] : @[];
        NSArray *frameAddresses = [meta[@"frames"] isKindOfClass:NSArray.class] ? meta[@"frames"] : @[];
        if (frameAddresses.count == 0) {
            frameAddresses = HandsFramesFromLogFile(logPath);
        }

        NSMutableString *message = [NSMutableString stringWithFormat:@"Crash: %@", exceptionClass];
        if (exceptionMessage.length > 0) {
            [message appendFormat:@": %@", [exceptionMessage substringToIndex:MIN(exceptionMessage.length, (NSUInteger)200)]];
        }
        if (topFrame.length > 0) {
            [message appendFormat:@"\nat %@", topFrame];
        }

        NSMutableDictionary<NSString *, NSString *> *extras = [@{
            @"crash_exception_class" : exceptionClass,
            @"crash_top_frame" : topFrame,
            @"crash_reason" : [meta[@"reason"] isKindOfClass:NSString.class] ? meta[@"reason"] : @"",
            @"crash_at" : [NSString stringWithFormat:@"%@", meta[@"crash_at"] ?: @0],
        } mutableCopy];
        NSString *binaryImagesJSON = HandsJSONString(binaryImages);
        if (binaryImagesJSON.length > 0) {
            extras[@"crash_binary_images"] = binaryImagesJSON;
        }
        NSString *framesJSON = HandsJSONString(frameAddresses);
        if (framesJSON.length > 0) {
            extras[@"crash_frames"] = framesJSON;
        }

        // Attach app-owned diagnostics (if a provider is registered): the app
        // hands over raw file paths, the SDK zips them into a single
        // diagnostics-<stamp>.zip alongside the crash log.
        NSMutableArray<NSString *> *attachmentPaths = [NSMutableArray arrayWithObject:logPath];
        NSString *diagnosticsZip = nil;
        HandsDiagnosticsProvider diagnosticsProvider = HandsCurrentDiagnosticsProvider();
        if (diagnosticsProvider) {
            int64_t crashAtMillis = [meta[@"crash_at"] isKindOfClass:NSNumber.class]
                ? [meta[@"crash_at"] longLongValue] : 0;
            NSArray<NSString *> *diagnosticsPaths = nil;
            @try {
                diagnosticsPaths = diagnosticsProvider(crashAtMillis);
            } @catch (NSException *exception) {
                NSLog(@"[Hands] diagnostics provider threw: %@", exception.reason ?: exception.name);
                diagnosticsPaths = nil;
            }
            NSString *stamp = [[logName stringByReplacingOccurrencesOfString:@"crash-" withString:@""]
                stringByReplacingOccurrencesOfString:@".txt" withString:@""];
            diagnosticsZip = HandsZipDiagnostics(diagnosticsPaths, stamp);
            if (diagnosticsZip) {
                [attachmentPaths addObject:diagnosticsZip];
            }
        }

        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        [HandsFeedbackClient submitWithMessage:message
                                                kind:@"crash"
                                     attachmentPaths:attachmentPaths
                                              extras:extras
                                          completion:^(NSString *ticketId, NSError *error) {
            if (ticketId.length > 0 && !error) {
                [self deletePairForLogPath:logPath];
                NSLog(@"[Hands] uploaded crash %@ as %@", logName, [ticketId substringToIndex:MIN(ticketId.length, (NSUInteger)8)]);
            } else {
                NSLog(@"[Hands] crash upload failed for %@: %@", logName, error.localizedDescription ?: @"unknown");
            }
            dispatch_semaphore_signal(done);
        }];
        dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(60 * NSEC_PER_SEC)));

        // The zip lives in a throwaway temp dir; remove it whether or not the
        // upload succeeded (the crash log itself is retained on failure so the
        // next launch retries).
        if (diagnosticsZip) {
            [NSFileManager.defaultManager removeItemAtPath:diagnosticsZip.stringByDeletingLastPathComponent error:nil];
        }
    }
}

@end
