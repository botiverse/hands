#import "QuiverReport.h"

#import "QuiverCrashReporter.h"
#import "QuiverDeviceId.h"
#import "QuiverFeedbackClient.h"

#import <UIKit/UIKit.h>
#import <sys/utsname.h>

static NSTimeInterval const QuiverPendingUploadDelay = 3.0;
static NSTimeInterval const QuiverDevicePingInterval = 24 * 60 * 60;
static NSString *const QuiverLastPingDefaultsKey = @"quiver_last_device_ping_at";

@interface QuiverReportConfig ()
@property (nonatomic, copy, readwrite) NSString *baseUrl;
@property (nonatomic, copy, readwrite) NSString *appSlug;
@property (nonatomic, copy, readwrite) NSString *channel;
@property (nonatomic, copy, readwrite) NSString *clientKey;
@end

@implementation QuiverReportConfig

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
    return [[QuiverReportConfig alloc] initWithBaseUrl:baseUrl
                                               appSlug:appSlug
                                               channel:channel
                                             clientKey:clientKey];
}

@end

static QuiverReportConfig *gQuiverReportConfig = nil;

@implementation QuiverReport

+ (void)startWithConfig:(QuiverReportConfig *)config {
    gQuiverReportConfig = config;
    [QuiverCrashReporter install];
    [QuiverCrashReporter uploadPendingAfterDelay:QuiverPendingUploadDelay];
    [self reportDevice];
}

+ (void)reportDevice {
    QuiverReportConfig *config = gQuiverReportConfig;
    if (!config) return;

    NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
    NSTimeInterval last = [defaults doubleForKey:QuiverLastPingDefaultsKey];
    NSTimeInterval nowSecs = NSDate.date.timeIntervalSince1970;
    if (last > 0 && nowSecs - last < QuiverDevicePingInterval) return;

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

    NSString *urlText = [NSString stringWithFormat:@"%@/public/v2/apps/%@/devices",
                                                   config.baseUrl, config.appSlug];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:urlText]];
    request.HTTPMethod = @"POST";
    request.timeoutInterval = 15;
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    [request setValue:config.clientKey forHTTPHeaderField:@"X-Quiver-Client-Key"];
    [request setValue:[QuiverDeviceId deviceId] forHTTPHeaderField:@"X-Quiver-Device-Id"];

    NSURLSessionUploadTask *task = [NSURLSession.sharedSession
        uploadTaskWithRequest:request
                     fromData:bodyData
            completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                NSInteger code = [(NSHTTPURLResponse *)response statusCode];
                if (!error && code >= 200 && code < 300) {
                    [defaults setDouble:nowSecs forKey:QuiverLastPingDefaultsKey];
                }
            }];
    [task resume];
}

+ (QuiverReportConfig *)config {
    return gQuiverReportConfig;
}

+ (void)submitFeedback:(NSString *)message
                  kind:(NSString *)kind
       attachmentPaths:(NSArray<NSString *> *)attachmentPaths
                extras:(NSDictionary<NSString *, NSString *> *)extras
            completion:(void (^)(NSString *_Nullable, NSError *_Nullable))completion {
    [QuiverFeedbackClient submitWithMessage:message
                                       kind:kind
                            attachmentPaths:attachmentPaths
                                     extras:extras
                                 completion:completion];
}

+ (NSString *)deviceId {
    return [QuiverDeviceId deviceId];
}

@end
