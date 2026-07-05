#import "QuiverReport.h"

#import "QuiverCrashReporter.h"
#import "QuiverDeviceId.h"
#import "QuiverFeedbackClient.h"

static NSTimeInterval const QuiverPendingUploadDelay = 3.0;

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
