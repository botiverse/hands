import { describe, expect, it } from "vitest";
import { stackSummary } from "../src/routes/feedback";
import { formatRaftNotificationMessage } from "../src/lib/raft_notification_content";

describe("crash alert cause", () => {
  it("summarises a deobfuscated crash log and an SDK ticket message", () => {
    const log = [
      "Crash log", "Stack trace:",
      "java.lang.IllegalArgumentException: Key compose_slock_app_shell#0 was used multiple times",
      "\tat androidx.compose.runtime.saveable.SaveableStateHolderImpl.SaveableStateProvider(SaveableStateHolderImpl.java:88)",
      "\tat androidx.compose.runtime.DisposableEffectImpl.onRemembered(Effects.kt:231)",
      "\tat a.b(c.kt:1)", "\tat d.e(f.kt:2)", "",
    ].join("\n");
    expect(stackSummary(log)).toEqual({
      exception: "java.lang.IllegalArgumentException: Key compose_slock_app_shell#0 was used multiple times",
      frames: [
        "androidx.compose.runtime.saveable.SaveableStateHolderImpl.SaveableStateProvider(SaveableStateHolderImpl.java:88)",
        "androidx.compose.runtime.DisposableEffectImpl.onRemembered(Effects.kt:231)",
        "a.b(c.kt:1)",
      ],
    });
    expect(stackSummary("IllegalStateException: boom\nat e74.i(r8-map-id-ab:7)")).toEqual({
      exception: "IllegalStateException: boom",
      frames: ["e74.i(r8-map-id-ab:7)"],
    });
    expect(stackSummary("Process exited: signaled")).toBeNull();
  });

  it("puts the cause and first frames in the new-group notice", () => {
    const text = formatRaftNotificationMessage({
      event: "crash:new_group",
      payload: {
        app: { name: "Raft Android" },
        signature: "java.lang.IllegalArgumentException@androidx.compose.runtime.saveable.SaveableStateHolderImpl.SaveableStateProvider",
        exception: "java.lang.IllegalArgumentException: Key compose_slock_app_shell#0 was used multiple times",
        top_frames: ["androidx.compose.runtime.saveable.SaveableStateHolderImpl.SaveableStateProvider(SaveableStateHolderImpl.java:88)"],
        version_name: "1.26.0",
        version_code: 12600001,
      },
    });
    expect(text).toContain("Cause: java.lang.IllegalArgumentException: Key compose\\_slock\\_app\\_shell#​0 was used multiple times");
    expect(text).toContain("  at androidx.compose.runtime.saveable.SaveableStateHolderImpl.SaveableStateProvider\\(SaveableStateHolderImpl.java:88\\)");
    expect(text).toContain("Version: 1.26.0 (12600001)");

    const noStack = formatRaftNotificationMessage({
      event: "crash:new_group",
      payload: { app: { name: "Raft Android" }, signature: "ANR@build.raft.app.Main.run", version_name: "1.26.0" },
    });
    expect(noStack).toContain("Group: ANR@\u200bbuild.raft.app.Main.run");
  });
});
