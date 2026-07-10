plugins {
    id("com.android.library") version "8.7.3"
    id("org.jetbrains.kotlin.android") version "2.0.21"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21"
    id("maven-publish")
}

group = "build.hands"
version = providers.gradleProperty("VERSION_NAME").orElse("0.1.0-SNAPSHOT").get()

android {
    namespace = "build.hands.update"
    compileSdk = 34

    defaultConfig {
        minSdk = 24
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
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    api("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.core:core-ktx:1.13.1")
}

afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components["release"])
                groupId = "build.hands"
                artifactId = "hands-android-sdk"
                version = project.version.toString()

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
