#import "Hands.h"

#import "HandsCrashReporter.h"
#import "HandsDeviceId.h"
#import "HandsFeedbackClient.h"

#import <UIKit/UIKit.h>
#import <sys/utsname.h>

static NSTimeInterval const HandsPendingUploadDelay = 3.0;
static NSTimeInterval const HandsDevicePingInterval = 24 * 60 * 60;
static NSString *const HandsLastPingDefaultsKey = @"quiver_last_device_ping_at";

@interface HandsConfig ()
@property (nonatomic, copy, readwrite) NSString *baseUrl;
@property (nonatomic, copy, readwrite) NSString *appSlug;
@property (nonatomic, copy, readwrite) NSString *channel;
@property (nonatomic, copy, readwrite) NSString *clientKey;
@end

@implementation HandsConfig

- (instancetype)initWithBaseUrl:(NSString *)baseUrl
                        appSlug:(NSString *)appSlug
                        channel:(NSString *)channel
                      clientKey:(NSString *)clientKey {
    self = [super init];
    if (self) {
        // Normalize the base URL once so callers can pass either form.
        _baseUrl = [baseUrl hasSuffix:@"/"]
            ? [[baseUrl substringToIndex:baseUrl.length - 1] copy]
            : [baseUrl copy];
        _appSlug = [appSlug copy];
        _channel = [channel copy];
        _clientKey = [clientKey copy];
    }
    return self;
}

+ (instancetype)configWithBaseUrl:(NSString *)baseUrl
                          appSlug:(NSString *)appSlug
                          channel:(NSString *)channel
                        clientKey:(NSString *)clientKey {
    return [[HandsConfig alloc] initWithBaseUrl:baseUrl
                                               appSlug:appSlug
                                               channel:channel
                                             clientKey:clientKey];
}

@end

static HandsConfig *gHandsConfig = nil;

@implementation Hands

+ (void)installWithConfig:(HandsConfig *)config {
    gHandsConfig = config;
    [HandsCrashReporter install];
    [HandsCrashReporter uploadPendingAfterDelay:HandsPendingUploadDelay];
    [self reportDevice];
}

+ (void)reportDevice {
    HandsConfig *config = gHandsConfig;
    if (!config) return;

    NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
    NSTimeInterval last = [defaults doubleForKey:HandsLastPingDefaultsKey];
    NSTimeInterval nowSecs = NSDate.date.timeIntervalSince1970;
    if (last > 0 && nowSecs - last < HandsDevicePingInterval) return;

    NSDictionary *info = NSBundle.mainBundle.infoDictionary ?: @{};
    UIDevice *device = UIDevice.currentDevice;
    struct utsname systemInfo;
    NSString *model = uname(&systemInfo) == 0
        ? [NSString stringWithCString:systemInfo.machine encoding:NSUTF8StringEncoding]
        : (device.model ?: @"iOS");
    NSDictionary *metadata = @{
        @"version_name": info[@"CFBundleShortVersionString"] ?: @"",
        @"version_code": @([(info[@"CFBundleVersion"] ?: @"0") longLongValue]),
        @"channel": config.channel ?: @"",
        @"platform": @"ios",
#if defined(__arm64__)
        @"arch": @"arm64",
#else
        @"arch": @"x86_64",
#endif
        @"os_version": [NSString stringWithFormat:@"%@ %@", device.systemName ?: @"iOS", device.systemVersion ?: @""],
        @"device_model": model ?: @"iOS",
        @"locale": NSLocale.currentLocale.localeIdentifier ?: @"",
    };
    NSData *bodyData = [NSJSONSerialization dataWithJSONObject:metadata options:0 error:nil];
    if (!bodyData) return;

    NSString *urlText = [NSString stringWithFormat:@"%@/public/v2/apps/%@/metrics",
                                                   config.baseUrl, config.appSlug];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:urlText]];
    request.HTTPMethod = @"POST";
    request.timeoutInterval = 15;
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    [request setValue:config.clientKey forHTTPHeaderField:@"X-Hands-Client-Key"];
    [request setValue:[HandsDeviceId deviceId] forHTTPHeaderField:@"X-Hands-Device-Id"];

    NSURLSessionUploadTask *task = [NSURLSession.sharedSession
        uploadTaskWithRequest:request
                     fromData:bodyData
            completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                NSInteger code = [(NSHTTPURLResponse *)response statusCode];
                if (!error && code >= 200 && code < 300) {
                    [defaults setDouble:nowSecs forKey:HandsLastPingDefaultsKey];
                }
            }];
    [task resume];
}

+ (HandsConfig *)config {
    return gHandsConfig;
}

+ (void)submitFeedback:(NSString *)message
                  kind:(NSString *)kind
       attachmentPaths:(NSArray<NSString *> *)attachmentPaths
                extras:(NSDictionary<NSString *, NSString *> *)extras
            completion:(void (^)(NSString *_Nullable, NSError *_Nullable))completion {
    [HandsFeedbackClient submitWithMessage:message
                                       kind:kind
                            attachmentPaths:attachmentPaths
                                     extras:extras
                                 completion:completion];
}

+ (NSString *)deviceId {
    return [HandsDeviceId deviceId];
}

@end
