/**
 * Known SDKs by Java package prefix, native library name and iOS framework
 * name. The tables are deliberately small: they name what people ask about
 * ("did we add Firebase?"), and anything unknown is still listed under its
 * package, .so or framework name.
 */

/** Longest prefix wins. Prefixes are dotted Java package names. */
const JAVA_PACKAGE_SDKS: Array<[string, string]> = [
  ["build.hands", "Hands SDK"],
  ["com.google.firebase.crashlytics", "Firebase Crashlytics"],
  ["com.google.firebase.messaging", "Firebase Cloud Messaging"],
  ["com.google.firebase.analytics", "Firebase Analytics"],
  ["com.google.firebase", "Firebase"],
  ["com.google.android.gms.ads", "Google Mobile Ads"],
  ["com.google.android.gms.maps", "Google Maps"],
  ["com.google.android.gms", "Google Play services"],
  ["com.google.android.play", "Google Play Core"],
  ["com.google.android.material", "Material Components"],
  ["com.google.android.exoplayer2", "ExoPlayer"],
  ["com.google.android.datatransport", "Google Data Transport"],
  ["com.google.mlkit", "ML Kit"],
  ["com.google.protobuf", "Protocol Buffers"],
  ["com.google.gson", "Gson"],
  ["com.google.common", "Guava"],
  ["com.google.zxing", "ZXing"],
  ["io.sentry", "Sentry"],
  ["okhttp3", "OkHttp"],
  ["okio", "Okio"],
  ["retrofit2", "Retrofit"],
  ["com.squareup.moshi", "Moshi"],
  ["com.squareup.picasso", "Picasso"],
  ["com.squareup.wire", "Wire"],
  ["com.squareup.leakcanary", "LeakCanary"],
  ["kotlinx.coroutines", "Kotlin coroutines"],
  ["kotlinx.serialization", "Kotlin serialization"],
  ["kotlinx", "Kotlin extensions"],
  ["kotlin", "Kotlin stdlib"],
  ["androidx.compose", "Jetpack Compose"],
  ["androidx.media3", "Media3"],
  ["androidx.camera", "CameraX"],
  ["androidx.room", "Room"],
  ["androidx.work", "WorkManager"],
  ["androidx", "AndroidX"],
  ["android.support", "Android Support Library"],
  ["coil", "Coil"],
  ["coil3", "Coil"],
  ["com.bumptech.glide", "Glide"],
  ["com.facebook.react", "React Native"],
  ["com.facebook.hermes", "Hermes"],
  ["com.facebook.fresco", "Fresco"],
  ["com.facebook.imagepipeline", "Fresco"],
  ["com.facebook", "Facebook SDK"],
  ["io.flutter", "Flutter"],
  ["io.reactivex", "RxJava"],
  ["io.ktor", "Ktor"],
  ["io.grpc", "gRPC"],
  ["io.realm", "Realm"],
  ["io.branch", "Branch"],
  ["dagger", "Dagger"],
  ["javax.inject", "javax.inject"],
  ["org.jetbrains.compose", "Compose Multiplatform"],
  ["org.bouncycastle", "Bouncy Castle"],
  ["org.conscrypt", "Conscrypt"],
  ["net.sqlcipher", "SQLCipher"],
  ["com.airbnb.lottie", "Lottie"],
  ["com.amplitude", "Amplitude"],
  ["com.mixpanel", "Mixpanel"],
  ["com.segment", "Segment"],
  ["com.appsflyer", "AppsFlyer"],
  ["com.adjust.sdk", "Adjust"],
  ["com.onesignal", "OneSignal"],
  ["com.datadog", "Datadog"],
  ["com.newrelic", "New Relic"],
  ["com.bugsnag", "Bugsnag"],
  ["com.huawei.hms", "Huawei HMS Core"],
  ["com.huawei.agconnect", "Huawei AppGallery Connect"],
  ["com.xiaomi.push", "Xiaomi Push"],
  ["com.xiaomi.mipush", "Xiaomi Push"],
  ["com.vivo.push", "vivo Push"],
  ["com.heytap.msp", "OPPO Push"],
  ["com.meizu.cloud.pushsdk", "Meizu Push"],
  ["com.tencent.mm.opensdk", "WeChat SDK"],
  ["com.tencent.bugly", "Bugly"],
  ["com.tencent.mmkv", "MMKV"],
  ["com.umeng", "Umeng"],
  ["com.alipay", "Alipay SDK"],
  ["com.stripe", "Stripe"],
  ["com.revenuecat", "RevenueCat"],
  ["com.android.billingclient", "Google Play Billing"],
  ["com.android.installreferrer", "Play Install Referrer"],
];

