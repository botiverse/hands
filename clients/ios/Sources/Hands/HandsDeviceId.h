#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Stable per-install device id for Hands (rollout cohorting and report
/// correlation). A random UUID persisted in NSUserDefaults — not a hardware
/// id; it resets on reinstall, mirroring the Android and OHOS helpers.
@interface HandsDeviceId : NSObject

+ (NSString *)deviceId;

@end

NS_ASSUME_NONNULL_END
