import { z } from "zod";
import { zWorkbenchEventPushSchema } from "./ipc.js";

export const zHostRelayConnectionStateSchema = z.enum([
  "idle",
  "connecting",
  "connected",
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
  engineIds: z.array(z.string().min(1)).default([]),
  supportsPairing: z.boolean().default(true),
  supportsResume: z.boolean().default(true),
  supportsResourceGateway: z.boolean().default(false)
});

export const zHostRelayConnectionSnapshotSchema = z.object({
  state: zHostRelayConnectionStateSchema,
  relayId: z.string().min(1).optional(),
  hostId: z.string().min(1).optional(),
  routeId: z.string().min(1).optional(),
  reconnectAfterMs: z.number().int().nonnegative().optional(),
  stale: z.boolean().default(false),
  reason: z.string().min(1).optional(),
  updatedAt: z.string().min(1)
});

export const zMobileRemoteBootstrapSchema = z.object({
  serverInstanceId: z.string().min(1),
  relay: zWorkbenchRelayDescriptorSchema,
  host: zWorkbenchHostDescriptorSchema,
  capabilities: zWorkbenchHostCapabilitiesSchema,
  connection: zHostRelayConnectionSnapshotSchema,
  version: z.object({
    protocolVersion: z.literal("2026-09-mobile-v1"),
    appVersion: z.string().min(1)
  })
});

export const zMobilePairingCodeSchema = z.object({
  pairingId: z.string().min(1),
  code: z.string().min(1),
  hostId: z.string().min(1),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
  consumedAt: z.string().min(1).optional(),
  revokedAt: z.string().min(1).optional()
});

export const zMobileSessionTokenSchema = z.object({
  sessionToken: z.string().min(1),
  resumeToken: z.string().min(1),
  clientId: z.string().min(1),
  hostId: z.string().min(1),
  pairingId: z.string().min(1),
  issuedAt: z.string().min(1),
  expiresAt: z.string().min(1),
  revokedAt: z.string().min(1).optional()
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
    rpc: z.unknown(),
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

export type HostRelayConnectionState = z.infer<
  typeof zHostRelayConnectionStateSchema
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
export type HostRelayConnectionSnapshot = z.infer<
  typeof zHostRelayConnectionSnapshotSchema
>;
export type MobileRemoteBootstrap = z.infer<typeof zMobileRemoteBootstrapSchema>;
export type MobilePairingCode = z.infer<typeof zMobilePairingCodeSchema>;
export type MobileSessionToken = z.infer<typeof zMobileSessionTokenSchema>;
export type RelayHostBridgeMessage = z.infer<
  typeof zRelayHostBridgeMessageSchema
>;

export const parseMobileRemoteBootstrap = (value: unknown): MobileRemoteBootstrap =>
  zMobileRemoteBootstrapSchema.parse(value);

export const parseHostRelayConnectionSnapshot = (
  value: unknown
): HostRelayConnectionSnapshot =>
  zHostRelayConnectionSnapshotSchema.parse(value);

export const parseMobilePairingCode = (
  value: unknown
): MobilePairingCode => zMobilePairingCodeSchema.parse(value);

export const parseMobileSessionToken = (
  value: unknown
): MobileSessionToken =>
  zMobileSessionTokenSchema.parse(value);

export const safeParseMobileRemoteBootstrap = (value: unknown) =>
  zMobileRemoteBootstrapSchema.safeParse(value);

export const safeParseHostRelayConnectionSnapshot = (value: unknown) =>
  zHostRelayConnectionSnapshotSchema.safeParse(value);

export const safeParseMobilePairingCode = (value: unknown) =>
  zMobilePairingCodeSchema.safeParse(value);

export const safeParseMobileSessionToken = (value: unknown) =>
  zMobileSessionTokenSchema.safeParse(value);

export const parseRelayHostBridgeMessage = (value: unknown): RelayHostBridgeMessage =>
  zRelayHostBridgeMessageSchema.parse(value);

export const safeParseRelayHostBridgeMessage = (value: unknown) =>
  zRelayHostBridgeMessageSchema.safeParse(value);
