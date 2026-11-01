// Host test for HandsCrashBuild.c (the async-signal-safe crashed-build
// buffers the iOS signal handler writes into the sidecar). Pure C, runs on
// Linux/macOS without Xcode: clients/ios/Tests/scripts/test_crash_build.sh.

#include "HandsCrashBuild.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures = 0;

#define EXPECT(cond, ...)                                  \
    do {                                                   \
        if (!(cond)) {                                     \
            fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
            fprintf(stderr, __VA_ARGS__);                  \
            fprintf(stderr, "\n");                         \
            failures++;                                    \
        }                                                  \
    } while (0)

static void expect_fields(const char *expected) {
    size_t length = 99;
    const char *json = HandsCrashBuildJSONFields(&length);
    EXPECT(length == strlen(json), "length %zu != strlen %zu", length, strlen(json));
    EXPECT(strcmp(json, expected) == 0, "fields\n  got:  %s\n  want: %s", json, expected);
}

static void test_before_capture_writes_nothing(void) {
    size_t length = 99;
    const char *json = HandsCrashBuildJSONFields(&length);
    EXPECT(!HandsCrashBuildIsCaptured(), "captured before capture");
    EXPECT(length == 0 && json[0] == '\0', "fields before capture: %s", json);
}

static void test_parse_version_code(void) {
    long long v = -1;
    EXPECT(HandsCrashBuildParseVersionCode("11701001", &v) && v == 11701001, "plain");
    EXPECT(HandsCrashBuildParseVersionCode("  42", &v) && v == 42, "leading space");
    EXPECT(HandsCrashBuildParseVersionCode("1.2.3", &v) && v == 1, "dotted like longLongValue");
    EXPECT(HandsCrashBuildParseVersionCode("0", &v) && v == 0, "zero");
    EXPECT(HandsCrashBuildParseVersionCode("9007199254740991", &v) && v == 9007199254740991LL, "max safe");
    EXPECT(!HandsCrashBuildParseVersionCode("9007199254740992", &v), "above max safe");
    EXPECT(!HandsCrashBuildParseVersionCode("99999999999999999999999", &v), "overflow");
    EXPECT(!HandsCrashBuildParseVersionCode("-5", &v), "negative");
    EXPECT(!HandsCrashBuildParseVersionCode("abc", &v), "no digits");
    EXPECT(!HandsCrashBuildParseVersionCode("", &v), "empty");
    EXPECT(!HandsCrashBuildParseVersionCode(NULL, &v), "null");
}

static void test_full_build(void) {
    HandsCrashBuildCapture("1.17.1", "11701001", "ba23a8a6a");
    EXPECT(HandsCrashBuildIsCaptured(), "not captured");
    expect_fields("\"version_name\":\"1.17.1\",\"version_code\":11701001,\"commit\":\"ba23a8a6a\",");
    long long code = 0;
    EXPECT(HandsCrashBuildVersionCode(&code) && code == 11701001, "code accessor");
    EXPECT(strcmp(HandsCrashBuildVersionName(), "1.17.1") == 0, "name accessor");
    EXPECT(strcmp(HandsCrashBuildCommit(), "ba23a8a6a") == 0, "commit accessor");
}

static void test_unknown_values_match_android_sidecar(void) {
    // Android #587 writes "" for an unknown name and null for an unknown code.
    HandsCrashBuildCapture(NULL, NULL, NULL);
    expect_fields("\"version_name\":\"\",\"version_code\":null,\"commit\":\"\",");
    EXPECT(!HandsCrashBuildVersionCode(NULL), "code should be unknown");

    HandsCrashBuildCapture("", "abc", "");
    expect_fields("\"version_name\":\"\",\"version_code\":null,\"commit\":\"\",");
}

static void test_escaping(void) {
    HandsCrashBuildCapture("1.0 \"beta\"\\x\n", "7", "c\x01");
    expect_fields("\"version_name\":\"1.0 \\\"beta\\\"\\\\x\\u000a\",\"version_code\":7,\"commit\":\"c\\u0001\",");
}

static void test_utf8_passes_through(void) {
    HandsCrashBuildCapture("1.0-\xe6\xb5\x8b\xe8\xaf\x95", "3", "abc");
    expect_fields("\"version_name\":\"1.0-\xe6\xb5\x8b\xe8\xaf\x95\",\"version_code\":3,\"commit\":\"abc\",");
}

static void test_overlong_is_unknown_not_truncated(void) {
    char longName[HandsCrashBuildNameMax + 8];
    memset(longName, 'a', sizeof(longName) - 1);
    longName[sizeof(longName) - 1] = '\0';
    HandsCrashBuildCapture(longName, "5", "abc");
    expect_fields("\"version_name\":\"\",\"version_code\":5,\"commit\":\"abc\",");

    // Largest value that fits, made entirely of characters that escape to
    // 6 bytes, still fits the JSON buffer.
    char name[HandsCrashBuildNameMax];
    char commit[HandsCrashBuildCommitMax];
    memset(name, '\x01', sizeof(name) - 1);
    name[sizeof(name) - 1] = '\0';
    memset(commit, '\x02', sizeof(commit) - 1);
    commit[sizeof(commit) - 1] = '\0';
    HandsCrashBuildCapture(name, "9007199254740991", commit);
    size_t length = 0;
    const char *json = HandsCrashBuildJSONFields(&length);
    size_t expected = 16 + (sizeof(name) - 1) * 6 + 17 + 16 + 11 + (sizeof(commit) - 1) * 6 + 2;
    EXPECT(length == expected, "worst-case length %zu != %zu", length, expected);
    EXPECT(length > 0 && json[length - 1] == ',', "worst case must end with the trailing comma");
}

int main(void) {
    test_before_capture_writes_nothing();
    test_parse_version_code();
    test_full_build();
    test_unknown_values_match_android_sidecar();
    test_escaping();
    test_utf8_passes_through();
    test_overlong_is_unknown_not_truncated();
    if (failures) {
        fprintf(stderr, "%d failure(s)\n", failures);
        return 1;
    }
    printf("hands_crash_build_test: ok\n");
    return 0;
}
