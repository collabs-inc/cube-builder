import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Top-level crash guard. Renders a minimal error card instead of a blank
 * window when a render error escapes the tree — no external deps, since
 * this is the last line of defense if something else has already broken.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[app] render error:", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="error-card">
        <div className="error-card-title">Something went wrong</div>
        <div className="error-card-message">{error.message}</div>
      </div>
    );
  }
}

interface ContainedErrorBoundaryState {
  error: Error | null;
  /** Bumped by "Reload item" to force a fresh mount of the child subtree —
   * clearing the caught error alone isn't enough for a crash caused by bad
   * internal state (as opposed to bad props), which would just re-throw on
   * the next render with the same component instance. */
  retryCount: number;
}

/**
 * Per-item crash guard for ItemHost (Task 8/9): each open workspace item
 * gets one of these, so a render error in one item's view shows an error
 * card sized to that item's slot — not `ErrorBoundary`'s whole-window
 * `position: fixed; inset: 0` — and doesn't take the rest of the window
 * (sidebar, other items) down with it. "Reload item" remounts the child via
 * a key bump, dismissing the error without a full app reload.
 */
export class ContainedErrorBoundary extends Component<ErrorBoundaryProps, ContainedErrorBoundaryState> {
  override state: ContainedErrorBoundaryState = { error: null, retryCount: 0 };

  static getDerivedStateFromError(error: Error): Partial<ContainedErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[app] item render error:", error, info.componentStack);
  }

  private readonly handleReload = (): void => {
    this.setState((prev) => ({ error: null, retryCount: prev.retryCount + 1 }));
  };

  override render(): ReactNode {
    const { error, retryCount } = this.state;
    if (error) {
      return (
        <div className="error-card error-card-contained">
          <div className="error-card-title">Something went wrong</div>
          <div className="error-card-message">{error.message}</div>
          <button type="button" className="error-card-reload-button" onClick={this.handleReload}>
            Reload item
          </button>
        </div>
      );
    }
    return <div key={retryCount} style={{ display: "contents" }}>{this.props.children}</div>;
  }
}
