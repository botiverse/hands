import { describe, expect, it } from "vitest";
import { retracedSignature } from "../src/routes/feedback";

const log = (header: string, frames: string[]) =>
  ["Crash log", "Version code: 12600001", "", "Stack trace:", header, ...frames.map((f) => `\tat ${f}`), ""].join("\n");

describe("retracedSignature", () => {
  it("groups by the exception class and its first frame, without line numbers", () => {
    expect(retracedSignature(log(
      "java.lang.IllegalArgumentException: Key compose_slock_app_shell#0 was used multiple times ",
      [
        "androidx.compose.runtime.saveable.SaveableStateHolderImpl.SaveableStateProvider$lambda$0$1$0(SaveableStateHolderImpl.java:88)",
        "androidx.compose.runtime.DisposableEffectImpl.onRemembered(Effects.kt:231)",
      ],
    ))).toBe("java.lang.IllegalArgumentException@androidx.compose.runtime.saveable.SaveableStateHolderImpl.SaveableStateProvider$lambda$0$1$0");
  });

  it("skips throw helpers to the frame that raised the error", () => {
    expect(retracedSignature(log(
      "java.lang.IllegalArgumentException: LayoutNode 33845 not found in RectList",
      [
        "androidx.compose.ui.internal.InlineClassHelperKt.throwIllegalArgumentException(InlineClassHelper.kt:36)",
        "androidx.compose.ui.spatial.RectManager.indexInRectList(RectManager.kt:963)",
      ],
    ))).toBe("java.lang.IllegalArgumentException@androidx.compose.ui.spatial.RectManager.indexInRectList");
    expect(retracedSignature(log("java.lang.NullPointerException", [
      "kotlin.jvm.internal.Intrinsics.checkNotNull(Intrinsics.java:1)",
      "build.raft.app.Foo.bar(Foo.kt:3)",
    ]))).toBe("java.lang.NullPointerException@build.raft.app.Foo.bar");
  });

  it("is the same across builds whose obfuscated names differ", () => {
    const frames = ["build.raft.app.chat.Composer.send(Composer.kt:10)"];
    expect(retracedSignature(log("java.lang.IllegalStateException: x", frames)))
      .toBe(retracedSignature(log("java.lang.IllegalStateException: y", ["build.raft.app.chat.Composer.send(Composer.kt:99)"])));
  });

  it("returns null when there is no exception with frames", () => {
    expect(retracedSignature("Crash log\nnothing here\n")).toBeNull();
    expect(retracedSignature("\tat a.b.c(X.kt:1)\n")).toBeNull();
  });
});
