import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { createApp, type ProductType, type ReleaseType } from "../lib/api";
import { useToast } from "./Toast";

/**
 * App creation wizard — 3 steps:
 *   1. Basics: name / slug / description
 *   2. Product types: pick which artifacts we ship (with supported_platforms
 *      sub-picker for Electron)
 *   3. Release types: review defaults, customize
 *
 * On save, the backend `POST /api/apps` handler now seeds default
 * product_types / release_types / channels via a single batch insert
 * (see worker/src/routes/apps.ts handleCreateApp). The wizard just
 * collects the basics — the seeding is automatic.
 *
 * The wizard is currently "informational" — it shows what's being created
 * so the user understands the consequences. Future phases can add per-step
 * customization (custom product_types beyond defaults, custom channels, etc.)
 */

const DEFAULT_PRODUCT_TYPES: Array<{
  name: string;
  display_name: string;
  description: string;
  supported_platforms: string[];
}> = [
  {
    name: "android-apk",
    display_name: "Android APK",
    description: "Android application package — direct install",
    supported_platforms: [],
  },
  {
    name: "electron-installer",
    display_name: "Electron desktop app",
    description: "Cross-platform desktop (darwin / linux / win32)",
    supported_platforms: [
      "darwin-arm64",
      "darwin-x64",
      "linux-x64",
      "linux-arm64",
      "win32-x64",
      "win32-arm64",
    ],
  },
  {
    name: "rn-bundle",
    display_name: "React Native OTA bundle",
    description: "JS bundle hot-update (replaces JS layer only)",
    supported_platforms: [],
  },
];

const DEFAULT_RELEASE_TYPES: Array<{
  name: string;
  display_name: string;
  color: string;
  description: string;
}> = [
  { name: "stable", display_name: "Stable", color: "#10b981", description: "Production-ready" },
  { name: "rc", display_name: "RC", color: "#3b82f6", description: "Release candidate" },
  { name: "beta", display_name: "Beta", color: "#f59e0b", description: "Public beta" },
  { name: "internal", display_name: "Internal", color: "#6b7280", description: "Internal team only" },
];

