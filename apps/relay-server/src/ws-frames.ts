import { createHash } from "node:crypto";
import type { Socket } from "node:net";

export type DecodedWebSocketFrame = {
  opcode: number;
  payload: Buffer;
};

export const createWebSocketAcceptKey = (key: string): string => {
  return createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
};

export const sendWebSocketTextFrame = (
  socket: Socket,
  payload: string
): void => {
  const body = Buffer.from(payload, "utf8");
  if (body.length < 126) {
    socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
    return;
  }
  if (body.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    socket.write(Buffer.concat([header, body]));
    return;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  socket.write(Buffer.concat([header, body]));
};

export const decodeWebSocketFrames = (
  input: Buffer
): { frames: DecodedWebSocketFrame[]; rest: Buffer } => {
  let offset = 0;
  const frames: DecodedWebSocketFrame[] = [];

  while (offset + 2 <= input.length) {
    const firstByte = input[offset]!;
    const secondByte = input[offset + 1]!;
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > input.length) {
        break;
      }
      payloadLength = input.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > input.length) {
        break;
      }
      payloadLength = Number(input.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;
    if (offset + frameLength > input.length) {
      break;
    }

    const maskStart = offset + headerLength;
    const payloadStart = maskStart + maskLength;
    const payload = input.subarray(payloadStart, payloadStart + payloadLength);
    const decoded = Buffer.from(payload);

    if (masked) {
      const mask = input.subarray(maskStart, maskStart + 4);
      for (let index = 0; index < decoded.length; index += 1) {
        decoded[index] = decoded[index]! ^ mask[index % 4]!;
      }
    }

    frames.push({
      opcode,
      payload: decoded
    });
    offset += frameLength;
  }

  return {
    frames,
    rest: input.subarray(offset)
  };
};
