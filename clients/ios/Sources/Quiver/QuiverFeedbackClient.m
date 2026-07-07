#import "QuiverFeedbackClient.h"

#import "Quiver.h"

#import <UIKit/UIKit.h>
#import <sys/utsname.h>

#import "QuiverDeviceId.h"

static NSString *const QuiverErrorDomain = @"Quiver";
static NSTimeInterval const QuiverRequestTimeout = 30.0;
static NSTimeInterval const QuiverUploadTimeout = 120.0;

// Server-enforced: at most 9 attachments per ticket.
static NSUInteger const QuiverMaxAttachments = 9;
// Files up to this size stream inline in the multipart body.
static unsigned long long const QuiverMultipartMaxBytes = 10ULL * 1024 * 1024;
// Files up to this size upload via presigned direct-to-R2 PUT.
static unsigned long long const QuiverPresignMaxBytes = 200ULL * 1024 * 1024;

static NSString *QuiverHardwareModel(void) {
    struct utsname systemInfo;
    if (uname(&systemInfo) != 0) {
        return UIDevice.currentDevice.model ?: @"iOS";
    }
    NSString *machine = [NSString stringWithCString:systemInfo.machine encoding:NSUTF8StringEncoding];
    return machine.length > 0 ? machine : (UIDevice.currentDevice.model ?: @"iOS");
}

static NSString *QuiverArch(void) {
#if defined(__arm64__)
    return @"arm64";
#elif defined(__x86_64__)
    return @"x86_64";
#else
    return @"unknown";
#endif
}

static NSString *QuiverContentType(NSString *name) {
    NSString *lower = name.lowercaseString;
    if ([lower hasSuffix:@".png"]) return @"image/png";
    if ([lower hasSuffix:@".jpg"] || [lower hasSuffix:@".jpeg"]) return @"image/jpeg";
    if ([lower hasSuffix:@".webp"]) return @"image/webp";
    if ([lower hasSuffix:@".txt"] || [lower hasSuffix:@".log"]) return @"text/plain";
    if ([lower hasSuffix:@".json"] || [lower hasSuffix:@".jsonl"]) return @"application/json";
    if ([lower hasSuffix:@".zip"]) return @"application/zip";
    return @"application/octet-stream";
}

static unsigned long long QuiverFileSize(NSString *path) {
    NSDictionary *attrs = [NSFileManager.defaultManager attributesOfItemAtPath:path error:nil];
    return attrs ? [attrs[NSFileSize] unsignedLongLongValue] : 0;
}

static void QuiverAppendFormField(NSMutableData *body, NSString *boundary, NSString *name, NSString *value) {
    NSMutableString *part = [NSMutableString string];
    [part appendFormat:@"--%@\r\n", boundary];
    [part appendFormat:@"Content-Disposition: form-data; name=\"%@\"\r\n", name];
    [part appendString:@"Content-Type: text/plain; charset=utf-8\r\n\r\n"];
    [body appendData:[part dataUsingEncoding:NSUTF8StringEncoding]];
    [body appendData:[value dataUsingEncoding:NSUTF8StringEncoding]];
    [body appendData:[@"\r\n" dataUsingEncoding:NSUTF8StringEncoding]];
}

static NSError *QuiverErrorWithMessage(NSInteger code, NSString *detail) {
    return [NSError errorWithDomain:QuiverErrorDomain
                               code:code
                           userInfo:@{NSLocalizedDescriptionKey : detail ?: @"unknown error"}];
}

@implementation QuiverFeedbackClient

