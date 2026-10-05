export type PublicDocAssetPaths = {
  htmlPath: string;
  markdownTwinPath: string | null;
};

/**
 * Resolve public docs from the generated docs directory instead of a second
 * hand-maintained slug allowlist. Every generated article has a Markdown twin;
 * the docs index is the only HTML page without one.
 */
export function publicDocAssetPaths(pathname: string): PublicDocAssetPaths | null {
  if (pathname === "/docs" || pathname === "/docs/") {
    return { htmlPath: "/docs/", markdownTwinPath: null };
  }
  if (!pathname.startsWith("/docs/") || pathname.endsWith(".md")) return null;

  const htmlPath = pathname.endsWith("/") ? pathname : `${pathname}/`;
  const relativePath = htmlPath.slice("/docs/".length, -1);
  if (!relativePath || relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return {
    htmlPath,
    markdownTwinPath: `/docs/${relativePath}.md`,
  };
}

/** Static files emitted by VitePress; never normalize these as article URLs. */
export function publicDocStaticAssetPath(pathname: string): string | null {
  if (pathname === "/docs/vp-icons.css" || pathname === "/docs/hashmap.json") return pathname;
  if (!pathname.startsWith("/docs/assets/")) return null;
  const segments = pathname.slice("/docs/assets/".length).split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return pathname;
}