const DEFAULT_CHANNELS = [
  { slug: "production", name: "Production", enabled_product_types: ["android-apk", "electron-installer", "rn-bundle"] },
  { slug: "beta", name: "Beta", enabled_product_types: ["android-apk", "rn-bundle"] },
  { slug: "internal", name: "Internal", enabled_product_types: ["android-apk"] },
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
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugAuto, setSlugAuto] = useState(true);
  const [description, setDescription] = useState("");
  const [selectedProductTypes, setSelectedProductTypes] = useState<Set<string>>(
    () => new Set(["android-apk", "electron-installer", "rn-bundle"]),
  );
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(
    () =>
      new Set([
        "darwin-arm64",
        "darwin-x64",
        "linux-x64",
        "linux-arm64",
        "win32-x64",
        "win32-arm64",
      ]),
  );
  const [selectedReleaseTypes, setSelectedReleaseTypes] = useState<Set<string>>(
    () => new Set(["stable", "rc", "beta", "internal"]),
  );

  const toast = useToast();

  const create = useMutation({
    mutationFn: () =>
      createApp({
        slug: slug || slugify(name),
        name,
        platform: "android",
        description: description.trim() || undefined,
      }),
    onMutate: () =>
      toast.show({ kind: "loading", title: `Creating app '${name}'…` }),
    onSuccess: () => {
      toast.show({
        kind: "success",
        title: `App '${slug || slugify(name)}' created`,
        description: `Seeded ${selectedProductTypes.size} product types, ${selectedReleaseTypes.size} release types, ${DEFAULT_CHANNELS.length} channels`,
      });
      onCreated();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Failed to create app",
        description: (e as Error).message,
      }),
  });

  const canAdvance =
    (step === 1 && name.trim().length > 0 && (slug.trim().length > 0 || slugify(name).length > 0)) ||
    step === 2 ||
    step === 3;

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="card max-w-2xl w-full relative">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 text-slate-400 hover:text-slate-700 w-8 h-8 flex items-center justify-center rounded-md hover:bg-slate-100"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-6 text-xs text-slate-500">
          {[1, 2, 3].map((n) => (
            <div key={n} className="flex items-center gap-2">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center font-medium ${
                  n === step
                    ? "bg-blue-600 text-white"
                    : n < step
                      ? "bg-blue-100 text-blue-700"
                      : "bg-slate-100 text-slate-500"
                }`}
              >
                {n < step ? "✓" : n}
              </div>
              <span className={n === step ? "font-medium text-slate-700" : ""}>
                {n === 1 ? "Basics" : n === 2 ? "Product types" : "Release types"}
              </span>
              {n < 3 && <span className="text-slate-300 mx-2">→</span>}
            </div>
          ))}
        </div>

        {step === 1 && (
          <div>
            <h2 className="text-lg font-bold mb-4">Create app — Basics</h2>
            <div className="space-y-3">
              <div>
                <label className="label">Name *</label>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (slugAuto) setSlug(slugify(e.target.value));
                  }}
                  placeholder="My App"
                  autoFocus
                />
              </div>
              <div>
                <label className="label">Slug (kebab-case, auto-generated from name)</label>
                <input
                  className="input font-mono text-xs"
                  value={slug}
                  onChange={(e) => {
                    setSlug(e.target.value);
                    setSlugAuto(false);
                  }}
                  placeholder="my-app"
                />
              </div>
              <div>
                <label className="label">Description (optional)</label>
                <textarea
                  className="input min-h-[60px]"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does this app do?"
                />
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="text-lg font-bold mb-4">Create app — Product types</h2>
            <p className="text-sm text-slate-500 mb-4">
              What kinds of artifacts will you ship? Each product type gets its own parser
              + UI flow. Defaults below can be removed if not needed.
            </p>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {DEFAULT_PRODUCT_TYPES.map((pt) => {
                const checked = selectedProductTypes.has(pt.name);
                return (
                  <div key={pt.name} className="border border-slate-200 rounded-lg p-3">
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const next = new Set(selectedProductTypes);
                          if (e.target.checked) next.add(pt.name);
                          else next.delete(pt.name);
                          setSelectedProductTypes(next);
                        }}
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{pt.display_name}</div>
                        <div className="text-xs font-mono text-slate-500">{pt.name}</div>
                        <div className="text-xs text-slate-600 mt-1">{pt.description}</div>
                        {checked && pt.supported_platforms.length > 0 && (
                          <div className="mt-3 pl-3 border-l-2 border-slate-100">
                            <div className="text-xs font-medium text-slate-700 mb-1">
                              Supported platforms (sub-pick):
                            </div>
                            <div className="grid grid-cols-2 gap-1">
                              {pt.supported_platforms.map((platform) => (
                                <label
                                  key={platform}
                                  className="flex items-center gap-1 text-xs font-mono cursor-pointer"
                                >
                                  <input
                                    type="checkbox"
                                    checked={selectedPlatforms.has(platform)}
                                    onChange={(e) => {
                                      const next = new Set(selectedPlatforms);
                                      if (e.target.checked) next.add(platform);
                                      else next.delete(platform);
                                      setSelectedPlatforms(next);
                                    }}
                                  />
                                  <span>{platform}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </label>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 className="text-lg font-bold mb-4">Create app — Release types</h2>
            <p className="text-sm text-slate-500 mb-4">
              How will you label releases? Defaults below are seeded. Uncheck any you
              don't want — you can re-add later in the app settings.
            </p>
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {DEFAULT_RELEASE_TYPES.map((rt) => (
                <label
                  key={rt.name}
                  className="flex items-center gap-3 p-2 border border-slate-200 rounded-md cursor-pointer hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    checked={selectedReleaseTypes.has(rt.name)}
                    onChange={(e) => {
                      const next = new Set(selectedReleaseTypes);
                      if (e.target.checked) next.add(rt.name);
                      else next.delete(rt.name);
                      setSelectedReleaseTypes(next);
                    }}
                  />
                  <span
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: rt.color }}
                  />
                  <span className="font-medium">{rt.display_name}</span>
                  <span className="text-xs font-mono text-slate-500">{rt.name}</span>
                  <span className="text-xs text-slate-600 ml-auto">{rt.description}</span>
                </label>
              ))}
            </div>

            <div className="mt-6 pt-4 border-t border-slate-100">
              <div className="text-xs font-medium text-slate-700 mb-2">
                Default channels (will be seeded):
              </div>
              <div className="flex flex-wrap gap-2">
                {DEFAULT_CHANNELS.map((c) => (
                  <span
                    key={c.slug}
                    className="badge-gray text-xs"
                    title={`product_types: ${c.enabled_product_types.join(", ")}`}
                  >
                    {c.slug}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="flex gap-2 justify-between pt-4 mt-4 border-t border-slate-100">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => (step === 1 ? onClose() : setStep((step - 1) as 1 | 2 | 3))}
          >
            {step === 1 ? "Cancel" : "← Back"}
          </button>
          {step < 3 ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => setStep((step + 1) as 1 | 2 | 3)}
              disabled={!canAdvance}
            >
              Next →
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              onClick={() => create.mutate()}
              disabled={
                create.isPending ||
                !name.trim() ||
                selectedProductTypes.size === 0 ||
                selectedReleaseTypes.size === 0
              }
            >
              {create.isPending ? "Creating…" : "Create app + seed defaults"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}