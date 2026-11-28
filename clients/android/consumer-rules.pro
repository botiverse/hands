# Consumers can shrink the SDK normally, except for JNI bindings: native
# methods resolve by class and method name, so a renamed BundledZlib or
# ZucchiniNative would fail to load and silently turn delta updates off.
-keepclasseswithmembernames class build.hands.update.internal.BundledZlib {
    native <methods>;
}
-keepclasseswithmembernames class build.hands.update.internal.ZucchiniNative {
    native <methods>;
}
