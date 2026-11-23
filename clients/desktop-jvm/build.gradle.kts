import org.gradle.api.publish.maven.tasks.PublishToMavenLocal
import org.gradle.api.publish.maven.tasks.PublishToMavenRepository

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("java-library")
    id("maven-publish")
}

group = "build.hands"
val requestedVersion = providers.gradleProperty("VERSION_NAME")
val sdkVersion = requestedVersion.orElse("0.1.0-SNAPSHOT").get()
if (!Regex("[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?").matches(sdkVersion)) {
    throw GradleException("VERSION_NAME must be a semantic SDK version: $sdkVersion")
}
version = sdkVersion

kotlin {
    jvmToolchain(17)
}

java {
    withSourcesJar()
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    testImplementation(platform("org.junit:junit-bom:5.11.3"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
    // The opt-in production smoke test reads these; everything else is hermetic.
    environment("HANDS_DESKTOP_IT", System.getenv("HANDS_DESKTOP_IT") ?: "")
    testLogging {
        events("failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
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

tasks.withType<PublishToMavenLocal>().configureEach {
    dependsOn(validatePublicationVersion, tasks.test)
}

tasks.withType<PublishToMavenRepository>().configureEach {
    dependsOn(validatePublicationVersion, tasks.test)
}

publishing {
    publications {
        create<MavenPublication>("release") {
            from(components["java"])
            groupId = "build.hands"
            artifactId = "hands-desktop-updater"
            version = project.version.toString()

            pom {
                name.set("Hands Desktop Updater")
                description.set("JVM client for Hands desktop update checks and file-level incremental updates.")
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
                // The registry ignores the Basic username; keep a stable label.
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