/** Native library basename (without lib prefix / .so) patterns. */
const NATIVE_SDKS: Array<[RegExp, string]> = [
  [/^libsentry/, "Sentry"],
  [/^libflutter\.so$/, "Flutter"],
  [/^libapp\.so$/, "Flutter (app snapshot)"],
  [/^libhermes/, "Hermes"],
  [/^libreactnative|^libreact_|^libjsi\.so$|^libfbjni\.so$|^libyoga\.so$/, "React Native"],
  [/^libjsc\.so$/, "JavaScriptCore"],
  [/^libc\+\+_shared\.so$/, "C++ runtime"],
  [/^libtensorflowlite|^libtflite/, "TensorFlow Lite"],
  [/^libbarhopper/, "ML Kit barcode"],
  [/^libsqlcipher/, "SQLCipher"],
  [/^libmmkv/, "MMKV"],
  [/^libimage_processing_util_jni/, "CameraX"],
  [/^libdatastore_shared_counter/, "AndroidX DataStore"],
  [/^libconscrypt/, "Conscrypt"],
  [/^librealm/, "Realm"],
  [/^libBugly|^libbugly/, "Bugly"],
  [/^libmmkv/, "MMKV"],
  [/^libsqlite/, "SQLite"],
  [/^libandroidx\.graphics\.path/, "AndroidX Graphics"],
];

/** iOS framework / dylib name patterns. */
const FRAMEWORK_SDKS: Array<[RegExp, string]> = [
  [/^Hands/, "Hands SDK"],
  [/^FirebaseCrashlytics/, "Firebase Crashlytics"],
  [/^FirebaseMessaging/, "Firebase Cloud Messaging"],
  [/^FirebaseAnalytics|^GoogleAppMeasurement/, "Firebase Analytics"],
  [/^Firebase/, "Firebase"],
  [/^GoogleMobileAds/, "Google Mobile Ads"],
  [/^GoogleMaps/, "Google Maps"],
  [/^GoogleSignIn|^GTMAppAuth|^AppAuth/, "Google Sign-In"],
  [/^GoogleUtilities|^GoogleDataTransport|^nanopb|^PromisesObjC|^FBLPromises/, "Firebase support"],
  [/^Sentry/, "Sentry"],
  [/^FBSDK|^FBAEMKit/, "Facebook SDK"],
  [/^React|^yoga$|^RCT/, "React Native"],
  [/^hermes/, "Hermes"],
  [/^Flutter$/, "Flutter"],
  [/^App$/, "Flutter (app snapshot)"],
  [/^Alamofire/, "Alamofire"],
  [/^Kingfisher/, "Kingfisher"],
  [/^SDWebImage/, "SDWebImage"],
  [/^Lottie/, "Lottie"],
  [/^Realm/, "Realm"],
  [/^AppsFlyer/, "AppsFlyer"],
  [/^Amplitude/, "Amplitude"],
  [/^Mixpanel/, "Mixpanel"],
  [/^OneSignal/, "OneSignal"],
  [/^Bugly/, "Bugly"],
  [/^WechatOpenSDK|^WXApi/, "WeChat SDK"],
  [/^Stripe/, "Stripe"],
  [/^RevenueCat/, "RevenueCat"],
  [/^Datadog/, "Datadog"],
  [/^Bugsnag/, "Bugsnag"],
  [/^libswift/, "Swift runtime"],
  [/^MMKV/, "MMKV"],
  [/^Protobuf$|^SwiftProtobuf/, "Protocol Buffers"],
  [/^GRPC|^grpc/, "gRPC"],
  [/^SnapKit/, "SnapKit"],
  [/^RxSwift|^RxCocoa/, "RxSwift"],
];

export function sdkForJavaPackage(pkg: string): string | null {
  let best: [string, string] | null = null;
  for (const entry of JAVA_PACKAGE_SDKS) {
    const prefix = entry[0];
    if ((pkg === prefix || pkg.startsWith(`${prefix}.`)) && (!best || prefix.length > best[0].length)) best = entry;
  }
  return best ? best[1] : null;
}

export function sdkForNativeLib(file: string): string | null {
  return NATIVE_SDKS.find(([re]) => re.test(file))?.[1] ?? null;
}

export function sdkForFramework(name: string): string | null {
  return FRAMEWORK_SDKS.find(([re]) => re.test(name))?.[1] ?? null;
}

/** Top-level domains and vendor roots that take three segments (com.google.firebase). */
const THREE_SEGMENT_ROOTS = new Set([
  "com", "org", "io", "net", "dev", "me", "co", "app", "build", "de", "cn", "uk", "fr", "jp", "ru", "info", "tech", "ai", "us", "edu", "gov",
]);

/**
 * The group a class belongs to: three segments under domain-style roots
 * (com.google.firebase), two otherwise (androidx.compose, kotlinx.coroutines),
 * one for the Kotlin stdlib, java.* and a few single-root libraries
 * (okhttp3, okio, retrofit2, dagger) so they stay single rows. Classes in the default package (R8 output often puts
 * them there) are grouped as "(default package)".
 */
export function packageGroup(className: string): string {
  const parts = className.split(".");
  parts.pop(); // class name
  if (parts.length === 0) return "(default package)";
  const root = parts[0]!;
  if (root === "kotlin" || root === "java" || root === "okhttp3" || root === "okio" || root === "retrofit2" || root === "dagger") {
    return root;
  }
  // com.google.android.{gms,material,play,...} are separate libraries.
  const n = root === "com" && parts[1] === "google" && parts[2] === "android" ? 4 : THREE_SEGMENT_ROOTS.has(root) ? 3 : 2;
  return parts.slice(0, n).join(".");
}
