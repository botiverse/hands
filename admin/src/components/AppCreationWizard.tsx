import { errorMessage } from "../lib/errorMessage";
import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Button,
  Input,
  Dialog,
  DialogContent,
  DialogBody,
  DialogFooter,
  DialogClose,
  Select,
  SelectContent,
  SelectList,
  SelectIcon,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Label,
  Textarea,
} from "raft-ui";
import { createApp } from "../lib/api";
import { useText } from "../lib/locale";
import { useToast } from "./Toast";

/**
 * App creation wizard — 3 steps:
 *   1. Basics: name / slug / description
 *   2. Product types: review parser/product families that will be seeded
 *   3. Channels: review seeded distribution lanes
 *
 * On save, the backend `POST /api/apps` handler now seeds default
 * product_types / channels via a single batch insert
 * (see worker/src/routes/apps.ts handleCreateApp). The wizard just
 * collects the basics — the seeding is automatic.
 *
 * The wizard is currently "informational" — it shows what's being created
 * so the user understands the consequences. It should not expose checkboxes
 * for values that the backend does not yet accept.
 */

const DEFAULT_PRODUCT_TYPES: Array<{
  name: string;
  display_name: string;
  description: string;
  display_name_zh: string;
  description_zh: string;
  artifact_note: string;
  artifact_note_zh: string;
}> = [
  {
    name: "android-apk",
    display_name: "Android APK",
    display_name_zh: "Android APK",
    description: "Android application package — direct install",
    description_zh: "Android 应用安装包，可直接安装",
    artifact_note: "APK assets are selected later when creating builds/releases.",
    artifact_note_zh: "创建构建或版本时再选择 APK 文件。",
  },
  {
    name: "ios-ipa",
    display_name: "iOS IPA",
    display_name_zh: "iOS IPA",
    description: "Signed iOS application and dSYM archive",
    description_zh: "已签名的 iOS 应用和 dSYM 符号压缩包",
    artifact_note: "Signed IPA and dSYM assets are uploaded from macOS CI.",
    artifact_note_zh: "从 macOS CI 上传已签名的 IPA 和 dSYM 文件。",
  },
  {
    name: "ohos-app",
    display_name: "OHOS app",
    display_name_zh: "OHOS 应用",
    description: "Signed App Pack and HAP artifacts",
    description_zh: "已签名的 App Pack 和 HAP 文件",
    artifact_note: "AppGallery and sideload artifacts are uploaded from OHOS CI.",
    artifact_note_zh: "从 OHOS CI 上传 AppGallery 和侧载文件。",
  },
  {
    name: "electron-installer",
    display_name: "Electron desktop app",
    display_name_zh: "Electron 桌面应用",
    description: "Cross-platform desktop (darwin / linux / win32)",
    description_zh: "跨平台桌面应用（darwin / linux / win32）",
    artifact_note:
      "Platform-specific installers such as dmg, exe, AppImage, and arch variants are chosen at artifact upload time.",
    artifact_note_zh: "上传文件时选择对应平台的安装包，例如 dmg、exe、AppImage 及不同架构的版本。",
  },
  {
    name: "cli-binary",
    display_name: "Node / CLI binary",
    display_name_zh: "Node / 命令行程序",
    description: "Externally hosted Node SEA or CLI binary",
    description_zh: "由外部托管的 Node SEA 或命令行程序",
    artifact_note:
      "Hands records immutable target URLs, hashes, sizes, and runtime metadata without copying external bytes into Hands storage.",
    artifact_note_zh: "Hands 记录不可变的目标地址、哈希、大小和运行时元数据，不会将外部文件复制到 Hands 存储。",
  },
];

const APP_PLATFORMS = ["android", "ios", "ohos", "electron", "node", "web"] as const;
type AppPlatform = (typeof APP_PLATFORMS)[number];

// Every channel offers the same product types: the ones we support. The three
// default channels are seeded identically so a new app reads as "all of these are
// available". `rn-bundle` is intentionally absent (React Native OTA bundles are
// not shipped).
const DEFAULT_CHANNEL_PRODUCT_TYPES = [
  "android-apk",
  "electron-installer",
  "ios-ipa",
  "ohos-app",
  "cli-binary",
];

