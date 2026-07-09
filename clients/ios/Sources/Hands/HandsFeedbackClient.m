#import "HandsFeedbackClient.h"

#import "Hands.h"

#import <TargetConditionals.h>
#import <UIKit/UIKit.h>
#import <sys/utsname.h>

#import "HandsDeviceId.h"

static NSString *const HandsErrorDomain = @"Hands";
static NSTimeInterval const HandsRequestTimeout = 30.0;
static NSTimeInterval const HandsUploadTimeout = 120.0;

// Hands iOS SDK version — reported in feedback/crash environment metadata.
// Keep in sync with Hands.podspec on release.
static NSString *const kHandsSDKVersion = @"0.1.5";

// Server-enforced: at most 9 attachments per ticket.
static NSUInteger const HandsMaxAttachments = 9;
// Files up to this size stream inline in the multipart body.
static unsigned long long const HandsMultipartMaxBytes = 10ULL * 1024 * 1024;
// Files up to this size upload via presigned direct-to-R2 PUT.
static unsigned long long const HandsPresignMaxBytes = 200ULL * 1024 * 1024;

static NSString *HandsHardwareModel(void) {
    struct utsname systemInfo;
    if (uname(&systemInfo) != 0) {
        return UIDevice.currentDevice.model ?: @"iOS";
    }
    NSString *machine = [NSString stringWithCString:systemInfo.machine encoding:NSUTF8StringEncoding];
    return machine.length > 0 ? machine : (UIDevice.currentDevice.model ?: @"iOS");
}

static NSString *HandsArch(void) {
#if defined(__arm64__)
    return @"arm64";
#elif defined(__x86_64__)
    return @"x86_64";
#else
    return @"unknown";
#endif
}

static BOOL HandsIsSimulator(void) {
#if TARGET_OS_SIMULATOR
    return YES;
#else
    return NSProcessInfo.processInfo.environment[@"SIMULATOR_DEVICE_NAME"] != nil;
#endif
}

static NSString *HandsThermalState(void) {
    switch (NSProcessInfo.processInfo.thermalState) {
        case NSProcessInfoThermalStateNominal: return @"nominal";
        case NSProcessInfoThermalStateFair: return @"fair";
        case NSProcessInfoThermalStateSerious: return @"serious";
        case NSProcessInfoThermalStateCritical: return @"critical";
    }
    return @"unknown";
}

static NSString *HandsBatteryStateString(UIDeviceBatteryState state) {
    switch (state) {
        case UIDeviceBatteryStateUnplugged: return @"unplugged";
        case UIDeviceBatteryStateCharging: return @"charging";
        case UIDeviceBatteryStateFull: return @"full";
        case UIDeviceBatteryStateUnknown:
        default: return @"unknown";
    }
}

// The app's build git commit, injected into Info.plist at build time. The SDK
// only reports it; the host build is responsible for setting one of these keys
// (preferred: HandsBuildCommit). Returns nil when not injected.
static NSString *HandsBuildCommit(NSDictionary *info) {
    for (NSString *key in @[ @"HandsBuildCommit", @"GitCommit", @"CommitHash" ]) {
        id value = info[key];
        if ([value isKindOfClass:NSString.class] && [(NSString *)value length] > 0) {
            return value;
        }
    }
    return nil;
}

static NSString *HandsContentType(NSString *name) {
    NSString *lower = name.lowercaseString;
    if ([lower hasSuffix:@".png"]) return @"image/png";
    if ([lower hasSuffix:@".jpg"] || [lower hasSuffix:@".jpeg"]) return @"image/jpeg";
    if ([lower hasSuffix:@".webp"]) return @"image/webp";
    if ([lower hasSuffix:@".txt"] || [lower hasSuffix:@".log"]) return @"text/plain";
    if ([lower hasSuffix:@".json"] || [lower hasSuffix:@".jsonl"]) return @"application/json";
    if ([lower hasSuffix:@".zip"]) return @"application/zip";
    return @"application/octet-stream";
}

