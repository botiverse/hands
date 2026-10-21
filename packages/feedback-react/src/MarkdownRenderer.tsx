/**
 * Heavy half of the feedback markdown rendering: the react-markdown /
 * remark / rehype pipeline plus the raft-ui Markdown* component map.
 *
 * Kept in its own module so MarkdownText can pull it in on demand via
 * dynamic import — the standalone feedback entry's first-paint graph stays
 * free of the markdown stack (size budget: first-paint <= 1,000,000 bytes,
 * total <= 1,150,000 bytes; the deferred markdown chunk counts only toward
 * the total line).
 *
 * - Raw HTML is skipped entirely (`skipHtml`); the AST is sanitized with
 *   rehype-sanitize's default allowlist; `javascript:` links are stripped.
 * - Images render as links: feedback images have their own attachment
 *   channel, and mixing the two would be confusing.
 */
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import {
  MarkdownBlockquote,
  MarkdownCell,
  MarkdownHeaderCell,
  MarkdownHeading,
  MarkdownInlineCode,
  MarkdownLink,
  MarkdownList,
  MarkdownListItem,
  MarkdownOrderedList,
  MarkdownParagraph,
  MarkdownRule,
  MarkdownTable,
  MarkdownTableRow,
  MarkdownTableScroll,
} from "@botiverse/raft-ui";

const LINK_PROPS = {
  target: "_blank",
  rel: "noreferrer noopener",
} as const;

const BLOCK_CODE_CLASS =
  "block overflow-x-auto rounded-md bg-layer-canvas-muted p-3 text-xs";

const components: Components = {
  p: ({ node: _node, ...props }) => <MarkdownParagraph {...props} />,
  h1: ({ node: _node, ...props }) => <MarkdownHeading level={1} {...props} />,
  h2: ({ node: _node, ...props }) => <MarkdownHeading level={2} {...props} />,
  h3: ({ node: _node, ...props }) => <MarkdownHeading level={3} {...props} />,
  h4: ({ node: _node, ...props }) => <MarkdownHeading level={4} {...props} />,
  h5: ({ node: _node, ...props }) => <MarkdownHeading level={5} {...props} />,
  h6: ({ node: _node, ...props }) => <MarkdownHeading level={6} {...props} />,
  a: ({ node: _node, ...props }) => <MarkdownLink {...LINK_PROPS} {...props} />,
  ul: ({ node: _node, ...props }) => <MarkdownList {...props} />,
  ol: ({ node: _node, ...props }) => <MarkdownOrderedList {...props} />,
  li: ({ node: _node, ...props }) => <MarkdownListItem {...props} />,
  blockquote: ({ node: _node, ...props }) => <MarkdownBlockquote {...props} />,
  hr: ({ node: _node, ...props }) => <MarkdownRule {...props} />,
  table: ({ node: _node, ...props }) => (
    <MarkdownTableScroll>
      <MarkdownTable {...props} />
    </MarkdownTableScroll>
  ),
  tr: ({ node: _node, ...props }) => <MarkdownTableRow {...props} />,
  th: ({ node: _node, ...props }) => <MarkdownHeaderCell {...props} />,
  td: ({ node: _node, ...props }) => <MarkdownCell {...props} />,
  code: ({ node: _node, className, children, ...props }) => {
    // Note: a one-line fenced block without a language has no newline and no
    // language class, so it renders as inline code — acceptable for v1.
    const isBlock =
      (className?.startsWith("language-") ?? false) ||
      String(children).includes("\n");
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return <MarkdownInlineCode {...props}>{children}</MarkdownInlineCode>;
  },
  pre: ({ node: _node, ...props }) => (
    <pre className={BLOCK_CODE_CLASS} {...props} />
  ),
  // Images render as links; the attachment channel owns actual images.
  img: ({ node: _node, src, alt }) => (
    <MarkdownLink href={typeof src === "string" ? src : ""} {...LINK_PROPS}>
      {alt || (typeof src === "string" ? src : "image")}
    </MarkdownLink>
  ),
};

export default function MarkdownRenderer({ source }: { source: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={[rehypeSanitize]}
      components={components}
      skipHtml
    >
      {source}
    </ReactMarkdown>
  );
}
