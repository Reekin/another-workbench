import type { WorkbenchClientApi } from "@another-workbench/shared";
import type { RemoteWorkbenchBootstrap } from "../transport/workbench-client-bootstrap.js";

declare global {
  type WorkbenchLocalAssetsApi = {
    materializeAttachmentDataUri: (input: {
      attachmentId: string;
      dataUri: string;
      mimeType: string;
      name?: string;
    }) => Promise<{
      bytesWritten: number;
      displayUri: string;
      filePath: string;
    }>;
  };

  type WorkbenchDesktopApi = {
    pickEngineProgramPath: (engineId: string) => Promise<{
      canceled: boolean;
      path?: string;
    }>;
  };

  interface Window {
    workbench?: WorkbenchClientApi;
    workbenchLocalAssets?: WorkbenchLocalAssetsApi;
    workbenchDesktop?: WorkbenchDesktopApi;
    workbenchRemoteBootstrap?: RemoteWorkbenchBootstrap;
  }
}

export {};