static unsigned long long HandsFileSize(NSString *path) {
    NSDictionary *attrs = [NSFileManager.defaultManager attributesOfItemAtPath:path error:nil];
    return attrs ? [attrs[NSFileSize] unsignedLongLongValue] : 0;
}

static void HandsAppendFormField(NSMutableData *body, NSString *boundary, NSString *name, NSString *value) {
    NSMutableString *part = [NSMutableString string];
    [part appendFormat:@"--%@\r\n", boundary];
    [part appendFormat:@"Content-Disposition: form-data; name=\"%@\"\r\n", name];
    [part appendString:@"Content-Type: text/plain; charset=utf-8\r\n\r\n"];
    [body appendData:[part dataUsingEncoding:NSUTF8StringEncoding]];
    [body appendData:[value dataUsingEncoding:NSUTF8StringEncoding]];
    [body appendData:[@"\r\n" dataUsingEncoding:NSUTF8StringEncoding]];
}

static NSError *HandsErrorWithMessage(NSInteger code, NSString *detail) {
    return [NSError errorWithDomain:HandsErrorDomain
                               code:code
                           userInfo:@{NSLocalizedDescriptionKey : detail ?: @"unknown error"}];
}

@implementation HandsFeedbackClient

+ (NSDictionary<NSString *, id> *)metadataWithExtras:(NSDictionary<NSString *, NSString *> *)extras {
    NSDictionary *info = NSBundle.mainBundle.infoDictionary ?: @{};
    UIDevice *device = UIDevice.currentDevice;
    NSMutableDictionary<NSString *, id> *metadata = [NSMutableDictionary dictionary];
    NSProcessInfo *process = NSProcessInfo.processInfo;

    // App / build identity
    metadata[@"version_name"] = info[@"CFBundleShortVersionString"] ?: @"";
    metadata[@"version_code"] = @([(info[@"CFBundleVersion"] ?: @"0") longLongValue]);
    metadata[@"bundle_id"] = info[@"CFBundleIdentifier"] ?: @"";
    NSString *commit = HandsBuildCommit(info);
    if (commit) metadata[@"commit"] = commit;
    metadata[@"channel"] = (Hands.config.channel ?: @"");
    metadata[@"quiver_sdk"] = kHandsSDKVersion;

    // Platform / OS
    metadata[@"platform"] = @"ios";
    metadata[@"os"] = device.systemName ?: @"iOS";
    metadata[@"os_version"] = [NSString stringWithFormat:@"%@ %@", device.systemName ?: @"iOS", device.systemVersion ?: @""];
    metadata[@"arch"] = HandsArch();
    metadata[@"locale"] = NSLocale.currentLocale.localeIdentifier ?: @"";
    metadata[@"timezone"] = NSTimeZone.localTimeZone.name ?: @"";
    NSArray<NSString *> *languages = NSLocale.preferredLanguages;
    if (languages.count > 0) {
        metadata[@"preferred_languages"] = [languages componentsJoinedByString:@","];
    }

    // Device
    metadata[@"device_id"] = [HandsDeviceId deviceId];
    metadata[@"device_model"] = HandsHardwareModel();
    metadata[@"device_name"] = device.name ?: @"";
    metadata[@"is_simulator"] = HandsIsSimulator() ? @"true" : @"false";
    CGRect bounds = UIScreen.mainScreen.bounds;
    CGFloat scale = UIScreen.mainScreen.scale;
    metadata[@"screen"] = [NSString stringWithFormat:@"%.0fx%.0f@%.0fx",
                           bounds.size.width * scale, bounds.size.height * scale, scale];

    // Runtime state
    metadata[@"physical_memory"] = @(process.physicalMemory);
    metadata[@"uptime_seconds"] = @((long long)process.systemUptime);
    metadata[@"low_power_mode"] = process.isLowPowerModeEnabled ? @"true" : @"false";
    metadata[@"thermal_state"] = HandsThermalState();
    NSDictionary *fsAttrs = [NSFileManager.defaultManager attributesOfFileSystemForPath:NSHomeDirectory() error:nil];
    if (fsAttrs[NSFileSystemSize]) metadata[@"disk_total"] = fsAttrs[NSFileSystemSize];
    if (fsAttrs[NSFileSystemFreeSize]) metadata[@"disk_free"] = fsAttrs[NSFileSystemFreeSize];
    // Only read battery when the host already enabled monitoring — toggling it
    // is a main-thread-only UIKit mutation and this runs on a background queue
    // during crash upload.
    if (device.batteryMonitoringEnabled) {
        float batteryLevel = device.batteryLevel;
        if (batteryLevel >= 0) metadata[@"battery_level"] = @((int)(batteryLevel * 100));
        metadata[@"battery_state"] = HandsBatteryStateString(device.batteryState);
    }

    // Caller-supplied extras (crash_* fields etc.) override/augment the above.
    [extras enumerateKeysAndObjectsUsingBlock:^(NSString *key, NSString *value, BOOL *stop) {
        metadata[key] = value;
    }];
    return metadata;
}

