import type { WorkbenchClientApi } from "@another-workbench/shared";
import type { RemoteWorkbenchBootstrap } from "../transport/workbench-client-bootstrap.js";

declare global {
  interface Window {
    workbench?: WorkbenchClientApi;
    workbenchRemoteBootstrap?: RemoteWorkbenchBootstrap;
  }
}

export {};
