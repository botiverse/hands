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
///       [HandsConfig configWithBaseUrl:@"https://your-hands-origin.example"
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

/// Capture a handled exception and submit it as kind "error" with structured
/// metadata and the current breadcrumb trail. Completion runs on an arbitrary
/// queue with the created ticket id, or an error.
+ (void)captureException:(NSException *)exception
              completion:(nullable void (^)(NSString *_Nullable ticketId, NSError *_Nullable error))completion;

/// Capture a handled NSError and submit it as kind "error".
+ (void)captureError:(NSError *)error
          completion:(nullable void (^)(NSString *_Nullable ticketId, NSError *_Nullable error))completion;

/// Record a breadcrumb (max 100, ring buffer). Breadcrumbs are attached to
/// both captureException/captureError submissions and fatal crash reports.
+ (void)addBreadcrumbWithCategory:(NSString *)category
                          message:(NSString *)message
                            level:(nullable NSString *)level;

/// Snapshot current breadcrumbs as a JSON string (for crash persistence).
+ (NSString *)snapshotBreadcrumbs;

/// Clear all breadcrumbs (e.g. on logout / session boundary).
+ (void)clearBreadcrumbs;

/// Stable per-install device id (random UUID persisted in NSUserDefaults).
+ (NSString *)deviceId;

/// Lightweight launch ping for active-device / version-distribution
/// analytics. Throttled to once per 24h per install; safe to call every
/// launch. installWithConfig: already calls this — call it directly only to
/// force an extra ping. No PII: device id + build/OS metadata only.
+ (void)reportDevice;

@end

NS_ASSUME_NONNULL_END
