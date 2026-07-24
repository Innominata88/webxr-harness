import org.gradle.api.tasks.Copy

plugins {
    id("com.android.application")
}

val appCommit = providers.environmentVariable("NATIVE_APP_COMMIT").orElse("unknown")
val worktreeState = providers.environmentVariable("NATIVE_WORKTREE_STATE").orElse("unknown")
val generatedAssets = layout.buildDirectory.dir("generated/benchmarkAssets")

android {
    namespace = "com.innominata.nativebenchmark"
    compileSdk = 33
    ndkVersion = "25.1.8937393"

    defaultConfig {
        applicationId = "com.innominata.nativebenchmark"
        minSdk = 30
        targetSdk = 33
        versionCode = 1
        versionName = "0.2.0-preview"

        buildConfigField("String", "APP_COMMIT", "\"${appCommit.get()}\"")
        buildConfigField("String", "WORKTREE_STATE", "\"${worktreeState.get()}\"")
        buildConfigField("String", "RUNTIME_FLAVOR", "\"phoneWindow\"")

        externalNativeBuild {
            cmake {
                cppFlags += listOf("-std=c++20", "-Wall", "-Wextra", "-Wpedantic")
                arguments += listOf(
                    "-DANDROID_STL=c++_shared",
                    "-DANDROID_PLATFORM=android-30"
                )
            }
        }

        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    buildTypes {
        debug {
            isDebuggable = true
        }
        release {
            isDebuggable = false
            isMinifyEnabled = false
            // Local research APKs need to be installable without a production key.
            signingConfig = signingConfigs.getByName("debug")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    buildFeatures {
        buildConfig = true
    }

    sourceSets {
        getByName("main").assets.srcDir(generatedAssets)
    }

    androidResources {
        noCompress += "glb"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

val prepareBenchmarkAssets by tasks.registering(Copy::class) {
    into(generatedAssets)
    from(rootProject.file("../../assets/spiderman_2002_movie_version_sam_raimi_0.glb")) {
        into("benchmark")
        rename { "model.glb" }
    }
    from(rootProject.file("../plans")) {
        include("pixel8a_native_*.json", "samsung_fe5g_native_*.json")
        into("benchmark/plans")
    }
}

tasks.named("preBuild").configure {
    dependsOn(prepareBenchmarkAssets)
}