const DEFAULT_CHANNELS = [
  {
    slug: "main",
    name: "Main",
    description: "Primary stable lane for normal users",
    description_zh: "面向普通用户的主要稳定渠道",
    enabled_product_types: DEFAULT_CHANNEL_PRODUCT_TYPES,
  },
  {
    slug: "preview",
    name: "Preview",
    description: "Pre-release lane for QA and selected testers",
    description_zh: "供质量验证和受邀测试者使用的预发布渠道",
    enabled_product_types: DEFAULT_CHANNEL_PRODUCT_TYPES,
  },
  {
    slug: "nightly",
    name: "Nightly",
    description: "Fast-moving lane for internal daily validation",
    description_zh: "供内部日常验证快速迭代的渠道",
    enabled_product_types: DEFAULT_CHANNEL_PRODUCT_TYPES,
  },
];

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

export function AppCreationWizard({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useText();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugAuto, setSlugAuto] = useState(true);
  const [description, setDescription] = useState("");
  const [platform, setPlatform] = useState<AppPlatform>("android");
  const createToastId = useRef<string | null>(null);

  const toast = useToast();

  const create = useMutation({
    mutationFn: () =>
      createApp({
        slug: slug || slugify(name),
        name,
        platform,
        description: description.trim() || undefined,
      }),
    onMutate: () => {
      createToastId.current = toast.show({
        kind: "loading",
        title: t(`Creating app '${name}'...`, `正在创建应用“${name}”…`),
        ttlMs: 0,
      });
    },
    onSuccess: () => {
      const patch = {
        kind: "success",
        title: t(`App '${slug || slugify(name)}' created`, `应用“${slug || slugify(name)}”已创建`),
        description: t(`Seeded ${DEFAULT_PRODUCT_TYPES.length} product types and ${DEFAULT_CHANNELS.length} channels`, `已创建 ${DEFAULT_PRODUCT_TYPES.length} 种产品类型和 ${DEFAULT_CHANNELS.length} 个渠道`),
      } as const;
      if (createToastId.current !== null) toast.update(createToastId.current, patch);
      else toast.show(patch);
      createToastId.current = null;
      onCreated();
    },
    onError: (e) => {
      const patch = {
        kind: "error",
        title: t("Failed to create app", "创建应用失败"),
        description: errorMessage(e),
      } as const;
      if (createToastId.current !== null) toast.update(createToastId.current, patch);
      else toast.show(patch);
      createToastId.current = null;
    },
  });

  const canAdvance =
    (step === 1 && name.trim().length > 0 && (slug.trim().length > 0 || slugify(name).length > 0)) ||
    step === 2 ||
    step === 3;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogClose className="absolute top-3 right-3 z-10" />
        <DialogBody>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-6 text-xs text-foreground-muted">
          {[1, 2, 3].map((n) => (
            <div key={n} className="flex items-center gap-2">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center font-medium ${
                  n === step
                    ? "bg-accent text-foreground-inverse"
                    : n < step
                      ? "bg-accent-soft text-accent-strong"
                      : "bg-fill-muted text-foreground-muted"
                }`}
              >
                {n < step ? "✓" : n}
              </div>
              <span className={n === step ? "font-medium text-foreground-strong" : ""}>
                {n === 1 ? t("Basics", "基本信息") : n === 2 ? t("Product types", "产品类型") : t("Channels", "渠道")}
              </span>
              {n < 3 && <span className="text-foreground-hint mx-2">→</span>}
            </div>
          ))}
        </div>

        {step === 1 && (
          <div>
            <h2 className="text-lg font-bold mb-4">{t("Create app — Basics", "创建应用 — 基本信息")}</h2>
            <div className="space-y-3">
              <div>
                <Label>{t("Name *", "名称 *")}</Label>
                <Input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (slugAuto) setSlug(slugify(e.target.value));
                  }}
                  placeholder={t("My App", "我的应用")}
                  autoFocus
                />
              </div>
              <div>
                <Label>{t("Slug (kebab-case, auto-generated from name)", "标识（小写字母和连字符，根据名称自动生成）")}</Label>
                <Input
                  className="font-mono text-xs"
                  value={slug}
                  onChange={(e) => {
                    setSlug(e.target.value);
                    setSlugAuto(false);
                  }}
                  placeholder="my-app"
                />
              </div>
              <div>
                <Label>{t("Platform *", "平台 *")}</Label>
                <Select
                  items={{ android: "Android", ios: "iOS", ohos: "HarmonyOS", electron: "Electron", node: "Node.js", web: t("Web", "网页") }}
                  value={platform}
                  onValueChange={(value) => setPlatform(value as AppPlatform)}
                >
                  <SelectTrigger>
                    <SelectValue />
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectList>
                    {APP_PLATFORMS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {({ android: "Android", ios: "iOS", ohos: "HarmonyOS", electron: "Electron", node: "Node.js", web: t("Web", "网页") })[value]}
                      </SelectItem>
                    ))}
                  </SelectList>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t("Description (optional)", "描述（可选）")}</Label>
                <Textarea
                  className="min-h-[60px]"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t("What does this app do?", "这个应用有什么用途？")}
                />
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="text-lg font-bold mb-4">{t("Create app — Product types", "创建应用 — 产品类型")}</h2>
            <p className="text-sm text-foreground-muted mb-4">
              {t("These product families will be seeded for the app. They define parsers and release flows; concrete platform artifacts are picked later when you upload assets for a release.", "将为此应用创建以下产品类型，用于确定解析方式和发布流程；上传版本文件时再选择具体的平台文件。")}
            </p>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {DEFAULT_PRODUCT_TYPES.map((pt) => (
                <div key={pt.name} className="border border-line-muted rounded-lg p-3">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 h-5 w-5 rounded-full bg-accent-soft text-accent-strong flex items-center justify-center text-xs font-medium">
                      ✓
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{t(pt.display_name, pt.display_name_zh)}</div>
                      <div className="text-xs font-mono text-foreground-muted">{pt.name}</div>
                      <div className="text-xs text-foreground mt-1">{t(pt.description, pt.description_zh)}</div>
                      <div className="text-xs text-foreground-muted mt-2">
                        {t(pt.artifact_note, pt.artifact_note_zh)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 className="text-lg font-bold mb-4">{t("Create app — Channels", "创建应用 — 渠道")}</h2>
            <p className="text-sm text-foreground-muted mb-4">
              {t("Channels are the delivery lanes clients use to fetch updates. Hands keeps maturity simple: publish to main for stable users, preview for validation, and nightly for fast internal iteration.", "客户端通过渠道获取更新。可以发布到 main 供稳定用户使用，发布到 preview 进行验证，或发布到 nightly 供内部快速迭代。")}
            </p>

            <div className="pt-1">
              <div className="text-xs font-medium text-foreground-strong mb-2">
                {t("Default distribution channels (will be seeded):", "将创建以下默认分发渠道：")}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {DEFAULT_CHANNELS.map((c) => (
                  <div
                    key={c.slug}
                    className="border border-line-muted rounded-md p-2 bg-layer-canvas-muted"
                  >
                    <div className="font-medium text-sm">{c.name}</div>
                    <div className="text-xs font-mono text-foreground-muted">{c.slug}</div>
                    <div className="text-xs text-foreground mt-1">
                      {t(c.description, c.description_zh)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        </DialogBody>
        <DialogFooter className="justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={() => (step === 1 ? onClose() : setStep((step - 1) as 1 | 2 | 3))}
          >
            {step === 1 ? t("Cancel", "取消") : t("← Back", "← 返回")}
          </Button>
          {step < 3 ? (
            <Button
              type="button"
              variant="primary"
              onClick={() => setStep((step + 1) as 1 | 2 | 3)}
              disabled={!canAdvance}
            >
              {t("Next →", "下一步 →")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              onClick={() => create.mutate()}
              disabled={
                create.isPending ||
                !name.trim()
              }
            >
              {create.isPending ? t("Creating…", "创建中…") : t("Create app + seed defaults", "创建应用和默认配置")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
