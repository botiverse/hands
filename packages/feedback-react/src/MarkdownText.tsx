/**
 * Markdown rendering for human-written feedback text (ticket bodies and
 * comments) — on-demand variant.
 *
 * The react-markdown pipeline lives in `MarkdownRenderer` and is pulled in
 * via dynamic import, so the standalone feedback entry's first paint never
 * waits on (or includes) the markdown stack. Until the chunk is ready — and
 * if it fails to load or render — the text renders as plain text, so the
 * page never blanks.
 *
 * Styling comes from the raft-ui Markdown* parts (see MarkdownRenderer) so
 * all three themes stay consistent.
 */
import {
  Component,
  Suspense,
  lazy,
  type ErrorInfo,
  type ReactNode,
} from "react";

const MarkdownRenderer = lazy(() => import("./MarkdownRenderer.js"));

interface MarkdownTextBoundaryProps {
  source: string;
  className?: string | undefined;
  children: ReactNode;
}

interface MarkdownTextBoundaryState {
  failed: boolean;
}

/** Plain-text rendering used before the chunk loads and on any failure. */
function PlainText({
  source,
  className,
}: {
  source: string;
  className?: string | undefined;
}) {
  return <p className={`${className ?? ""} whitespace-pre-wrap`}>{source}</p>;
}

/** Plain-text fallback so a load or render failure never blanks the page. */
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
        <PlainText source={this.props.source} className={this.props.className} />
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
      <Suspense fallback={<PlainText source={source} className={className} />}>
        <div className={className}>
          <MarkdownRenderer source={source} />
        </div>
      </Suspense>
    </MarkdownTextBoundary>
  );
}
