#include "HandsCrashBuild.h"

#include <signal.h>
#include <string.h>

static char gHandsCrashBuildName[HandsCrashBuildNameMax];
static char gHandsCrashBuildCommit[HandsCrashBuildCommitMax];
static long long gHandsCrashBuildCode = 0;
static int gHandsCrashBuildHasCode = 0;
static char gHandsCrashBuildJSON[HandsCrashBuildJSONMax];
static size_t gHandsCrashBuildJSONLength = 0;
// Set last, after every buffer above is complete; the signal handler reads
// the JSON only when this is 1.
static volatile sig_atomic_t gHandsCrashBuildCaptured = 0;

int HandsCrashBuildParseVersionCode(const char *text, long long *out) {
    if (!text) return 0;
    size_t i = 0;
    while (text[i] == ' ' || text[i] == '\t' || text[i] == '\n' || text[i] == '\r') i++;
    if (text[i] == '+') i++;
    if (text[i] < '0' || text[i] > '9') return 0;
    long long value = 0;
    for (; text[i] >= '0' && text[i] <= '9'; i++) {
        value = value * 10 + (text[i] - '0');
        if (value > HANDS_CRASH_BUILD_MAX_VERSION_CODE) return 0;
    }
    if (out) *out = value;
    return 1;
}

// Copies the whole value or stores "" (unknown). Never truncates.
static void HandsCrashBuildCopyWhole(const char *input, char *output, size_t capacity) {
    output[0] = '\0';
    if (!input) return;
    size_t n = strlen(input);
    if (n == 0 || n >= capacity) return;
    memcpy(output, input, n + 1);
}

static void HandsCrashBuildAppend(char *buffer, size_t capacity, size_t *offset, const char *text, size_t n) {
    if (*offset + n >= capacity) return;
    memcpy(buffer + *offset, text, n);
    *offset += n;
    buffer[*offset] = '\0';
}

static void HandsCrashBuildAppendEscaped(char *buffer, size_t capacity, size_t *offset, const char *text) {
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; text[i] != '\0'; i++) {
        unsigned char ch = (unsigned char)text[i];
        if (ch == '"' || ch == '\\') {
            char escaped[2] = {'\\', (char)ch};
            HandsCrashBuildAppend(buffer, capacity, offset, escaped, 2);
        } else if (ch < 0x20) {
            char escaped[6] = {'\\', 'u', '0', '0', hex[ch >> 4], hex[ch & 0xf]};
            HandsCrashBuildAppend(buffer, capacity, offset, escaped, 6);
        } else {
            char raw = (char)ch;
            HandsCrashBuildAppend(buffer, capacity, offset, &raw, 1);
        }
    }
}

static void HandsCrashBuildAppendNumber(char *buffer, size_t capacity, size_t *offset, long long value) {
    char digits[24];
    int n = 0;
    if (value <= 0) {
        HandsCrashBuildAppend(buffer, capacity, offset, "0", 1);
        return;
    }
    while (value > 0 && n < 20) {
        digits[n++] = (char)('0' + (value % 10));
        value /= 10;
    }
    char out[24];
    for (int j = 0; j < n; j++) out[j] = digits[n - 1 - j];
    HandsCrashBuildAppend(buffer, capacity, offset, out, (size_t)n);
}

void HandsCrashBuildCapture(const char *versionName, const char *versionCode, const char *commit) {
    gHandsCrashBuildCaptured = 0;
    HandsCrashBuildCopyWhole(versionName, gHandsCrashBuildName, sizeof(gHandsCrashBuildName));
    HandsCrashBuildCopyWhole(commit, gHandsCrashBuildCommit, sizeof(gHandsCrashBuildCommit));
    gHandsCrashBuildCode = 0;
    gHandsCrashBuildHasCode = HandsCrashBuildParseVersionCode(versionCode, &gHandsCrashBuildCode);

    size_t off = 0;
    char *json = gHandsCrashBuildJSON;
    size_t cap = sizeof(gHandsCrashBuildJSON);
    json[0] = '\0';
    HandsCrashBuildAppend(json, cap, &off, "\"version_name\":\"", 16);
    HandsCrashBuildAppendEscaped(json, cap, &off, gHandsCrashBuildName);
    HandsCrashBuildAppend(json, cap, &off, "\",\"version_code\":", 17);
    if (gHandsCrashBuildHasCode) {
        HandsCrashBuildAppendNumber(json, cap, &off, gHandsCrashBuildCode);
    } else {
        HandsCrashBuildAppend(json, cap, &off, "null", 4);
    }
    HandsCrashBuildAppend(json, cap, &off, ",\"commit\":\"", 11);
    HandsCrashBuildAppendEscaped(json, cap, &off, gHandsCrashBuildCommit);
    HandsCrashBuildAppend(json, cap, &off, "\",", 2);
    gHandsCrashBuildJSONLength = off;
    gHandsCrashBuildCaptured = 1;
}

int HandsCrashBuildIsCaptured(void) {
    return gHandsCrashBuildCaptured ? 1 : 0;
}

const char *HandsCrashBuildVersionName(void) {
    return gHandsCrashBuildName;
}

const char *HandsCrashBuildCommit(void) {
    return gHandsCrashBuildCommit;
}

int HandsCrashBuildVersionCode(long long *out) {
    if (!gHandsCrashBuildHasCode) return 0;
    if (out) *out = gHandsCrashBuildCode;
    return 1;
}

const char *HandsCrashBuildJSONFields(size_t *length) {
    if (!gHandsCrashBuildCaptured) {
        if (length) *length = 0;
        return "";
    }
    if (length) *length = gHandsCrashBuildJSONLength;
    return gHandsCrashBuildJSON;
}
