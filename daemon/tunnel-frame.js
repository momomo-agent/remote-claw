// tunnel-frame.js — Binary frame codec for RemoteClaw relay tunnel.
//
// Frame layout (all integers are big-endian):
//   0x00  uint8   opcode
//   0x01  uint32  reqId           (per-session sequence, assigned by initiator)
//   0x05  uint8   peer_len        (UTF-8 byte length of peer device/client id)
//   0x06  bytes   peer            (on send: destination; relay overwrites with source)
//   0x06+peer_len: payload (opcode-specific)
//
// Opcodes:
//   0x01 HTTP_REQ    payload = JSON header \n body_bytes
//   0x02 HTTP_RESP   payload = JSON header \n body_bytes
//   0x03 HTTP_ERR    payload = UTF-8 error message
//   0x10 TCP_OPEN    payload = JSON {host,port,tls?}
//   0x11 TCP_DATA    payload = raw bytes
//   0x12 TCP_CLOSE   payload = optional reason string
//   0x20 WS_OPEN     payload = JSON {url,headers,port}
//   0x21 WS_DATA     payload = byte0: flags (bit0 = binary), bytes1..: data
//   0x22 WS_CLOSE    payload = uint16 close code (optional)
//
// The JSON+\n+body convention lets each side parse the header cheaply without
// allocating a separate buffer for the body.

const OP = Object.freeze({
  HTTP_REQ:  0x01,
  HTTP_RESP: 0x02,
  HTTP_ERR:  0x03,
  TCP_OPEN:  0x10,
  TCP_DATA:  0x11,
  TCP_CLOSE: 0x12,
  WS_OPEN:   0x20,
  WS_DATA:   0x21,
  WS_CLOSE:  0x22,
});

// Encode a tunnel frame. Returns a Buffer (or Uint8Array if Buffer is unavailable).
function encode(opcode, reqId, peer, payload) {
  const B = typeof Buffer !== "undefined" ? Buffer : null;
  const peerBytes = B
    ? B.from(peer || "", "utf-8")
    : new TextEncoder().encode(peer || "");
  const payloadBytes = payload instanceof Uint8Array
    ? payload
    : (B ? B.from(payload || "") : new TextEncoder().encode(String(payload || "")));
  const total = 6 + peerBytes.length + payloadBytes.length;
  const out = B ? B.alloc(total) : new Uint8Array(total);
  out[0] = opcode & 0xff;
  // reqId uint32 BE
  out[1] = (reqId >>> 24) & 0xff;
  out[2] = (reqId >>> 16) & 0xff;
  out[3] = (reqId >>> 8) & 0xff;
  out[4] = reqId & 0xff;
  out[5] = peerBytes.length & 0xff;
  if (B) {
    peerBytes.copy(out, 6);
    if (payloadBytes.length) payloadBytes.copy(out, 6 + peerBytes.length);
  } else {
    out.set(peerBytes, 6);
    if (payloadBytes.length) out.set(payloadBytes, 6 + peerBytes.length);
  }
  return out;
}

// Decode a frame (Buffer or ArrayBuffer or Uint8Array).
function decode(buf) {
  let u8;
  if (buf instanceof Uint8Array) u8 = buf;
  else if (typeof Buffer !== "undefined" && Buffer.isBuffer(buf)) u8 = buf;
  else if (buf instanceof ArrayBuffer) u8 = new Uint8Array(buf);
  else if (buf?.buffer instanceof ArrayBuffer) u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  else throw new Error("unsupported buffer type");

  if (u8.length < 6) throw new Error("frame too short");
  const opcode = u8[0];
  const reqId = ((u8[1] << 24) >>> 0) | (u8[2] << 16) | (u8[3] << 8) | u8[4];
  const peerLen = u8[5];
  if (u8.length < 6 + peerLen) throw new Error("frame truncated");
  const peerBytes = u8.subarray(6, 6 + peerLen);
  const peer = typeof Buffer !== "undefined" && Buffer.isBuffer(peerBytes)
    ? peerBytes.toString("utf-8")
    : new TextDecoder("utf-8").decode(peerBytes);
  const payload = u8.subarray(6 + peerLen);
  return { opcode, reqId, peer, payload };
}

// Replace the peer field with a new value (used by the relay when forwarding).
// Returns a new buffer.
function rewritePeer(buf, newPeer) {
  const d = decode(buf);
  return encode(d.opcode, d.reqId, newPeer, d.payload);
}

// Convenience: split a payload that starts with a JSON header terminated by '\n'.
function splitJsonBody(payload) {
  // payload is a Uint8Array
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] === 0x0a) {
      const headerBytes = payload.subarray(0, i);
      const body = payload.subarray(i + 1);
      const headerStr = typeof Buffer !== "undefined" && Buffer.isBuffer(headerBytes)
        ? headerBytes.toString("utf-8")
        : new TextDecoder("utf-8").decode(headerBytes);
      return { header: JSON.parse(headerStr || "{}"), body };
    }
  }
  // no \n — treat whole payload as JSON header, empty body
  const headerStr = typeof Buffer !== "undefined" && Buffer.isBuffer(payload)
    ? payload.toString("utf-8")
    : new TextDecoder("utf-8").decode(payload);
  return { header: JSON.parse(headerStr || "{}"), body: new Uint8Array(0) };
}

function joinJsonBody(header, body) {
  const B = typeof Buffer !== "undefined" ? Buffer : null;
  const headerBytes = B ? B.from(JSON.stringify(header), "utf-8") : new TextEncoder().encode(JSON.stringify(header));
  const bodyBytes = body instanceof Uint8Array
    ? body
    : (B ? (body ? B.from(body) : B.alloc(0)) : (body ? new TextEncoder().encode(String(body)) : new Uint8Array(0)));
  const total = headerBytes.length + 1 + bodyBytes.length;
  const out = B ? B.alloc(total) : new Uint8Array(total);
  if (B) {
    headerBytes.copy(out, 0);
    out[headerBytes.length] = 0x0a;
    if (bodyBytes.length) bodyBytes.copy(out, headerBytes.length + 1);
  } else {
    out.set(headerBytes, 0);
    out[headerBytes.length] = 0x0a;
    if (bodyBytes.length) out.set(bodyBytes, headerBytes.length + 1);
  }
  return out;
}

module.exports = { OP, encode, decode, rewritePeer, splitJsonBody, joinJsonBody };