+ (void)submitWithMessage:(NSString *)message
                     kind:(NSString *)kind
          attachmentPaths:(NSArray<NSString *> *)attachmentPaths
                   extras:(NSDictionary<NSString *, NSString *> *)extras
               completion:(void (^)(NSString *_Nullable, NSError *_Nullable))completion {
    HandsConfig *config = Hands.config;
    if (!config) {
        completion(nil, HandsErrorWithMessage(0, @"Hands not started"));
        return;
    }

    // Cap at 9 and split by size: small files stream inline in the multipart
    // body, large files upload directly to R2 via a presigned PUT first.
    NSMutableArray<NSString *> *inlinePaths = [NSMutableArray array];
    NSMutableArray<NSString *> *largePaths = [NSMutableArray array];
    for (NSString *path in attachmentPaths) {
        if (![NSFileManager.defaultManager fileExistsAtPath:path]) continue;
        if (inlinePaths.count + largePaths.count >= HandsMaxAttachments) break;
        unsigned long long size = HandsFileSize(path);
        if (size == 0) continue;
        if (size > HandsPresignMaxBytes) {
            completion(nil, HandsErrorWithMessage(0, [NSString stringWithFormat:@"attachment %@ exceeds the 200 MB limit", path.lastPathComponent]));
            return;
        }
        if (size > HandsMultipartMaxBytes) {
            [largePaths addObject:path];
        } else {
            [inlinePaths addObject:path];
        }
    }

    NSString *metadataText = [self metadataTextWithExtras:extras];

    if (largePaths.count == 0) {
        [self sendTicketWithMessage:message
                               kind:kind
                       metadataText:metadataText
                        inlinePaths:inlinePaths
                      presignedRefs:@[]
                             config:config
                         completion:completion];
        return;
    }

    [self uploadLargeAttachments:largePaths
                          config:config
                      completion:^(NSArray<NSDictionary *> *_Nullable refs, NSError *_Nullable error) {
        if (error) {
            completion(nil, error);
            return;
        }
        [self sendTicketWithMessage:message
                               kind:kind
                       metadataText:metadataText
                        inlinePaths:inlinePaths
                      presignedRefs:refs
                             config:config
                         completion:completion];
    }];
}

+ (NSString *)metadataTextWithExtras:(NSDictionary<NSString *, NSString *> *)extras {
    NSDictionary *metadata = [self metadataWithExtras:extras];
    NSData *metadataData = [NSJSONSerialization dataWithJSONObject:metadata options:0 error:nil];
    NSString *metadataText = metadataData
        ? [[NSString alloc] initWithData:metadataData encoding:NSUTF8StringEncoding]
        : @"{}";
    return metadataText ?: @"{}";
}

