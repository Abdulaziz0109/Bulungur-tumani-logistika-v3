plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val appVersionCode = (project.findProperty("versionCode") as String?)?.toIntOrNull() ?: 2
val appVersionName = (project.findProperty("versionName") as String?) ?: "1.0.2"

android {
    namespace = "uz.bulungur.mmtb"
    compileSdk = 34

    defaultConfig {
        applicationId = "uz.bulungur.mmtb"
        minSdk = 26
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        create("mmtb") {
            storeFile = file("mmtb-signing.p12")
            storeType = "PKCS12"
            storePassword = "bulungur2026"
            keyAlias = "mmtb"
            keyPassword = "bulungur2026"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("mmtb")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("mmtb")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
}
