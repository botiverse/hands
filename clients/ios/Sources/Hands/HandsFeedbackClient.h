#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Submits feedback / crash tickets to the Hands feedback endpoint
/// (multipart/form-data) — the iOS counterpart of the Android SDK's
/// QuiverFeedback and the OHOS QuiverFeedbackClient. App and device
/// metadata are attached automatically; the per-app client key is sent as
/// X-Hands-Client-Key.
@interface HandsFeedbackClient : NSObject

/// kind is "feedback", "bug", or "crash". Completion runs on an arbitrary
/// queue with the created ticket id, or an error. Extras values are
/// JSON-serializable (NSString, NSNumber) and override the automatic
/// metadata; an NSNull value removes that metadata key.
+ (void)submitWithMessage:(NSString *)message
                     kind:(NSString *)kind
          attachmentPaths:(nullable NSArray<NSString *> *)attachmentPaths
                   extras:(nullable NSDictionary<NSString *, id> *)extras
               completion:(void (^)(NSString *_Nullable ticketId, NSError *_Nullable error))completion;

/// The metadata object sent with a ticket (automatic fields merged with
/// extras as described above). SDK-internal; exposed for tests.
+ (NSDictionary<NSString *, id> *)metadataWithExtras:(nullable NSDictionary<NSString *, id> *)extras;

@end

/// The host build's git commit from Info.plist (HandsBuildCommit, then
/// GitCommit / CommitHash), or nil when none is injected. SDK-internal.
FOUNDATION_EXTERN NSString *_Nullable HandsBuildCommit(NSDictionary *info);

NS_ASSUME_NONNULL_END