+ (void)sendTicketWithMessage:(NSString *)message
                         kind:(NSString *)kind
                 metadataText:(NSString *)metadataText
                  inlinePaths:(NSArray<NSString *> *)inlinePaths
                presignedRefs:(NSArray<NSDictionary *> *)presignedRefs
                       config:(HandsConfig *)config
                   completion:(void (^)(NSString *_Nullable, NSError *_Nullable))completion {
    NSString *boundary = [NSString stringWithFormat:@"Hands%@", NSUUID.UUID.UUIDString];
    NSMutableData *body = [NSMutableData data];
    HandsAppendFormField(body, boundary, @"message", message ?: @"");
    HandsAppendFormField(body, boundary, @"kind", kind.length > 0 ? kind : @"feedback");
    HandsAppendFormField(body, boundary, @"metadata", metadataText ?: @"{}");

    for (NSString *path in inlinePaths) {
        NSData *fileData = [NSData dataWithContentsOfFile:path];
        if (!fileData) {
            continue;
        }
        NSString *fileName = path.lastPathComponent ?: @"attachment";
        NSMutableString *part = [NSMutableString string];
        [part appendFormat:@"--%@\r\n", boundary];
        [part appendFormat:@"Content-Disposition: form-data; name=\"attachments\"; filename=\"%@\"\r\n", fileName];
        [part appendFormat:@"Content-Type: %@\r\n\r\n", HandsContentType(fileName)];
        [body appendData:[part dataUsingEncoding:NSUTF8StringEncoding]];
        [body appendData:fileData];
        [body appendData:[@"\r\n" dataUsingEncoding:NSUTF8StringEncoding]];
    }

    if (presignedRefs.count > 0) {
        NSData *refsData = [NSJSONSerialization dataWithJSONObject:presignedRefs options:0 error:nil];
        NSString *refsText = refsData ? [[NSString alloc] initWithData:refsData encoding:NSUTF8StringEncoding] : @"[]";
        HandsAppendFormField(body, boundary, @"presigned", refsText ?: @"[]");
    }

    [body appendData:[[NSString stringWithFormat:@"--%@--\r\n", boundary] dataUsingEncoding:NSUTF8StringEncoding]];

    NSString *urlText = [NSString stringWithFormat:@"%@/public/v2/apps/%@/feedback",
                                                   config.baseUrl, config.appSlug];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:urlText]];
    request.HTTPMethod = @"POST";
    request.timeoutInterval = HandsRequestTimeout;
    [request setValue:[NSString stringWithFormat:@"multipart/form-data; boundary=%@", boundary]
        forHTTPHeaderField:@"Content-Type"];
    [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
    [request setValue:(config.clientKey ?: @"") forHTTPHeaderField:@"X-Hands-Client-Key"];
    [request setValue:[HandsDeviceId deviceId] forHTTPHeaderField:@"X-Hands-Device-Id"];

    NSURLSessionUploadTask *task = [NSURLSession.sharedSession
        uploadTaskWithRequest:request
                     fromData:body
            completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                if (error) {
                    completion(nil, error);
                    return;
                }
                NSInteger statusCode = [(NSHTTPURLResponse *)response statusCode];
                NSDictionary *parsed = nil;
                if (data.length > 0) {
                    parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                }
                NSString *ticketId = [parsed isKindOfClass:NSDictionary.class] ? parsed[@"id"] : nil;
                if (statusCode < 200 || statusCode >= 300 || ![ticketId isKindOfClass:NSString.class] || ticketId.length == 0) {
                    NSString *detail = [parsed isKindOfClass:NSDictionary.class] && parsed[@"error"]
                        ? [NSString stringWithFormat:@"%@", parsed[@"error"]]
                        : [NSString stringWithFormat:@"HTTP %ld", (long)statusCode];
                    completion(nil, HandsErrorWithMessage(statusCode, detail));
                    return;
                }
                completion(ticketId, nil);
            }];
    [task resume];
}

