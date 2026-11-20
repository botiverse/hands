import { errorMessage } from "../lib/errorMessage";
import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Input,
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogClose,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Select,
  SelectContent,
  SelectList,
  SelectIcon,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  TextLink,
  Textarea,
} from "@botiverse/raft-ui";
import { createApp } from "../lib/api";
import { useText } from "../lib/locale";
import { useToast } from "./Toast";

/**
 * New app — one form dialog (design: patterns/forms "Forms in a dialog"):
 * name, slug, platform and an optional description, then Cancel and Create.
 *
 * On save, the backend `POST /api/apps` handler seeds the default
 * product_types / channels via a single batch insert
 * (see worker/src/routes/apps.ts handleCreateApp). The dialog only collects
 * the basics and says, under the fields, which channels and product types
 * are set up. It should not expose checkboxes for values that the backend
 * does not yet accept.
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
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugAuto, setSlugAuto] = useState(true);
  const [description, setDescription] = useState("");
  const [platform, setPlatform] = useState<AppPlatform>("android");
  const [showSeeded, setShowSeeded] = useState(false);
  const createToastId = useRef<string | null>(null);

  const toast = useToast();
  const finalSlug = slug.trim() || slugify(name);
  const platformLabels: Record<AppPlatform, string> = {
    android: "Android", ios: "iOS", ohos: "HarmonyOS", electron: "Electron", node: "Node.js", web: t("Web", "网页"),
  };

  const create = useMutation({
    mutationFn: () =>
      createApp({
        slug: finalSlug,
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
        title: t(`App '${finalSlug}' created`, `应用“${finalSlug}”已创建`),
        description: t(`Set up ${DEFAULT_CHANNELS.length} channels and ${DEFAULT_PRODUCT_TYPES.length} product types`, `已创建 ${DEFAULT_CHANNELS.length} 个渠道和 ${DEFAULT_PRODUCT_TYPES.length} 种产品类型`),
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

  const canCreate = name.trim().length > 0 && finalSlug.length > 0 && !create.isPending;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("New app", "新建应用")}</DialogTitle>
          <DialogClose />
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (canCreate) create.mutate();
          }}
        >
          <DialogBody className="grid gap-5">
            <Field>
              <FieldLabel htmlFor="new-app-name">{t("Name", "名称")}</FieldLabel>
              <Input
                id="new-app-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (slugAuto) setSlug(slugify(e.target.value));
                }}
                placeholder={t("My App", "我的应用")}
                aria-required
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-app-slug">{t("Slug", "标识")}</FieldLabel>
              <Input
                id="new-app-slug"
                className="font-mono"
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value);
                  setSlugAuto(false);
                }}
                placeholder="my-app"
                aria-required
              />
              <FieldDescription>
                {t("Used in URLs and the CLI. Lowercase letters, numbers and dashes.", "用于链接和命令行，只能包含小写字母、数字和连字符。")}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel nativeLabel={false} render={<div />}>{t("Platform", "平台")}</FieldLabel>
              <Select
                items={platformLabels}
                value={platform}
                onValueChange={(value) => setPlatform(value as AppPlatform)}
              >
                <SelectTrigger aria-label={t("Platform", "平台")}>
                  <SelectValue />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectList>
                    {APP_PLATFORMS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {platformLabels[value]}
                      </SelectItem>
                    ))}
                  </SelectList>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="new-app-description">{t("Description (optional)", "描述（可选）")}</FieldLabel>
              <Textarea
                id="new-app-description"
                className="min-h-[60px]"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("What does this app do?", "这个应用有什么用途？")}
              />
            </Field>
            <div className="grid gap-2">
              <DialogDescription>
                {t(
                  "Hands sets up three channels, main, preview and nightly, and a product type for each build format it ships.",
                  "Hands 会创建 main、preview 和 nightly 三个渠道，并为每种可发布的构建格式创建产品类型。",
                )}{" "}
                <TextLink
                  type="button"
                  aria-expanded={showSeeded}
                  onClick={() => setShowSeeded(!showSeeded)}
                >
                  {showSeeded ? t("Hide details", "收起详情") : t("Show details", "查看详情")}
                </TextLink>
              </DialogDescription>
              {showSeeded && <SeededDefaults />}
            </div>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" size="lg" />}>{t("Cancel", "取消")}</DialogClose>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={!canCreate}
              loading={create.isPending}
              loadingLabel={t("Creating app", "正在创建应用")}
            >
              {t("Create app", "创建应用")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** What creating an app sets up: the default channels and product types. */
function SeededDefaults() {
  const t = useText();
  return (
    <div className="grid gap-3 rounded-container border border-line-hairline p-3">
      <div className="grid gap-1.5">
        <Text.Sans size="caption" variant="muted">{t("Channels", "渠道")}</Text.Sans>
        <ul className="grid gap-1">
          {DEFAULT_CHANNELS.map((c) => (
            <li key={c.slug} className="flex items-baseline gap-2">
              <Badge appearance="outline" className="shrink-0">{c.slug}</Badge>
              <Text.Sans size="small" variant="muted">{t(c.description, c.description_zh)}</Text.Sans>
            </li>
          ))}
        </ul>
      </div>
      <div className="grid gap-1.5">
        <Text.Sans size="caption" variant="muted">{t("Product types", "产品类型")}</Text.Sans>
        <ul className="grid gap-1">
          {DEFAULT_PRODUCT_TYPES.map((pt) => (
            <li key={pt.name} className="flex items-baseline gap-2">
              <Badge appearance="outline" className="shrink-0">{pt.name}</Badge>
              <Text.Sans size="small" variant="muted">{t(pt.description, pt.description_zh)}</Text.Sans>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
