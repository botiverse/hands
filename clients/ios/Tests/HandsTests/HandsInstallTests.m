#import <XCTest/XCTest.h>
#import <objc/runtime.h>

#import "Hands.h"
#import "HandsCrashReporter.h"

static int gUploads = 0;
static int gPings = 0;

@interface HandsInstallProbe : NSObject
@end

@implementation HandsInstallProbe
+ (void)probeUpload:(NSTimeInterval)delay { gUploads++; }
+ (void)probePing { gPings++; }
@end

static void HandsSwapClassMethods(Class cls, SEL original, SEL probe) {
    method_exchangeImplementations(class_getClassMethod(cls, original),
                                   class_getClassMethod(HandsInstallProbe.class, probe));
}

@interface HandsInstallTests : XCTestCase
@end

@implementation HandsInstallTests

- (void)setUp {
    gUploads = 0;
    gPings = 0;
    HandsSwapClassMethods(HandsCrashReporter.class, @selector(uploadPendingAfterDelay:), @selector(probeUpload:));
    HandsSwapClassMethods(Hands.class, @selector(reportDevice), @selector(probePing));
}

- (void)tearDown {
    // Exchanging again restores the original implementations.
    HandsSwapClassMethods(HandsCrashReporter.class, @selector(uploadPendingAfterDelay:), @selector(probeUpload:));
    HandsSwapClassMethods(Hands.class, @selector(reportDevice), @selector(probePing));
}

- (void)testDeferredInstallSendsNothingUntilTheAppAsks {
    HandsConfig *config = [HandsConfig configWithBaseUrl:@"https://hands.invalid/"
                                                 appSlug:@"app"
                                                 channel:@"main"
                                               clientKey:@"qk_test"];
    [Hands installWithConfig:config uploadOnLaunch:NO];
    XCTAssertEqual(gUploads, 0);
    XCTAssertEqual(gPings, 0);
    XCTAssertEqualObjects(Hands.config.baseUrl, @"https://hands.invalid");

    [Hands uploadPendingAfterDelay:0];
    XCTAssertEqual(gUploads, 1);

    [Hands installWithConfig:config];
    XCTAssertEqual(gUploads, 2);
    XCTAssertEqual(gPings, 1);
}

@end