/// Presign the whole batch, then PUT each large file to R2 sequentially,
/// returning the `presigned` refs the ticket references.
+ (void)uploadLargeAttachments:(NSArray<NSString *> *)paths
                        config:(HandsConfig *)config
                    completion:(void (^)(NSArray<NSDictionary *> *_Nullable, NSError *_Nullable))completion {
    NSMutableArray<NSDictionary *> *requestFiles = [NSMutableArray array];
    for (NSString *path in paths) {
        NSString *fileName = path.lastPathComponent ?: @"attachment";
        [requestFiles addObject:@{
            @"filename" : fileName,
            @"content_type" : HandsContentType(fileName),
            @"size" : @(HandsFileSize(path)),
        }];
    }
    NSData *presignBody = [NSJSONSerialization dataWithJSONObject:@{@"files" : requestFiles} options:0 error:nil];

    NSString *presignUrl = [NSString stringWithFormat:@"%@/public/v2/apps/%@/feedback/presign",
                                                      config.baseUrl, config.appSlug];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:presignUrl]];
    request.HTTPMethod = @"POST";
    request.timeoutInterval = HandsRequestTimeout;
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
    [request setValue:(config.clientKey ?: @"") forHTTPHeaderField:@"X-Hands-Client-Key"];

    NSURLSessionUploadTask *task = [NSURLSession.sharedSession
        uploadTaskWithRequest:request
                     fromData:(presignBody ?: [NSData data])
            completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                if (error) {
                    completion(nil, error);
                    return;
                }
                NSInteger statusCode = [(NSHTTPURLResponse *)response statusCode];
                NSDictionary *parsed = data.length > 0
                    ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil]
                    : nil;
                NSArray *uploads = [parsed isKindOfClass:NSDictionary.class] ? parsed[@"uploads"] : nil;
                if (statusCode < 200 || statusCode >= 300 || ![uploads isKindOfClass:NSArray.class]) {
                    completion(nil, HandsErrorWithMessage(statusCode, [NSString stringWithFormat:@"presign failed: HTTP %ld", (long)statusCode]));
                    return;
                }
                [self putFileAtIndex:0
                               paths:paths
                             uploads:uploads
                         accumulated:[NSMutableArray array]
                          completion:completion];
            }];
    [task resume];
}

+ (void)putFileAtIndex:(NSUInteger)index
                 paths:(NSArray<NSString *> *)paths
               uploads:(NSArray *)uploads
           accumulated:(NSMutableArray<NSDictionary *> *)refs
            completion:(void (^)(NSArray<NSDictionary *> *_Nullable, NSError *_Nullable))completion {
    if (index >= paths.count) {
        completion(refs, nil);
        return;
    }
    NSString *path = paths[index];
    NSString *fileName = path.lastPathComponent ?: @"attachment";
    NSDictionary *upload = index < uploads.count && [uploads[index] isKindOfClass:NSDictionary.class] ? uploads[index] : nil;
    NSString *uploadUrl = [upload[@"upload_url"] isKindOfClass:NSString.class] ? upload[@"upload_url"] : nil;
    NSString *r2Key = [upload[@"r2_key"] isKindOfClass:NSString.class] ? upload[@"r2_key"] : nil;
    if (uploadUrl.length == 0 || r2Key.length == 0) {
        completion(nil, HandsErrorWithMessage(0, [NSString stringWithFormat:@"presign entry %lu missing upload_url/r2_key", (unsigned long)index]));
        return;
    }

    NSString *contentType = HandsContentType(fileName);
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:uploadUrl]];
    request.HTTPMethod = @"PUT";
    request.timeoutInterval = HandsUploadTimeout;
    // The presigned PUT signs the content-type, so it must match exactly.
    [request setValue:contentType forHTTPHeaderField:@"Content-Type"];

    NSURL *fileURL = [NSURL fileURLWithPath:path];
    NSURLSessionUploadTask *task = [NSURLSession.sharedSession
        uploadTaskWithRequest:request
                     fromFile:fileURL
            completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                if (error) {
                    completion(nil, error);
                    return;
                }
                NSInteger statusCode = [(NSHTTPURLResponse *)response statusCode];
                if (statusCode < 200 || statusCode >= 300) {
                    completion(nil, HandsErrorWithMessage(statusCode, [NSString stringWithFormat:@"R2 upload failed for %@: HTTP %ld", fileName, (long)statusCode]));
                    return;
                }
                [refs addObject:@{
                    @"r2_key" : r2Key,
                    @"filename" : fileName,
                    @"content_type" : contentType,
                    @"size" : @(HandsFileSize(path)),
                }];
                [self putFileAtIndex:index + 1
                               paths:paths
                             uploads:uploads
                         accumulated:refs
                          completion:completion];
            }];
    [task resume];
}

@end
