export const RELAY_PROTOCOL_VERSION = "relay.v1";

export type RelayProtocolVersion = typeof RELAY_PROTOCOL_VERSION;

export type RelayHostStatus = "registered" | "connected";

export type RelayHostMetadata = Record<string, unknown>;

export type RelayHostConnection = {
  connectionId: string;
  clientId?: string;
  sessionId?: string;
  connectedAt: string;
};

export type RelayHostRecord = {
  hostId: string;
  label: string;
  capabilities: string[];
  metadata: RelayHostMetadata;
  status: RelayHostStatus;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
  activeConnection?: RelayHostConnection;
};

export type RelayRegistryDocument = {
  version: 1;
  hosts: RelayHostRecord[];
};

export type RelayHostRegistrationInput = {
  hostId?: string;
  label?: string;
  capabilities?: string[];
  metadata?: RelayHostMetadata;
};

export type RelayHostConnectInput = {
  clientId?: string;
  sessionId?: string;
};

export type RelayHostSummary = Pick<
  RelayHostRecord,
  "hostId" | "label" | "capabilities" | "status" | "updatedAt" | "lastConnectedAt"
>;

export type RelayClientBootstrap = {
  protocolVersion: RelayProtocolVersion;
  serverTime: string;
  clientId: string;
  healthUrl: string;
  rpc: {
    endpoint: string;
    transport: "http";
  };
  hosts: RelayHostSummary[];
};

export type RelayRpcRequest = {
  id?: string;
  method: "relay.ping";
  params?: Record<string, unknown>;
};

export type RelayRpcSuccessResponse = {
  id?: string;
  ok: true;
  result: unknown;
};

export type RelayRpcErrorResponse = {
  id?: string;
  ok: false;
  error: {
    code: string;
    message: string;
  };
};

export type RelayRpcResponse = RelayRpcSuccessResponse | RelayRpcErrorResponse;
