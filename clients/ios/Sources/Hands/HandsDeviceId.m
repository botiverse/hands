#import "HandsDeviceId.h"

static NSString *const HandsDeviceIdDefaultsKey = @"quiver_device_id";

@implementation HandsDeviceId

+ (NSString *)deviceId {
    static NSString *cached = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
        NSString *stored = [defaults stringForKey:HandsDeviceIdDefaultsKey];
        if (stored.length == 0) {
            stored = NSUUID.UUID.UUIDString.lowercaseString;
            [defaults setObject:stored forKey:HandsDeviceIdDefaultsKey];
        }
        cached = stored;
    });
    return cached;
}

@end
