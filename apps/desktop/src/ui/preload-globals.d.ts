import type { WorkbenchClientApi } from "@another-workbench/shared";

declare global {
  interface Window {
    workbench?: WorkbenchClientApi;
  }
}

export {};

