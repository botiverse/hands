#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Submits feedback / crash tickets to the Hands feedback endpoint
/// (multipart/form-data) — the iOS counterpart of the Android SDK's
/// QuiverFeedback and the OHOS QuiverFeedbackClient. App and device
/// metadata are attached automatically; the per-app client key is sent as
/// X-Hands-Client-Key.
@interface HandsFeedbackClient : NSObject

/// kind is "feedback", "bug", or "crash". Completion runs on an arbitrary
/// queue with the created ticket id, or an error.
+ (void)submitWithMessage:(NSString *)message
                     kind:(NSString *)kind
          attachmentPaths:(nullable NSArray<NSString *> *)attachmentPaths
                   extras:(nullable NSDictionary<NSString *, NSString *> *)extras
               completion:(void (^)(NSString *_Nullable ticketId, NSError *_Nullable error))completion;

@end

NS_ASSUME_NONNULL_END
