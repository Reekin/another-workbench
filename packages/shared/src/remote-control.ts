import { z } from "zod";
import { zWorkbenchEventPushSchema, zWorkbenchRpcRequestSchema } from "./ipc.js";

export const zRemoteClientSurfaceSchema = z.enum([
  "desktop-full",
  "mobile-companion"
]);

export const zWorkbenchConnectionStateSchema = z.enum([
  "idle",
  "bootstrapping",
  "pairing",
  "authenticating",
  "connecting",
  "hydrating",
  "live",
  "reconnecting",
  "degraded",
  "unauthorized",
  "closed"
]);

export const zWorkbenchRelayDescriptorSchema = z.object({
  relayId: z.string().min(1),
  label: z.string().min(1),
  httpBaseUrl: z.string().url(),
  wsBaseUrl: z.string().url(),
  serverInstanceId: z.string().min(1).optional(),
  region: z.string().min(1).optional()
});

export const zWorkbenchHostDescriptorSchema = z.object({
  hostId: z.string().min(1),
  label: z.string().min(1),
  deviceName: z.string().min(1),
  platform: z.string().min(1),
  appVersion: z.string().min(1),
  serverInstanceId: z.string().min(1),
  online: z.boolean().default(true),
  lastSeenAt: z.string().min(1)
});

export const zWorkbenchHostCapabilitiesSchema = z.object({
  clientSurfaces: z.array(zRemoteClientSurfaceSchema).default(["desktop-full"]),
  engineIds: z.array(z.string().min(1)).default([]),
  supportsPairing: z.boolean().default(true),
  supportsResume: z.boolean().default(true),
  supportsResourceGateway: z.boolean().default(false)
});

export const zWorkbenchConnectionSnapshotSchema = z.object({
  state: zWorkbenchConnectionStateSchema,
  relayId: z.string().min(1).optional(),
  hostId: z.string().min(1).optional(),
  routeId: z.string().min(1).optional(),
  authenticated: z.boolean().default(false),
  authorizedClientId: z.string().min(1).optional(),
  lastCursor: z.string().min(1).optional(),
  resumeToken: z.string().min(1).optional(),
  reconnectAfterMs: z.number().int().nonnegative().optional(),
  stale: z.boolean().default(false),
  reason: z.string().min(1).optional(),
  updatedAt: z.string().min(1)
});

export const zWorkbenchBootstrapSchema = z.object({
  serverInstanceId: z.string().min(1),
  relay: zWorkbenchRelayDescriptorSchema,
  host: zWorkbenchHostDescriptorSchema,
  capabilities: zWorkbenchHostCapabilitiesSchema,
  connection: zWorkbenchConnectionSnapshotSchema,
  clientSurface: zRemoteClientSurfaceSchema,
  supportedClientSurfaces: z.array(zRemoteClientSurfaceSchema).default([
    "desktop-full"
  ]),
  authenticated: z.boolean().default(false),
  version: z.object({
    protocolVersion: z.literal("2026-04-remote-v1"),
    appVersion: z.string().min(1)
  })
});

export const zWorkbenchPairingCodeSchema = z.object({
  pairingId: z.string().min(1),
  code: z.string().min(1),
  hostId: z.string().min(1),
  clientSurface: zRemoteClientSurfaceSchema,
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
  consumedAt: z.string().min(1).optional(),
  revokedAt: z.string().min(1).optional()
});

export const zWorkbenchSessionTokenPayloadSchema = z.object({
  sessionToken: z.string().min(1),
  resumeToken: z.string().min(1),
  resourceToken: z.string().min(1),
  clientId: z.string().min(1),
  hostId: z.string().min(1),
  pairingId: z.string().min(1),
  clientSurface: zRemoteClientSurfaceSchema,
  issuedAt: z.string().min(1),
  expiresAt: z.string().min(1),
  revokedAt: z.string().min(1).optional()
});

export const zWorkbenchResourceRefSchema = z.object({
  resourceId: z.string().min(1),
  hostId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  kind: z.enum(["image", "text", "log", "rollout", "file", "diff"]),
  displayName: z.string().min(1),
  mimeType: z.string().min(1).optional(),
  byteLength: z.number().int().nonnegative().optional(),
  previewable: z.boolean().default(true),
  downloadable: z.boolean().default(true)
});

export const zWorkbenchResourceAccessSchema = z.object({
  resource: zWorkbenchResourceRefSchema,
  token: z.string().min(1),
  downloadUrl: z.string().url().optional(),
  expiresAt: z.string().min(1)
});

export const zWorkbenchUploadReceiptSchema = z.object({
  receiptId: z.string().min(1),
  hostId: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.string().min(1).optional(),
  byteLength: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1)
});

const zStringRecordSchema = z.record(z.string(), z.string());

