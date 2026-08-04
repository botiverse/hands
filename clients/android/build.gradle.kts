import org.gradle.api.publish.maven.tasks.PublishToMavenLocal
import org.gradle.api.publish.maven.tasks.PublishToMavenRepository

plugins {
    id("com.android.library") version "8.7.3"
    id("org.jetbrains.kotlin.android") version "2.0.21"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21"
    id("maven-publish")
}

group = "build.hands"
val requestedVersion = providers.gradleProperty("VERSION_NAME")
val sdkVersion = requestedVersion.orElse("0.1.0-SNAPSHOT").get()
if (!Regex("[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?").matches(sdkVersion)) {
    throw GradleException("VERSION_NAME must be a semantic SDK version: $sdkVersion")
}
version = sdkVersion

val nativeSymbolsZip = layout.buildDirectory.file(
    "outputs/native-symbols/hands-android-sdk-${project.version}-native-symbols.zip"
)
val releaseAar = layout.buildDirectory.file(
    "outputs/aar/hands-android-sdk-release.aar"
)
val verifyAndroidElfScript = rootProject.file("../../scripts/verify_android_elf_alignment.py")
val testAndroidElfScript = rootProject.file("../../scripts/test_verify_android_elf_alignment.py")

val packageReleaseNativeSymbols by tasks.registering(Exec::class) {
    dependsOn("externalNativeBuildRelease")
    inputs.file(rootProject.file("../../scripts/package_android_native_symbols.sh"))
    outputs.file(nativeSymbolsZip)
    outputs.upToDateWhen { false }
    commandLine(
        "bash",
        rootProject.file("../../scripts/package_android_native_symbols.sh"),
        "--build-dir",
        layout.buildDirectory.get().asFile,
        "--output",
        nativeSymbolsZip.get().asFile,
        "--sdk-version",
        project.version.toString()
    )
}

val testNativeRecordIdentity by tasks.registering(Exec::class) {
    inputs.files(
        file("src/main/cpp/hands_record_file.c"),
        file("src/main/cpp/hands_record_file.h"),
        file("src/test/cpp/hands_record_file_test.c"),
        file("src/test/scripts/test_qnc2_record_identity.sh"),
    )
    commandLine("bash", file("src/test/scripts/test_qnc2_record_identity.sh"))
}

val testAndroidElfVerifier by tasks.registering(Exec::class) {
    group = "verification"
    description = "Runs deterministic unit tests for the Android ELF verifier."
    inputs.files(verifyAndroidElfScript, testAndroidElfScript)
    environment("PYTHONDONTWRITEBYTECODE", "1")
    commandLine("python3", testAndroidElfScript)
}

val verifyReleaseAarElfAlignment by tasks.registering(Exec::class) {
    group = "verification"
    description = "Verifies every 64-bit ELF packaged in the release AAR."
    dependsOn("assembleRelease")
    inputs.files(verifyAndroidElfScript, releaseAar)
    commandLine("python3", verifyAndroidElfScript, "--archive", releaseAar.get().asFile)
}

val verifyReleaseNativeSymbolsElfAlignment by tasks.registering(Exec::class) {
    group = "verification"
    description = "Verifies every 64-bit ELF packaged in the native-symbols archive."
    dependsOn(packageReleaseNativeSymbols)
    inputs.files(verifyAndroidElfScript, nativeSymbolsZip)
    commandLine("python3", verifyAndroidElfScript, "--archive", nativeSymbolsZip.get().asFile)
}

val verifyReleaseElfAlignment by tasks.registering {
    group = "verification"
    description = "Publication gate for release AAR and native-symbols 16 KB ELF alignment."
    dependsOn(
        testAndroidElfVerifier,
        verifyReleaseAarElfAlignment,
        verifyReleaseNativeSymbolsElfAlignment,
    )
}

val validatePublicationVersion by tasks.registering {
    group = "verification"
    description = "Refuses Maven publication without one explicit SDK version source."
    doLast {
        if (!requestedVersion.isPresent) {
            throw GradleException("Refusing Maven publication without -PVERSION_NAME")
        }
    }
}

android {
    namespace = "build.hands.update"
    compileSdk = 34

    defaultConfig {
        minSdk = 24
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "HANDS_SDK_VERSION", "\"$sdkVersion\"")
        consumerProguardFiles("consumer-rules.pro")
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }
    ndkVersion = "26.3.11579264"

    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    api("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-process:2.8.7")
    // Delta (incremental) APK apply. Maintained fork of Google's Play-Store
    // file-by-file engine; the CLI/CI side generates patches with the SAME jar.
    implementation("com.eidu:archive-patcher:3.0.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}

tasks.matching { it.name == "testReleaseUnitTest" }.configureEach {
    dependsOn(testNativeRecordIdentity)
}

tasks.withType<PublishToMavenLocal>().configureEach {
    dependsOn(validatePublicationVersion, verifyReleaseElfAlignment)
}

tasks.withType<PublishToMavenRepository>().configureEach {
    dependsOn(validatePublicationVersion, verifyReleaseElfAlignment)
}

afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components["release"])
                groupId = "build.hands"
                artifactId = "hands-android-sdk"
                version = project.version.toString()
                artifact(nativeSymbolsZip) {
                    classifier = "native-symbols"
                    extension = "zip"
                    builtBy(packageReleaseNativeSymbols)
                }

                pom {
                    name.set("Hands Android SDK")
                    description.set("Android SDK for server-side Hands update checks and APK installation.")
                    url.set("https://github.com/botiverse/hands")
                    licenses {
                        license {
                            name.set("MIT License")
                            url.set("https://opensource.org/licenses/MIT")
                        }
                    }
                    developers {
                        developer {
                            id.set("oranix-io")
                            name.set("Oranix")
                        }
                    }
                    scm {
                        connection.set("scm:git:https://github.com/botiverse/hands.git")
                        developerConnection.set("scm:git:ssh://git@github.com/botiverse/hands.git")
                        url.set("https://github.com/botiverse/hands")
                    }
                }
            }
        }

        repositories {
            maven {
                name = "RaftArtifacts"
                url = uri("https://maven.artifacts.botiverse.dev")
                credentials {
                    // The registry intentionally ignores the Basic username;
                    // keep a stable label here so build diagnostics identify
                    // which credential class was expected without printing it.
                    username = "hands-ci"
                    password = System.getenv("RAFT_ARTIFACTS_TOKEN")
                }
            }

            maven {
                name = "GitHubPackages"
                val repository = System.getenv("GITHUB_REPOSITORY") ?: "botiverse/hands"
                url = uri("https://maven.pkg.github.com/$repository")
                credentials {
                    username = findProperty("gpr.user") as String?
                        ?: System.getenv("GITHUB_ACTOR")
                    password = findProperty("gpr.key") as String?
                        ?: System.getenv("GITHUB_TOKEN")
                }
            }
        }
    }
}
