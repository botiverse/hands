#import "QuiverDeviceId.h"

static NSString *const QuiverDeviceIdDefaultsKey = @"quiver_device_id";

@implementation QuiverDeviceId

+ (NSString *)deviceId {
    static NSString *cached = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
        NSString *stored = [defaults stringForKey:QuiverDeviceIdDefaultsKey];
        if (stored.length == 0) {
            stored = NSUUID.UUID.UUIDString.lowercaseString;
            [defaults setObject:stored forKey:QuiverDeviceIdDefaultsKey];
        }
        cached = stored;
    });
    return cached;
}

@end
