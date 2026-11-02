// Crash tickets carry the crashed build, not the uploading launch's
// (botiverse/hands#858). Runs as the Hands pod's test_spec on an iOS
// simulator (needs macOS + Xcode):
//   pod lib lint Hands.podspec --run-tests --platforms=ios
// The async-signal-safe C buffers also have a host test that runs anywhere:
//   clients/ios/Tests/scripts/test_crash_build.sh

#import <XCTest/XCTest.h>

#import "HandsCrashBuild.h"
#import "HandsCrashReporter.h"
#import "HandsFeedbackClient.h"

@interface HandsCrashBuildTests : XCTestCase
@property (nonatomic, copy) NSString *tempDir;
@end

@implementation HandsCrashBuildTests

- (void)setUp {
    [super setUp];
    self.tempDir = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    [NSFileManager.defaultManager createDirectoryAtPath:self.tempDir withIntermediateDirectories:YES attributes:nil error:nil];
}

- (void)tearDown {
    [NSFileManager.defaultManager removeItemAtPath:self.tempDir error:nil];
    [super tearDown];
}

- (NSDictionary *)writeSignalSidecar {
    NSString *path = [self.tempDir stringByAppendingPathComponent:@"crash-1730000000000.meta.json"];
    HandsWriteSignalMetaFile(path.fileSystemRepresentation, "SIGSEGV", 1730000000000LL);
    NSData *data = [NSData dataWithContentsOfFile:path];
    XCTAssertNotNil(data);
    NSError *error = nil;
    NSDictionary *meta = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    XCTAssertNil(error, @"signal sidecar must stay valid JSON: %@",
                 [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);
    XCTAssertTrue([meta isKindOfClass:NSDictionary.class]);
    return meta;
}

#pragma mark - Sidecar is written with the build

- (void)testSignalSidecarRecordsCapturedBuild {
    HandsCrashBuildCapture("1.17.1", "11701001", "ba23a8a6a");
    NSDictionary *meta = [self writeSignalSidecar];
    XCTAssertEqualObjects(meta[@"exception_class"], @"SIGSEGV");
    XCTAssertEqualObjects(meta[@"crash_at"], @1730000000000LL);
    XCTAssertEqualObjects(meta[@"version_name"], @"1.17.1");
    XCTAssertEqualObjects(meta[@"version_code"], @11701001);
    XCTAssertEqualObjects(meta[@"commit"], @"ba23a8a6a");
    XCTAssertTrue([meta[@"binary_images"] isKindOfClass:NSArray.class]);
    XCTAssertEqualObjects(meta[@"frames"], @[]);
}

- (void)testSignalSidecarWritesUnknownBuildLikeAndroid {
    HandsCrashBuildCapture(NULL, NULL, NULL);
    NSDictionary *meta = [self writeSignalSidecar];
    XCTAssertEqualObjects(meta[@"version_name"], @"");
    XCTAssertEqualObjects(meta[@"version_code"], NSNull.null);
    XCTAssertEqualObjects(meta[@"commit"], @"");
}

- (void)testExceptionSidecarFieldsMatchSignalSidecar {
    HandsCrashBuildCapture("2.0 \"rc\"", "200", "deadbeef");
    NSDictionary *fields = HandsCrashBuildSidecarFields();
    XCTAssertEqualObjects(fields[@"version_name"], @"2.0 \"rc\"");
    XCTAssertEqualObjects(fields[@"version_code"], @200);
    XCTAssertEqualObjects(fields[@"commit"], @"deadbeef");

    NSDictionary *meta = [self writeSignalSidecar];
    for (NSString *key in @[ @"version_name", @"version_code", @"commit" ]) {
        XCTAssertEqualObjects(meta[key], fields[key], @"%@", key);
    }
}

#pragma mark - Upload uses the sidecar build over the current bundle

- (void)testUploadUsesSidecarBuildOverCurrentBundle {
    NSDictionary *sidecar = @{
        @"exception_class" : @"SIGABRT",
        @"version_name" : @"1.17.1",
        @"version_code" : @11701001,
        @"commit" : @"ba23a8a6a",
    };
    NSDictionary *metadata = [HandsFeedbackClient metadataWithExtras:HandsCrashBuildExtras(sidecar)];
    XCTAssertEqualObjects(metadata[@"version_name"], @"1.17.1");
    XCTAssertEqualObjects(metadata[@"version_code"], @11701001);
    XCTAssertTrue([metadata[@"version_code"] isKindOfClass:NSNumber.class],
                  @"server only keeps a numeric version_code");
    XCTAssertEqualObjects(metadata[@"commit"], @"ba23a8a6a");
}

- (void)testSidecarBuildSurvivesAJSONRoundTrip {
    HandsCrashBuildCapture("1.17.1", "11701001", "ba23a8a6a");
    NSDictionary *metadata = [HandsFeedbackClient metadataWithExtras:HandsCrashBuildExtras([self writeSignalSidecar])];
    XCTAssertEqualObjects(metadata[@"version_name"], @"1.17.1");
    XCTAssertEqualObjects(metadata[@"version_code"], @11701001);
    XCTAssertEqualObjects(metadata[@"commit"], @"ba23a8a6a");
}

#pragma mark - Missing build is not stamped with the uploader's

- (void)testOldSidecarWithoutBuildOmitsVersionAndCommit {
    NSDictionary *oldSidecar = @{@"exception_class" : @"SIGSEGV", @"crash_at" : @1};
    NSDictionary *extras = HandsCrashBuildExtras(oldSidecar);
    XCTAssertEqualObjects(extras[@"version_name"], NSNull.null);
    XCTAssertEqualObjects(extras[@"version_code"], NSNull.null);
    XCTAssertEqualObjects(extras[@"commit"], NSNull.null);

    NSDictionary *metadata = [HandsFeedbackClient metadataWithExtras:extras];
    XCTAssertNil(metadata[@"version_name"]);
    XCTAssertNil(metadata[@"version_code"]);
    XCTAssertNil(metadata[@"commit"]);
    // The rest of the uploader's environment metadata is still attached.
    XCTAssertEqualObjects(metadata[@"platform"], @"ios");
}

- (void)testUnknownSidecarBuildIsOmitted {
    HandsCrashBuildCapture(NULL, NULL, NULL);
    NSDictionary *metadata = [HandsFeedbackClient metadataWithExtras:HandsCrashBuildExtras([self writeSignalSidecar])];
    XCTAssertNil(metadata[@"version_name"]);
    XCTAssertNil(metadata[@"version_code"]);
    XCTAssertNil(metadata[@"commit"]);
}

- (void)testPartialBuildKeepsOnlyRecordedFields {
    NSDictionary *metadata = [HandsFeedbackClient metadataWithExtras:HandsCrashBuildExtras(@{
        @"version_name" : @"  1.2.3  ",
        @"version_code" : NSNull.null,
        @"commit" : @"",
    })];
    XCTAssertEqualObjects(metadata[@"version_name"], @"1.2.3");
    XCTAssertNil(metadata[@"version_code"]);
    XCTAssertNil(metadata[@"commit"]);
}

- (void)testInvalidVersionCodesAreOmitted {
    NSArray *invalid = @[ @"11701001", @YES, @1.5, @(-1), @9007199254740992.0, @{} ];
    for (id value in invalid) {
        NSDictionary *extras = HandsCrashBuildExtras(@{@"version_code" : value});
        XCTAssertEqualObjects(extras[@"version_code"], NSNull.null, @"%@", value);
    }
    XCTAssertEqualObjects(HandsCrashBuildExtras(@{@"version_code" : @0})[@"version_code"], @0);
    XCTAssertEqualObjects(HandsCrashBuildExtras(@{@"version_code" : @9007199254740991LL})[@"version_code"],
                          @9007199254740991LL);
}

- (void)testNonDictionarySidecarOmitsBuild {
    NSDictionary *extras = HandsCrashBuildExtras((NSDictionary *)@[ @1 ]);
    XCTAssertEqualObjects(extras[@"version_name"], NSNull.null);
}

#pragma mark - Ordinary feedback is unchanged

- (void)testFeedbackWithoutExtrasStillReportsCurrentBundle {
    NSDictionary *info = NSBundle.mainBundle.infoDictionary ?: @{};
    NSDictionary *metadata = [HandsFeedbackClient metadataWithExtras:nil];
    XCTAssertEqualObjects(metadata[@"version_name"], info[@"CFBundleShortVersionString"] ?: @"");
    XCTAssertNotNil(metadata[@"version_code"]);
}

@end
