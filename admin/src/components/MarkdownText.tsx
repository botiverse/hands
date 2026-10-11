/**
 * Markdown rendering for human-written feedback text (ticket bodies and
 * comments). Analysis + spec: feedback detail page markdown pass
 * (artin, 2026-10-11).
 *
 * - Styling comes from the raft-ui Markdown* parts so all three themes stay
 *   consistent (no component-local styles here).
 * - Raw HTML is skipped entirely (`skipHtml`) and the AST is sanitized with
 *   rehype-sanitize's default allowlist; `javascript:` links are stripped.
 * - Images render as links: feedback images have their own attachment
 *   channel, and mixing the two would be confusing.
 * - If rendering throws, we fall back to plain text so the page never goes
 *   blank.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
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
} from "raft-ui";

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

interface MarkdownTextBoundaryProps {
  source: string;
  className?: string | undefined;
  children: ReactNode;
}

interface MarkdownTextBoundaryState {
  failed: boolean;
}

/** Plain-text fallback so a markdown render failure never blanks the page. */
class MarkdownTextBoundary extends Component<
  MarkdownTextBoundaryProps,
  MarkdownTextBoundaryState
> {
  state: MarkdownTextBoundaryState = { failed: false };

  static getDerivedStateFromError(): MarkdownTextBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(
      "[MarkdownText] render failed; falling back to plain text",
      error,
      info.componentStack,
    );
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <p className={`${this.props.className ?? ""} whitespace-pre-wrap`}>
          {this.props.source}
        </p>
      );
    }
    return this.props.children;
  }
}

export function MarkdownText({
  source,
  className,
}: {
  source: string;
  className?: string | undefined;
}) {
  return (
    <MarkdownTextBoundary source={source} className={className}>
      <div className={className}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          rehypePlugins={[rehypeSanitize]}
          components={components}
          skipHtml
        >
          {source}
        </ReactMarkdown>
      </div>
    </MarkdownTextBoundary>
  );
}
