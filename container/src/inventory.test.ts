import { strict as assert } from "node:assert";
import { deflateRawSync } from "node:zlib";
import { test } from "node:test";
import { listZipEntries, readZipEntry } from "./inventory/zip.js";
import { parseDex, readUleb128 } from "./inventory/dex.js";
import { packageGroup, sdkForJavaPackage, sdkForNativeLib, sdkForFramework } from "./inventory/sdks.js";
import { buildAndroidInventory, classifyApkEntry, parseAaptXmlTree, summarizeManifest } from "./inventory/android.js";
import { buildIosInventory, classifyIpaEntry, entitlementsFromExecutable } from "./inventory/ios.js";
import { boundInventory } from "./inventory/common.js";
import { looksMinified, mappingClassLine, readMappingClassMap, withRequestMapping } from "./inventory/mapping.js";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { toXmlPlist, type PlistDict } from "./ios.js";

// ---------- fixtures ----------

function makeZip(files: Array<{ name: string; data: Uint8Array | string; deflate?: boolean }>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = typeof f.data === "string" ? Buffer.from(f.data) : Buffer.from(f.data);
    const body = f.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(f.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(f.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(f.deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}

/** A minimal dex: one string/type per class, each method a code item with `insns` code units. */
function makeDex(classes: Array<{ descriptor: string; methods: number[]; fields?: number }>): Uint8Array {
  const n = classes.length;
  const stringIdsOff = 0x70;
  const typeIdsOff = stringIdsOff + 4 * n;
  const classDefsOff = typeIdsOff + 4 * n;
  const data: number[] = [];
  const dataStart = classDefsOff + 32 * n;
  const at = () => dataStart + data.length;
  const align4 = () => { while (at() % 4) data.push(0); };
  const stringOffs: number[] = [];
  for (const c of classes) {
    stringOffs.push(at());
    data.push(...uleb(c.descriptor.length), ...Buffer.from(c.descriptor), 0);
  }
  const codeOffs: number[][] = [];
  for (const c of classes) {
    const offs: number[] = [];
    for (const insns of c.methods) {
      align4();
      offs.push(at());
      const header = Buffer.alloc(16);
      header.writeUInt16LE(1, 0);
      header.writeUInt32LE(insns, 12);
      data.push(...header, ...new Array(insns * 2).fill(0));
    }
    codeOffs.push(offs);
  }
  const classDataOffs: number[] = [];
  classes.forEach((c, i) => {
    classDataOffs.push(at());
    const fields = c.fields ?? 0;
    data.push(...uleb(fields), ...uleb(0), ...uleb(c.methods.length), ...uleb(0));
    for (let f = 0; f < fields; f++) data.push(...uleb(f === 0 ? 0 : 1), ...uleb(1));
    codeOffs[i]!.forEach((off, m) => data.push(...uleb(m === 0 ? 0 : 1), ...uleb(1), ...uleb(off)));
  });
  const out = Buffer.alloc(dataStart + data.length);
  out.write("dex\n035\0", 0, "latin1");
  out.writeUInt32LE(out.length, 32);
  out.writeUInt32LE(0x70, 36);
  out.writeUInt32LE(0x12345678, 40);
  out.writeUInt32LE(n, 56);
  out.writeUInt32LE(stringIdsOff, 60);
  out.writeUInt32LE(n, 64);
  out.writeUInt32LE(typeIdsOff, 68);
  out.writeUInt32LE(classes.reduce((s, c) => s + c.methods.length, 0), 88);
  out.writeUInt32LE(n, 96);
  out.writeUInt32LE(classDefsOff, 100);
  for (let i = 0; i < n; i++) {
    out.writeUInt32LE(stringOffs[i]!, stringIdsOff + 4 * i);
    out.writeUInt32LE(i, typeIdsOff + 4 * i);
    const def = classDefsOff + 32 * i;
    out.writeUInt32LE(i, def);
    out.writeUInt32LE(classDataOffs[i]!, def + 24);
  }
  Buffer.from(data).copy(out, dataStart);
  return new Uint8Array(out);
}

const XMLTREE = `N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=2)
    A: android:versionCode(0x0101021b)=(type 0x10)0x2a
    A: android:versionName(0x0101021c)="1.2.0" (Raw: "1.2.0")
    A: package="com.example.app" (Raw: "com.example.app")
    E: uses-sdk (line=7)
      A: android:minSdkVersion(0x0101020c)=(type 0x10)0x18
      A: android:targetSdkVersion(0x01010270)=(type 0x10)0x22
    E: uses-permission (line=11)
      A: android:name(0x01010003)="android.permission.INTERNET" (Raw: "android.permission.INTERNET")
    E: uses-permission (line=12)
      A: android:name(0x01010003)="android.permission.POST_NOTIFICATIONS" (Raw: "android.permission.POST_NOTIFICATIONS")
    E: uses-feature (line=13)
      A: android:name(0x01010003)="android.hardware.camera" (Raw: "android.hardware.camera")
      A: android:required(0x0101028e)=(type 0x12)0x0
    E: application (line=20)
      A: android:label(0x01010001)=@0x7f120001
      E: activity (line=25)
        A: android:name(0x01010003)=".MainActivity" (Raw: ".MainActivity")
        A: android:exported(0x01010010)=(type 0x12)0xffffffff
        E: intent-filter (line=28)
          E: action (line=29)
            A: android:name(0x01010003)="android.intent.action.MAIN" (Raw: "android.intent.action.MAIN")
      E: service (line=40)
        A: android:name(0x01010003)="com.google.firebase.components.ComponentDiscoveryService" (Raw: "com.google.firebase.components.ComponentDiscoveryService")
        A: android:exported(0x01010010)=(type 0x12)0x0
        E: meta-data (line=43)
          A: android:name(0x01010003)="com.google.firebase.components:com.google.firebase.messaging.FirebaseMessagingRegistrar" (Raw: "com.google.firebase.components:com.google.firebase.messaging.FirebaseMessagingRegistrar")
          A: android:value(0x01010024)="com.google.firebase.components.ComponentRegistrar" (Raw: "com.google.firebase.components.ComponentRegistrar")
      E: receiver (line=50)
        A: android:name(0x01010003)="build.hands.UpdateReceiver" (Raw: "build.hands.UpdateReceiver")
      E: provider (line=55)
        A: android:name(0x01010003)="androidx.startup.InitializationProvider" (Raw: "androidx.startup.InitializationProvider")
        A: android:authorities(0x01010018)="com.example.app.androidx-startup" (Raw: "com.example.app.androidx-startup")
      E: meta-data (line=60)
        A: android:name(0x01010003)="com.google.android.geo.API_KEY" (Raw: "com.google.android.geo.API_KEY")
        A: android:value(0x01010024)="AIzaSyNotARealSecret" (Raw: "AIzaSyNotARealSecret")
      E: meta-data (line=61)
        A: android:name(0x01010003)="com.google.android.gms.version" (Raw: "com.google.android.gms.version")
        A: android:value(0x01010024)=(type 0x10)0xc
`;

// ---------- zip ----------

test("zip reader lists sizes and inflates stored and deflated entries", () => {
  const zip = makeZip([
    { name: "a.txt", data: "hello" },
    { name: "b.txt", data: "x".repeat(1000), deflate: true },
  ]);
  const entries = listZipEntries(zip);
  assert.deepEqual(entries.map((e) => [e.name, e.uncompressedSize]), [["a.txt", 5], ["b.txt", 1000]]);
  assert.ok(entries[1]!.compressedSize < 1000);
  assert.equal(Buffer.from(readZipEntry(zip, entries[1]!)).toString(), "x".repeat(1000));
  assert.throws(() => listZipEntries(new Uint8Array(30)), /not a zip/);
});

// ---------- dex ----------

test("uleb128 decodes multi-byte values", () => {
  assert.deepEqual(readUleb128(Uint8Array.from([0xe5, 0x8e, 0x26]), 0), [624485, 3]);
});

test("dex parser reads class names, method counts and code weight", () => {
  const dex = parseDex(makeDex([
    { descriptor: "Lio/sentry/Sentry;", methods: [10, 20], fields: 1 },
    { descriptor: "Lcom/example/app/MainActivity;", methods: [4] },
    { descriptor: "La;", methods: [] },
  ]));
  assert.equal(dex.version, "035");
  assert.deepEqual(dex.classes.map((c) => [c.name, c.methods]), [
    ["io.sentry.Sentry", 2], ["com.example.app.MainActivity", 1], ["a", 0],
  ]);
  // 32 class_def + 8 field + 2*(8 + 16) method overhead + (10+20)*2 code bytes
  assert.equal(dex.classes[0]!.weight, 32 + 8 + 48 + 60);
  assert.equal(dex.totalWeight, dex.classes.reduce((s, c) => s + c.weight, 0));
  assert.throws(() => parseDex(new Uint8Array(200)), /not a dex/);
});

test("package grouping and SDK names", () => {
  assert.equal(packageGroup("com.google.firebase.messaging.FirebaseMessaging"), "com.google.firebase");
  assert.equal(packageGroup("androidx.compose.ui.Modifier"), "androidx.compose");
  assert.equal(packageGroup("kotlinx.coroutines.Job"), "kotlinx.coroutines");
  assert.equal(packageGroup("kotlin.collections.ArraysKt"), "kotlin");
  assert.equal(packageGroup("okhttp3.internal.Util"), "okhttp3");
  assert.equal(packageGroup("a"), "(default package)");
  assert.equal(packageGroup("com.google.android.gms.tasks.Task"), "com.google.android.gms");
  assert.equal(sdkForJavaPackage("com.google.firebase"), "Firebase");
  assert.equal(sdkForJavaPackage("io.sentry.android"), "Sentry");
  assert.equal(sdkForJavaPackage("build.hands.sdk"), "Hands SDK");
  assert.equal(sdkForJavaPackage("androidx.compose"), "Jetpack Compose");
  assert.equal(sdkForJavaPackage("com.example.app"), null);
  assert.equal(sdkForNativeLib("libsentry-android.so"), "Sentry");
  assert.equal(sdkForFramework("FirebaseMessaging"), "Firebase Cloud Messaging");
});

// ---------- android ----------

test("APK entries are categorized by role and ABI", () => {
  assert.equal(classifyApkEntry("classes2.dex").key, "dex");
  assert.equal(classifyApkEntry("lib/arm64-v8a/libfoo.so").key, "native/arm64-v8a");
  assert.equal(classifyApkEntry("res/drawable/a.png").key, "resources");
  assert.equal(classifyApkEntry("resources.arsc").key, "resources");
  assert.equal(classifyApkEntry("assets/model.bin").key, "assets");
  assert.equal(classifyApkEntry("kotlin/collections.kotlin_builtins").key, "kotlin");
  assert.equal(classifyApkEntry("META-INF/CERT.RSA").key, "meta_inf");
  assert.equal(classifyApkEntry("AndroidManifest.xml").key, "other");
  assert.equal(classifyApkEntry("org/bouncycastle/x.properties").key, "java_resources");
});

test("aapt xmltree output becomes components without meta-data string values", () => {
  const manifest = parseAaptXmlTree(XMLTREE);
  assert.ok(manifest);
  const { app, components } = summarizeManifest(manifest);
  assert.deepEqual(app, { package_id: "com.example.app", version_code: 42, version_name: "1.2.0", min_sdk: 24, target_sdk: 34 });
  assert.deepEqual(components.permissions, ["android.permission.INTERNET", "android.permission.POST_NOTIFICATIONS"]);
  assert.deepEqual(components.features, ["android.hardware.camera"]);
  assert.deepEqual(components.activities, ["com.example.app.MainActivity (exported)"]);
  assert.deepEqual(components.services, ["com.google.firebase.components.ComponentDiscoveryService"]);
  assert.deepEqual(components.receivers, ["build.hands.UpdateReceiver"]);
  assert.deepEqual(components.providers, ["androidx.startup.InitializationProvider"]);
  assert.deepEqual(components.meta_data, [
    "com.google.android.geo.API_KEY",
    "com.google.android.gms.version=12",
    "com.google.firebase.components:com.google.firebase.messaging.FirebaseMessagingRegistrar",
  ]);
  assert.ok(!JSON.stringify(components).includes("AIzaSy"));
});

test("APK inventory: categories, native libraries per ABI, dex packages with estimated sizes", () => {
  const dex = makeDex([
    { descriptor: "Lio/sentry/Sentry;", methods: [300] },
    { descriptor: "Lio/sentry/Hub;", methods: [100] },
    { descriptor: "Lcom/example/app/MainActivity;", methods: [100] },
  ]);
  const apk = makeZip([
    { name: "AndroidManifest.xml", data: "binary-xml" },
    { name: "classes.dex", data: dex, deflate: true },
    { name: "lib/arm64-v8a/libsentry.so", data: new Uint8Array(4000) },
    { name: "lib/armeabi-v7a/libsentry.so", data: new Uint8Array(3000) },
    { name: "lib/arm64-v8a/libapp.so", data: new Uint8Array(500) },
    { name: "res/drawable/icon.png", data: new Uint8Array(800) },
    { name: "resources.arsc", data: new Uint8Array(200) },
    { name: "assets/data.json", data: "{}".repeat(100), deflate: true },
    { name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0" },
  ]);
  const inv = buildAndroidInventory({ bytes: apk, manifestXmlTree: XMLTREE });
  assert.equal(inv.schema, 1);
  assert.equal(inv.platform, "android");
  assert.equal(inv.total_bytes, apk.byteLength);
  const cat = Object.fromEntries(inv.categories.map((c) => [c.key, c]));
  assert.equal(cat.dex!.bytes, dex.byteLength);
  assert.ok(cat.dex!.compressed_bytes < dex.byteLength);
  assert.equal(cat["native/arm64-v8a"]!.bytes, 4500);
  assert.equal(cat["native/armeabi-v7a"]!.bytes, 3000);
  assert.equal(cat.resources!.bytes, 1000);
  assert.equal(inv.categories[0]!.key, "dex");
  assert.equal(inv.largest_files[0]!.path, "lib/arm64-v8a/libsentry.so");

  const sentryNative = inv.libraries.find((l) => l.kind === "native" && l.name === "libsentry.so")!;
  assert.deepEqual(sentryNative.abis, ["arm64-v8a", "armeabi-v7a"]);
  assert.equal(sentryNative.bytes, 7000);
  assert.equal(sentryNative.sdk, "Sentry");

  const sentryDex = inv.libraries.find((l) => l.kind === "dex-package" && l.name === "io.sentry")!;
  const appDex = inv.libraries.find((l) => l.kind === "dex-package" && l.name === "com.example.app")!;
  assert.equal(sentryDex.classes, 2);
  assert.equal(sentryDex.sdk, "Sentry");
  assert.equal(sentryDex.estimated, true);
  // The two packages split the whole dex file, roughly 4:1 by code size.
  assert.ok(Math.abs(sentryDex.bytes + appDex.bytes - dex.byteLength) <= 1);
  assert.ok(sentryDex.bytes > 3 * appDex.bytes);

  const sentrySdk = inv.sdks.find((s) => s.name === "Sentry")!;
  assert.deepEqual(sentrySdk.kinds.sort(), ["dex-package", "native"]);
  assert.equal(inv.components.permissions!.length, 2);
  assert.equal(inv.dex!.classes, 3);
  assert.equal(inv.app.package_id, "com.example.app");
});

test("APK inventory without aapt output still has sizes and says why components are missing", () => {
  const apk = makeZip([{ name: "AndroidManifest.xml", data: "x" }, { name: "classes.dex", data: makeDex([{ descriptor: "La/b;", methods: [1] }]) }]);
  const inv = buildAndroidInventory({ bytes: apk, manifestXmlTree: null, manifestError: "aapt missing" });
  assert.deepEqual(inv.components, {});
  assert.ok(inv.notes.some((n) => n.includes("aapt missing")));
  assert.throws(() => buildAndroidInventory({ bytes: makeZip([{ name: "base/dex/classes.dex", data: "x" }]) }), /not an APK/);
});

// ---------- R8 mapping ----------

const MAPPING = [
  "# compiler: R8",
  "# pg_map_id: 1234567",
  "io.sentry.Sentry -> a:",
  "    int count -> a",
  "    1:5:void init():10:14 -> b",
  "io.sentry.Hub -> b:",
  "# {\"id\":\"sourceFile\",\"fileName\":\"Hub.java\"}",
  "    void capture() -> a",
  "androidx.compose.runtime.Composer -> c:\r",
  "com.example.app.MainActivity -> com.example.app.MainActivity:",
  "    void onCreate(android.os.Bundle) -> onCreate",
].join("\n");

test("mapping class lines are parsed and member/comment lines skipped", async () => {
  assert.deepEqual(mappingClassLine("io.sentry.Sentry -> a:"), { original: "io.sentry.Sentry", obfuscated: "a" });
  assert.equal(mappingClassLine("    void capture() -> a"), null);
  assert.equal(mappingClassLine("# compiler: R8"), null);
  // Split across chunks in the middle of a line, with CRLF.
  const bytes = Buffer.from(MAPPING);
  const chunks = [bytes.subarray(0, 17), bytes.subarray(17, 90), bytes.subarray(90)];
  const map = await readMappingClassMap(Readable.from(chunks));
  assert.deepEqual([...map.entries()], [
    ["a", "io.sentry.Sentry"],
    ["b", "io.sentry.Hub"],
    ["c", "androidx.compose.runtime.Composer"],
    ["com.example.app.MainActivity", "com.example.app.MainActivity"],
  ]);
});

test("minified class names are recognized", () => {
  for (const n of ["a", "bc", "e74", "a.b.c", "x$y"]) assert.ok(looksMinified(n), n);
  for (const n of ["io.sentry.Sentry", "com.example.R", "dev.hands.App", "abcd"]) assert.ok(!looksMinified(n), n);
});

function obfuscatedApk() {
  const classes = [
    { descriptor: "La;", methods: [300] },
    { descriptor: "Lb;", methods: [100] },
    { descriptor: "Lc;", methods: [200] },
    { descriptor: "Lcom/example/app/MainActivity;", methods: [100] },
    // Not in the mapping: stays under its dex package.
    { descriptor: "Lzz/q;", methods: [50] },
    ...Array.from({ length: 55 }, (_, i) => ({ descriptor: `Lf${i};`, methods: [1] })),
  ];
  return makeZip([
    { name: "AndroidManifest.xml", data: "x" },
    { name: "classes.dex", data: makeDex(classes), deflate: true },
  ]);
}

test("APK inventory restores package names from the R8 mapping", async () => {
  const apk = obfuscatedApk();
  const plain = buildAndroidInventory({ bytes: apk });
  assert.equal(plain.dex!.obfuscated, true);
  assert.equal(plain.mapping, undefined);
  assert.ok(plain.libraries.some((l) => l.name === "(default package)"));

  const classMap = await readMappingClassMap(Readable.from([MAPPING]));
  const inv = buildAndroidInventory({ bytes: apk, classMap });
  assert.deepEqual(inv.mapping, { used: true, classes_mapped: 4, classes_unmapped: 56 });
  // Judged on the names in the dex, not the restored ones.
  assert.equal(inv.dex!.obfuscated, true);
  const lib = (name: string) => inv.libraries.find((l) => l.kind === "dex-package" && l.name === name);
  assert.equal(lib("io.sentry")!.classes, 2);
  assert.equal(lib("io.sentry")!.sdk, "Sentry");
  assert.equal(lib("androidx.compose")!.classes, 1);
  assert.equal(lib("com.example.app")!.classes, 1);
  assert.equal(lib("zz")!.classes, 1);
  // The 55 unmapped default-package classes stay where they were.
  assert.equal(lib("(default package)")!.classes, 55);
  // Same size estimate: sizes add up to the same total with or without the mapping.
  const dexTotal = (i: typeof inv) => i.libraries.filter((l) => l.kind === "dex-package").reduce((s, l) => s + l.bytes, 0);
  assert.ok(Math.abs(dexTotal(inv) - dexTotal(plain)) <= 6);
  // The default package's former bytes now belong to Sentry and Compose (rounding aside).
  const before = plain.libraries.find((l) => l.name === "(default package)")!.bytes;
  assert.ok(Math.abs(before - lib("(default package)")!.bytes - lib("androidx.compose")!.bytes - lib("io.sentry")!.bytes) <= 2);
  assert.ok(inv.sdks.some((s) => s.name === "Sentry"));
  // Most classes are unmapped here, so the inventory says the mapping may be for another build.
  assert.ok(inv.notes.some((n) => n.includes("matched only 4 of 60 classes")));
});

test("an unreadable mapping leaves names alone and says why", () => {
  const inv = buildAndroidInventory({ bytes: obfuscatedApk(), mappingError: "mapping download returned 403" });
  assert.equal(inv.mapping, undefined);
  assert.ok(inv.notes.some((n) => n.includes("mapping download returned 403")));
});

test("the request mapping is downloaded to a temp file and removed afterwards", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/mapping.txt?sig=secret") res.end(MAPPING);
    else res.writeHead(403).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    let seenPath = "";
    const map = await withRequestMapping(`http://127.0.0.1:${port}/mapping.txt?sig=secret`, async (m) => {
      assert.equal(m.mappingError, undefined);
      seenPath = m.mappingPath!;
      assert.ok(existsSync(seenPath));
      const { createReadStream } = await import("node:fs");
      return readMappingClassMap(createReadStream(seenPath));
    });
    assert.equal(map.get("a"), "io.sentry.Sentry");
    assert.ok(!existsSync(seenPath));

    const failed = await withRequestMapping(`http://127.0.0.1:${port}/other`, async (m) => m);
    assert.equal(failed.mappingPath, undefined);
    assert.match(failed.mappingError!, /403/);
    assert.ok(!failed.mappingError!.includes("127.0.0.1"));
    assert.deepEqual(await withRequestMapping(undefined, async (m) => m), {});
    assert.ok((await withRequestMapping("file:///etc/passwd", async (m) => m)).mappingError);
  } finally {
    server.close();
  }
});

test("inventories are bounded in size", () => {
  const apk = makeZip([{ name: "AndroidManifest.xml", data: "x" }]);
  const inv = buildAndroidInventory({ bytes: apk });
  inv.files = Array.from({ length: 4000 }, (_, i) => ({ path: `assets/${"x".repeat(100)}${i}`, bytes: i, compressed_bytes: i, category: "assets" }));
  const bounded = boundInventory(inv, 64 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 64 * 1024);
  assert.equal(bounded.truncated, true);
});

// ---------- ios ----------

function plist(dict: PlistDict): string {
  return toXmlPlist(dict);
}

function entitlementsBlob(dict: PlistDict): Uint8Array {
  const xml = Buffer.from(plist(dict));
  const blob = Buffer.alloc(8);
  blob.writeUInt32BE(0xfade7171, 0);
  blob.writeUInt32BE(8 + xml.length, 4);
  return new Uint8Array(Buffer.concat([Buffer.from("\xcf\xfa\xed\xfe machine code ", "latin1"), blob, xml, Buffer.alloc(64)]));
}

test("IPA entries are categorized relative to the app bundle", () => {
  const root = "Payload/Demo.app/";
  assert.equal(classifyIpaEntry(`${root}Demo`, root, "Demo").key, "executable");
  assert.equal(classifyIpaEntry(`${root}Frameworks/Sentry.framework/Sentry`, root, "Demo").key, "frameworks");
  assert.equal(classifyIpaEntry("Symbols/9D43A923-C40C-3E7D-AA6D-9FE5E56B06A8.symbols", root, "Demo").key, "symbols");
  assert.equal(classifyIpaEntry(`${root}compose-resources/composeResources/app/values/strings.commonMain.cvr`, root, "Demo").key, "compose_resources");
  assert.equal(classifyIpaEntry(`${root}PlugIns/Widget.appex/Widget`, root, "Demo").key, "plugins");
  assert.equal(classifyIpaEntry(`${root}Assets.car`, root, "Demo").key, "assets_car");
  assert.equal(classifyIpaEntry(`${root}Settings.bundle/Root.plist`, root, "Demo").key, "bundles");
  assert.equal(classifyIpaEntry(`${root}zh-Hans.lproj/Localizable.strings`, root, "Demo").key, "localizations");
  assert.equal(classifyIpaEntry(`${root}_CodeSignature/CodeResources`, root, "Demo").key, "signature");
  assert.equal(classifyIpaEntry("SwiftSupport/iphoneos/libswiftCore.dylib", root, "Demo").key, "swift_support");
});

test("IPA inventory: frameworks with versions, Info.plist capabilities and entitlements", () => {
  const root = "Payload/Demo.app/";
  const info = plist({
    CFBundleIdentifier: "com.example.demo",
    CFBundleShortVersionString: "2.0",
    CFBundleVersion: "200",
    CFBundleExecutable: "Demo",
    MinimumOSVersion: "16.0",
    NSCameraUsageDescription: "Scan codes",
    NSLocationWhenInUseUsageDescription: "Find stores",
    UIBackgroundModes: ["remote-notification", "fetch"],
    CFBundleURLTypes: [{ CFBundleURLSchemes: ["demo", "fb123"] }],
    LSApplicationQueriesSchemes: ["weixin"],
    NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSExceptionDomains: { "legacy.example.com": { NSExceptionAllowsInsecureHTTPLoads: true } } },
  });
  const ipa = makeZip([
    { name: `${root}Info.plist`, data: info },
    { name: `${root}Demo`, data: entitlementsBlob({
      "application-identifier": "TEAM.com.example.demo",
      "aps-environment": "production",
      "com.apple.developer.associated-domains": ["applinks:example.com", "webcredentials:example.com"],
    }) },
    { name: `${root}Assets.car`, data: new Uint8Array(5000) },
    { name: `${root}Frameworks/Sentry.framework/Sentry`, data: new Uint8Array(3000) },
    { name: `${root}Frameworks/Sentry.framework/Info.plist`, data: plist({ CFBundleIdentifier: "io.sentry.Sentry", CFBundleShortVersionString: "8.36.0" }) },
    { name: `${root}Frameworks/libswiftCore.dylib`, data: new Uint8Array(1000) },
    { name: `${root}PlugIns/Widget.appex/Widget`, data: new Uint8Array(700) },
    { name: `${root}PlugIns/Widget.appex/Info.plist`, data: plist({ CFBundleIdentifier: "com.example.demo.widget", CFBundleShortVersionString: "2.0", NSExtension: { NSExtensionPointIdentifier: "com.apple.widgetkit-extension" } }) },
    { name: `${root}en.lproj/Localizable.strings`, data: "a=b" },
  ]);
  const inv = buildIosInventory(ipa);
  assert.equal(inv.platform, "ios");
  assert.equal(inv.app.bundle_id, "com.example.demo");
  assert.equal(inv.app.min_os, "16.0");
  const cat = Object.fromEntries(inv.categories.map((c) => [c.key, c.bytes]));
  assert.equal(cat.assets_car, 5000);
  assert.ok(cat.frameworks! > 4000);
  assert.ok(cat.executable! > 0);

  const sentry = inv.libraries.find((l) => l.name === "Sentry")!;
  assert.equal(sentry.kind, "framework");
  assert.equal(sentry.version, "8.36.0");
  assert.equal(sentry.sdk, "Sentry");
  assert.equal(inv.libraries.find((l) => l.name === "libswiftCore.dylib")?.sdk, "Swift runtime");
  const widget = inv.libraries.find((l) => l.kind === "extension")!;
  assert.equal(widget.bundle_id, "com.example.demo.widget");

  assert.deepEqual(inv.components.permissions, ["NSCameraUsageDescription", "NSLocationWhenInUseUsageDescription"]);
  assert.deepEqual(inv.components.background_modes, ["fetch", "remote-notification"]);
  assert.deepEqual(inv.components.url_schemes, ["demo", "fb123"]);
  assert.deepEqual(inv.components.queries_schemes, ["weixin"]);
  assert.deepEqual(inv.components.ats_exceptions, ["NSAllowsArbitraryLoads", "legacy.example.com (NSExceptionAllowsInsecureHTTPLoads)"]);
  assert.deepEqual(inv.components.extensions, ["com.example.demo.widget (com.apple.widgetkit-extension)"]);
  assert.deepEqual(inv.components.entitlements, [
    "application-identifier",
    "aps-environment",
    "com.apple.developer.associated-domains: applinks:example.com",
    "com.apple.developer.associated-domains: webcredentials:example.com",
  ]);
  // Usage description text and entitlement values (other than domains) stay out.
  const json = JSON.stringify(inv);
  assert.ok(!json.includes("Scan codes"));
  assert.ok(!json.includes("TEAM.com.example.demo"));
});

test("IPA entitlements fall back to the provisioning profile", () => {
  const root = "Payload/Demo.app/";
  const profile = Buffer.concat([
    Buffer.from([0x30, 0x82, 0x01, 0x00]),
    Buffer.from(plist({ Name: "Demo", Entitlements: { "aps-environment": "production", "get-task-allow": false } })),
    Buffer.from([0xa0, 0x00]),
  ]);
  const ipa = makeZip([
    { name: `${root}Info.plist`, data: plist({ CFBundleIdentifier: "com.example.demo", CFBundleExecutable: "Demo" }) },
    { name: `${root}Demo`, data: new Uint8Array(100) },
    { name: `${root}embedded.mobileprovision`, data: profile },
  ]);
  const inv = buildIosInventory(ipa);
  assert.deepEqual(inv.components.entitlements, ["aps-environment", "get-task-allow"]);
  assert.ok(inv.notes.some((n) => n.includes("provisioning profile")));
  assert.equal(entitlementsFromExecutable(new Uint8Array(64)), null);
});
