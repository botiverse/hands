#import "QuiverFeedbackClient.h"

#import "QuiverReport.h"

#import <UIKit/UIKit.h>
#import <sys/utsname.h>

#import "QuiverDeviceId.h"

static NSString *const QuiverErrorDomain = @"QuiverReport";
static NSTimeInterval const QuiverRequestTimeout = 30.0;

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

static void QuiverAppendFormField(NSMutableData *body, NSString *boundary, NSString *name, NSString *value) {
    NSMutableString *part = [NSMutableString string];
    [part appendFormat:@"--%@\r\n", boundary];
    [part appendFormat:@"Content-Disposition: form-data; name=\"%@\"\r\n", name];
    [part appendString:@"Content-Type: text/plain; charset=utf-8\r\n\r\n"];
    [body appendData:[part dataUsingEncoding:NSUTF8StringEncoding]];
    [body appendData:[value dataUsingEncoding:NSUTF8StringEncoding]];
    [body appendData:[@"\r\n" dataUsingEncoding:NSUTF8StringEncoding]];
}

@implementation QuiverFeedbackClient

+ (NSDictionary<NSString *, id> *)metadataWithExtras:(NSDictionary<NSString *, NSString *> *)extras {
    NSDictionary *info = NSBundle.mainBundle.infoDictionary ?: @{};
    UIDevice *device = UIDevice.currentDevice;
    NSMutableDictionary<NSString *, id> *metadata = [NSMutableDictionary dictionary];
    metadata[@"version_name"] = info[@"CFBundleShortVersionString"] ?: @"";
    metadata[@"version_code"] = @([(info[@"CFBundleVersion"] ?: @"0") longLongValue]);
    metadata[@"channel"] = (QuiverReport.config.channel ?: @"");
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
    NSString *boundary = [NSString stringWithFormat:@"Quiver%@", NSUUID.UUID.UUIDString];
    NSMutableData *body = [NSMutableData data];
    QuiverAppendFormField(body, boundary, @"message", message ?: @"");
    QuiverAppendFormField(body, boundary, @"kind", kind.length > 0 ? kind : @"feedback");

    NSDictionary *metadata = [self metadataWithExtras:extras];
    NSData *metadataData = [NSJSONSerialization dataWithJSONObject:metadata options:0 error:nil];
    NSString *metadataText = metadataData
        ? [[NSString alloc] initWithData:metadataData encoding:NSUTF8StringEncoding]
        : @"{}";
    QuiverAppendFormField(body, boundary, @"metadata", metadataText ?: @"{}");

    for (NSString *path in attachmentPaths) {
        NSData *fileData = [NSData dataWithContentsOfFile:path];
        if (!fileData) {
            continue;
        }
        NSString *fileName = path.lastPathComponent ?: @"attachment.txt";
        NSMutableString *part = [NSMutableString string];
        [part appendFormat:@"--%@\r\n", boundary];
        [part appendFormat:@"Content-Disposition: form-data; name=\"attachments\"; filename=\"%@\"\r\n", fileName];
        [part appendString:@"Content-Type: text/plain\r\n\r\n"];
        [body appendData:[part dataUsingEncoding:NSUTF8StringEncoding]];
        [body appendData:fileData];
        [body appendData:[@"\r\n" dataUsingEncoding:NSUTF8StringEncoding]];
    }
    [body appendData:[[NSString stringWithFormat:@"--%@--\r\n", boundary] dataUsingEncoding:NSUTF8StringEncoding]];

    QuiverReportConfig *config = QuiverReport.config;
    if (!config) {
        completion(nil, [NSError errorWithDomain:QuiverErrorDomain
                                            code:0
                                        userInfo:@{NSLocalizedDescriptionKey : @"QuiverReport not started"}]);
        return;
    }
    NSString *urlText = [NSString stringWithFormat:@"%@/public/v2/apps/%@/feedback",
                                                   config.baseUrl, config.appSlug];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:urlText]];
    request.HTTPMethod = @"POST";
    request.timeoutInterval = QuiverRequestTimeout;
    [request setValue:[NSString stringWithFormat:@"multipart/form-data; boundary=%@", boundary]
        forHTTPHeaderField:@"Content-Type"];
    [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
    [request setValue:(QuiverReport.config.clientKey ?: @"") forHTTPHeaderField:@"X-Quiver-Client-Key"];
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
                    completion(nil, [NSError errorWithDomain:QuiverErrorDomain
                                                        code:statusCode
                                                    userInfo:@{NSLocalizedDescriptionKey : detail}]);
                    return;
                }
                completion(ticketId, nil);
            }];
    [task resume];
}

@end
