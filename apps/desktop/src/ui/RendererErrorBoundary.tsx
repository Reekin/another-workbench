import React, { type ErrorInfo, type ReactNode } from "react";
import type { DesktopTransport } from "../transport/desktop-transport.js";

export type RendererErrorBoundaryProps = {
  children: ReactNode;
  transport: DesktopTransport;
  reloadDelayMs?: number;
};

type RendererErrorBoundaryState = {
  error?: Error;
  reloadScheduled: boolean;
};

const reloadMarkerKey = "another-workbench:renderer-error-boundary-reloaded";

const describeUnknownError = (error: unknown): { message: string; stack?: string } => {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack
    };
  }
  return {
    message: typeof error === "string" ? error : String(error)
  };
};

const canUseSessionStorage = (): boolean => {
  try {
    window.sessionStorage.getItem(reloadMarkerKey);
    return true;
  } catch {
    return false;
  }
};

export const clearRendererErrorReloadMarker = (): void => {
  if (!canUseSessionStorage()) {
    return;
  }
  window.sessionStorage.removeItem(reloadMarkerKey);
};

export const shouldScheduleRendererErrorReload = (): boolean => {
  if (!canUseSessionStorage()) {
    return false;
  }
  if (window.sessionStorage.getItem(reloadMarkerKey)) {
    return false;
  }
  window.sessionStorage.setItem(reloadMarkerKey, new Date().toISOString());
  return true;
};

export class RendererErrorBoundary extends React.Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  public state: RendererErrorBoundaryState = {
    reloadScheduled: false
  };

  private clearReloadMarkerTimer: number | undefined;

  public static getDerivedStateFromError(error: Error): RendererErrorBoundaryState {
    return {
      error,
      reloadScheduled: false
    };
  }

  public componentDidMount(): void {
    this.clearReloadMarkerTimer = window.setTimeout(() => {
      if (!this.state.error) {
        clearRendererErrorReloadMarker();
      }
    }, 10_000);
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const details = describeUnknownError(error);
    void this.props.transport.errorLog
      .write({
        message: details.message,
        severity: "error",
        source: "renderer-react-error-boundary",
        stack: details.stack,
        context: {
          componentStack: errorInfo.componentStack
        }
      })
      .catch(() => undefined);

    if (!shouldScheduleRendererErrorReload()) {
      return;
    }

    this.setState({ reloadScheduled: true });
    window.setTimeout(() => {
      window.location.reload();
    }, this.props.reloadDelayMs ?? 500);
  }

  public componentWillUnmount(): void {
    if (this.clearReloadMarkerTimer !== undefined) {
      window.clearTimeout(this.clearReloadMarkerTimer);
    }
  }

  public render(): ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }

    const details = describeUnknownError(this.state.error);
    return (
      <main
        style={{
          fontFamily: "ui-sans-serif, system-ui",
          padding: 24,
          lineHeight: 1.5
        }}
      >
        <h1 style={{ margin: "0 0 12px" }}>Another Workbench</h1>
        <p style={{ margin: "0 0 12px" }}>
          Renderer crashed while rendering the UI.
          {this.state.reloadScheduled
            ? " Reloading once..."
            : " Automatic reload was already attempted."}
        </p>
        <pre
          style={{
            background: "#f6f6f6",
            padding: 12,
            borderRadius: 8,
            overflow: "auto",
            whiteSpace: "pre-wrap"
          }}
        >
          {details.stack ?? details.message}
        </pre>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}