export const zRelayHostBridgeMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("host.hello"),
    host: zWorkbenchHostDescriptorSchema
  }),
  z.object({
    type: z.literal("host.ready"),
    routeId: z.string().min(1)
  }),
  z.object({
    type: z.literal("control.request"),
    requestId: z.string().min(1),
    method: z.enum(["GET", "POST"]),
    path: z.string().min(1),
    query: zStringRecordSchema.optional(),
    headers: zStringRecordSchema.optional(),
    body: z.unknown().optional()
  }),
  z.object({
    type: z.literal("control.response"),
    requestId: z.string().min(1),
    statusCode: z.number().int().nonnegative(),
    body: z.unknown().optional()
  }),
  z.object({
    type: z.literal("rpc.request"),
    requestId: z.string().min(1),
    rpc: zWorkbenchRpcRequestSchema,
    headers: zStringRecordSchema.optional()
  }),
  z.object({
    type: z.literal("rpc.response"),
    requestId: z.string().min(1),
    response: z.unknown()
  }),
  z.object({
    type: z.literal("event.start"),
    streamId: z.string().min(1),
    query: zStringRecordSchema.optional()
  }),
  z.object({
    type: z.literal("event.stop"),
    streamId: z.string().min(1)
  }),
  z.object({
    type: z.literal("event.push"),
    streamId: z.string().min(1),
    push: zWorkbenchEventPushSchema
  }),
  z.object({
    type: z.literal("event.error"),
    streamId: z.string().min(1),
    message: z.string().min(1)
  }),
  z.object({
    type: z.literal("host.ping"),
    timestamp: z.string().min(1)
  }),
  z.object({
    type: z.literal("host.pong"),
    timestamp: z.string().min(1)
  })
]);

export type RemoteClientSurface = z.infer<typeof zRemoteClientSurfaceSchema>;
export type WorkbenchConnectionState = z.infer<
  typeof zWorkbenchConnectionStateSchema
>;
export type WorkbenchRelayDescriptor = z.infer<
  typeof zWorkbenchRelayDescriptorSchema
>;
export type WorkbenchHostDescriptor = z.infer<
  typeof zWorkbenchHostDescriptorSchema
>;
export type WorkbenchHostCapabilities = z.infer<
  typeof zWorkbenchHostCapabilitiesSchema
>;
export type WorkbenchConnectionSnapshot = z.infer<
  typeof zWorkbenchConnectionSnapshotSchema
>;
export type WorkbenchBootstrap = z.infer<typeof zWorkbenchBootstrapSchema>;
export type WorkbenchPairingCode = z.infer<typeof zWorkbenchPairingCodeSchema>;
export type WorkbenchSessionTokenPayload = z.infer<
  typeof zWorkbenchSessionTokenPayloadSchema
>;
export type WorkbenchResourceRef = z.infer<typeof zWorkbenchResourceRefSchema>;
export type WorkbenchResourceAccess = z.infer<
  typeof zWorkbenchResourceAccessSchema
>;
export type WorkbenchUploadReceipt = z.infer<
  typeof zWorkbenchUploadReceiptSchema
>;
export type RelayHostBridgeMessage = z.infer<
  typeof zRelayHostBridgeMessageSchema
>;

export const parseWorkbenchBootstrap = (value: unknown): WorkbenchBootstrap =>
  zWorkbenchBootstrapSchema.parse(value);

export const parseWorkbenchConnectionSnapshot = (
  value: unknown
): WorkbenchConnectionSnapshot =>
  zWorkbenchConnectionSnapshotSchema.parse(value);

export const parseWorkbenchPairingCode = (
  value: unknown
): WorkbenchPairingCode => zWorkbenchPairingCodeSchema.parse(value);

export const parseWorkbenchSessionTokenPayload = (
  value: unknown
): WorkbenchSessionTokenPayload =>
  zWorkbenchSessionTokenPayloadSchema.parse(value);

export const safeParseWorkbenchBootstrap = (value: unknown) =>
  zWorkbenchBootstrapSchema.safeParse(value);

export const safeParseWorkbenchConnectionSnapshot = (value: unknown) =>
  zWorkbenchConnectionSnapshotSchema.safeParse(value);

export const safeParseWorkbenchPairingCode = (value: unknown) =>
  zWorkbenchPairingCodeSchema.safeParse(value);

export const safeParseWorkbenchSessionTokenPayload = (value: unknown) =>
  zWorkbenchSessionTokenPayloadSchema.safeParse(value);

export const parseRelayHostBridgeMessage = (value: unknown): RelayHostBridgeMessage =>
  zRelayHostBridgeMessageSchema.parse(value);

export const safeParseRelayHostBridgeMessage = (value: unknown) =>
  zRelayHostBridgeMessageSchema.safeParse(value);
