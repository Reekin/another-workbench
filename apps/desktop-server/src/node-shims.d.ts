declare const Buffer: {
  from(input: string | number[], encoding?: string): {
    length: number;
  };
  alloc(size: number): {
    [index: number]: number;
    writeUInt16BE(value: number, offset: number): void;
    writeBigUInt64BE(value: bigint, offset: number): void;
  };
  concat(chunks: Array<unknown>): unknown;
};

declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(value: string): {
      digest(encoding: "base64"): string;
    };
  };
}

declare module "node:http" {
  export type IncomingMessage = {
    url?: string;
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    setEncoding(encoding: string): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
  };

  export type ServerResponse = {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(payload?: string): void;
  };

  export type Server = {
    listen(port: number, host: string, callback: () => void): void;
    close(callback: (error?: Error | null) => void): void;
    once(event: string, listener: (error: Error) => void): void;
    off(event: string, listener: (error: Error) => void): void;
    on(
      event: "upgrade",
      listener: (
        request: IncomingMessage,
        socket: import("node:net").Socket,
        head: Uint8Array
      ) => void
    ): void;
  };

  export function createServer(
    listener: (request: IncomingMessage, response: ServerResponse) => void
  ): Server;
}

declare module "node:net" {
  export type Socket = {
    write(payload: string | unknown): void;
    destroy(): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
  };
}


declare module "node:url" {
  export class URL {
    constructor(input: string, base?: string);
    pathname: string;
    searchParams: {
      get(name: string): string | null;
    };
  }
}