+ (NSDictionary<NSString *, id> *)metadataWithExtras:(NSDictionary<NSString *, NSString *> *)extras {
    NSDictionary *info = NSBundle.mainBundle.infoDictionary ?: @{};
    UIDevice *device = UIDevice.currentDevice;
    NSMutableDictionary<NSString *, id> *metadata = [NSMutableDictionary dictionary];
    metadata[@"version_name"] = info[@"CFBundleShortVersionString"] ?: @"";
    metadata[@"version_code"] = @([(info[@"CFBundleVersion"] ?: @"0") longLongValue]);
    metadata[@"channel"] = (Quiver.config.channel ?: @"");
    metadata[@"device_id"] = [QuiverDeviceId deviceId];
    metadata[@"device_model"] = QuiverHardwareModel();
    metadata[@"os_version"] = [NSString stringWithFormat:@"%@ %@", device.systemName ?: @"iOS", device.systemVersion ?: @""];
    metadata[@"arch"] = QuiverArch();
    metadata[@"locale"] = NSLocale.currentLocale.localeIdentifier ?: @"";
    metadata[@"platform"] = @"ios";
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
    QuiverConfig *config = Quiver.config;
    if (!config) {
        completion(nil, QuiverErrorWithMessage(0, @"Quiver not started"));
        return;
    }

    // Cap at 9 and split by size: small files stream inline in the multipart
    // body, large files upload directly to R2 via a presigned PUT first.
    NSMutableArray<NSString *> *inlinePaths = [NSMutableArray array];
    NSMutableArray<NSString *> *largePaths = [NSMutableArray array];
    for (NSString *path in attachmentPaths) {
        if (![NSFileManager.defaultManager fileExistsAtPath:path]) continue;
        if (inlinePaths.count + largePaths.count >= QuiverMaxAttachments) break;
        unsigned long long size = QuiverFileSize(path);
        if (size == 0) continue;
        if (size > QuiverPresignMaxBytes) {
            completion(nil, QuiverErrorWithMessage(0, [NSString stringWithFormat:@"attachment %@ exceeds the 200 MB limit", path.lastPathComponent]));
            return;
        }
        if (size > QuiverMultipartMaxBytes) {
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
                       config:(QuiverConfig *)config
                   completion:(void (^)(NSString *_Nullable, NSError *_Nullable))completion {
    NSString *boundary = [NSString stringWithFormat:@"Quiver%@", NSUUID.UUID.UUIDString];
    NSMutableData *body = [NSMutableData data];
    QuiverAppendFormField(body, boundary, @"message", message ?: @"");
    QuiverAppendFormField(body, boundary, @"kind", kind.length > 0 ? kind : @"feedback");
    QuiverAppendFormField(body, boundary, @"metadata", metadataText ?: @"{}");

    for (NSString *path in inlinePaths) {
        NSData *fileData = [NSData dataWithContentsOfFile:path];
        if (!fileData) {
            continue;
        }
        NSString *fileName = path.lastPathComponent ?: @"attachment";
        NSMutableString *part = [NSMutableString string];
        [part appendFormat:@"--%@\r\n", boundary];
        [part appendFormat:@"Content-Disposition: form-data; name=\"attachments\"; filename=\"%@\"\r\n", fileName];
        [part appendFormat:@"Content-Type: %@\r\n\r\n", QuiverContentType(fileName)];
        [body appendData:[part dataUsingEncoding:NSUTF8StringEncoding]];
        [body appendData:fileData];
        [body appendData:[@"\r\n" dataUsingEncoding:NSUTF8StringEncoding]];
    }

    if (presignedRefs.count > 0) {
        NSData *refsData = [NSJSONSerialization dataWithJSONObject:presignedRefs options:0 error:nil];
        NSString *refsText = refsData ? [[NSString alloc] initWithData:refsData encoding:NSUTF8StringEncoding] : @"[]";
        QuiverAppendFormField(body, boundary, @"presigned", refsText ?: @"[]");
    }

    [body appendData:[[NSString stringWithFormat:@"--%@--\r\n", boundary] dataUsingEncoding:NSUTF8StringEncoding]];

    NSString *urlText = [NSString stringWithFormat:@"%@/public/v2/apps/%@/feedback",
                                                   config.baseUrl, config.appSlug];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:urlText]];
    request.HTTPMethod = @"POST";
    request.timeoutInterval = QuiverRequestTimeout;
    [request setValue:[NSString stringWithFormat:@"multipart/form-data; boundary=%@", boundary]
        forHTTPHeaderField:@"Content-Type"];
    [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
    [request setValue:(config.clientKey ?: @"") forHTTPHeaderField:@"X-Quiver-Client-Key"];
    [request setValue:[QuiverDeviceId deviceId] forHTTPHeaderField:@"X-Quiver-Device-Id"];

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
                    completion(nil, QuiverErrorWithMessage(statusCode, detail));
                    return;
                }
                completion(ticketId, nil);
            }];
    [task resume];
}

/// Presign the whole batch, then PUT each large file to R2 sequentially,
/// returning the `presigned` refs the ticket references.
+ (void)uploadLargeAttachments:(NSArray<NSString *> *)paths
                        config:(QuiverConfig *)config
                    completion:(void (^)(NSArray<NSDictionary *> *_Nullable, NSError *_Nullable))completion {
    NSMutableArray<NSDictionary *> *requestFiles = [NSMutableArray array];
    for (NSString *path in paths) {
        NSString *fileName = path.lastPathComponent ?: @"attachment";
        [requestFiles addObject:@{
            @"filename" : fileName,
            @"content_type" : QuiverContentType(fileName),
            @"size" : @(QuiverFileSize(path)),
        }];
    }
    NSData *presignBody = [NSJSONSerialization dataWithJSONObject:@{@"files" : requestFiles} options:0 error:nil];

    NSString *presignUrl = [NSString stringWithFormat:@"%@/public/v2/apps/%@/feedback/presign",
                                                      config.baseUrl, config.appSlug];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:presignUrl]];
    request.HTTPMethod = @"POST";
    request.timeoutInterval = QuiverRequestTimeout;
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
    [request setValue:(config.clientKey ?: @"") forHTTPHeaderField:@"X-Quiver-Client-Key"];

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
                    completion(nil, QuiverErrorWithMessage(statusCode, [NSString stringWithFormat:@"presign failed: HTTP %ld", (long)statusCode]));
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
        completion(nil, QuiverErrorWithMessage(0, [NSString stringWithFormat:@"presign entry %lu missing upload_url/r2_key", (unsigned long)index]));
        return;
    }

    NSString *contentType = QuiverContentType(fileName);
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:uploadUrl]];
    request.HTTPMethod = @"PUT";
    request.timeoutInterval = QuiverUploadTimeout;
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
                    completion(nil, QuiverErrorWithMessage(statusCode, [NSString stringWithFormat:@"R2 upload failed for %@: HTTP %ld", fileName, (long)statusCode]));
                    return;
                }
                [refs addObject:@{
                    @"r2_key" : r2Key,
                    @"filename" : fileName,
                    @"content_type" : contentType,
                    @"size" : @(QuiverFileSize(path)),
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
