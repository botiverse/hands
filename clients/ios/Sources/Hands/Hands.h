#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runtime configuration for Hands reporting. All values are init
/// parameters — nothing is compiled into the SDK; the host app owns its
/// slug, channel, and client key (Sentry-DSN model: the key identifies the
/// app and ships in the app bundle, it is not a user secret).
@interface HandsConfig : NSObject

@property (nonatomic, copy, readonly) NSString *baseUrl;
@property (nonatomic, copy, readonly) NSString *appSlug;
@property (nonatomic, copy, readonly) NSString *channel;
@property (nonatomic, copy, readonly) NSString *clientKey;

- (instancetype)initWithBaseUrl:(NSString *)baseUrl
                        appSlug:(NSString *)appSlug
                        channel:(NSString *)channel
                      clientKey:(NSString *)clientKey NS_DESIGNATED_INITIALIZER;

+ (instancetype)configWithBaseUrl:(NSString *)baseUrl
                          appSlug:(NSString *)appSlug
                          channel:(NSString *)channel
                        clientKey:(NSString *)clientKey;

- (instancetype)init NS_UNAVAILABLE;
+ (instancetype)new NS_UNAVAILABLE;

@end

/// Entry point: feedback tickets and store-then-send crash reporting for
/// iOS, posting to a Hands server's public feedback endpoint.
///
///   [Hands installWithConfig:
///       [HandsConfig configWithBaseUrl:@"https://quiver.example.com"
///                                     appSlug:@"my-app"
///                                     channel:@"main"
///                                   clientKey:@"qk_…"]];
///
/// installWithConfig: installs the crash handlers (uncaught NSExceptions and
/// fatal signals, written to disk at crash time) and schedules the upload of
/// pending crash reports a few seconds after launch.
@interface Hands : NSObject

+ (void)installWithConfig:(HandsConfig *)config;

/// The active config, or nil before installWithConfig:.
+ (nullable HandsConfig *)config;

/// Submit a feedback / bug / crash ticket. kind is "feedback", "bug", or
/// "crash". Completion runs on an arbitrary queue with the created ticket
/// id, or an error.
+ (void)submitFeedback:(NSString *)message
                  kind:(NSString *)kind
       attachmentPaths:(nullable NSArray<NSString *> *)attachmentPaths
                extras:(nullable NSDictionary<NSString *, NSString *> *)extras
            completion:(void (^)(NSString *_Nullable ticketId, NSError *_Nullable error))completion;

/// Stable per-install device id (random UUID persisted in NSUserDefaults).
+ (NSString *)deviceId;

/// Lightweight launch ping for active-device / version-distribution
/// analytics. Throttled to once per 24h per install; safe to call every
/// launch. installWithConfig: already calls this — call it directly only to
/// force an extra ping. No PII: device id + build/OS metadata only.
+ (void)reportDevice;

@end

NS_ASSUME_NONNULL_END
