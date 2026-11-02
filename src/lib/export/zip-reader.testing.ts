import { crc32 } from "node:zlib";

// Test-only reader for the stored (uncompressed) ZIPs client-zip writes, so
// the export tests can check entry order, names and contents without a ZIP
// dependency. It follows the central directory, reads Zip64 fields when a
// value is saturated, and checks each entry's CRC-32.

export type ZipEntry = { name: string; data: Uint8Array };

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const SATURATED_32 = 0xffffffff;

function findEndOfCentralDirectory(view: DataView): number {
  for (let offset = view.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD) return offset;
  }
  throw new Error("not a ZIP: no end of central directory record");
}

function centralDirectory(view: DataView): { offset: number; count: number } {
  const eocd = findEndOfCentralDirectory(view);
  const count = view.getUint16(eocd + 10, true);
  const offset = view.getUint32(eocd + 16, true);
  if (offset !== SATURATED_32 && count !== 0xffff) return { offset, count };
  const locator = eocd - 20;
  if (view.getUint32(locator, true) !== ZIP64_LOCATOR) throw new Error("Zip64 locator missing");
  const record = Number(view.getBigUint64(locator + 8, true));
  if (view.getUint32(record, true) !== ZIP64_EOCD) throw new Error("Zip64 end record missing");
  return { offset: Number(view.getBigUint64(record + 48, true)), count: Number(view.getBigUint64(record + 32, true)) };
}

/** Values the central header saturated, read from its Zip64 extra field in the spec's order. */
function zip64Values(view: DataView, extraStart: number, extraLength: number, wanted: number): number[] {
  for (let at = extraStart; at < extraStart + extraLength; ) {
    const id = view.getUint16(at, true);
    const size = view.getUint16(at + 2, true);
    if (id === 0x0001) {
      return Array.from({ length: wanted }, (_, index) => Number(view.getBigUint64(at + 4 + index * 8, true)));
    }
    at += 4 + size;
  }
  throw new Error("Zip64 extra field missing");
}

export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const { offset, count } = centralDirectory(view);
  const entries: ZipEntry[] = [];
  let at = offset;
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== CENTRAL) throw new Error(`central header ${index} missing`);
    const crc = view.getUint32(at + 16, true);
    let compressed = view.getUint32(at + 20, true);
    let uncompressed = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    let local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));

    const saturated = [uncompressed, compressed, local].filter((value) => value === SATURATED_32).length;
    if (saturated > 0) {
      const values = zip64Values(view, at + 46 + nameLength, extraLength, saturated);
      if (uncompressed === SATURATED_32) uncompressed = values.shift() ?? 0;
      if (compressed === SATURATED_32) compressed = values.shift() ?? 0;
      if (local === SATURATED_32) local = values.shift() ?? 0;
    }
    if (compressed !== uncompressed) throw new Error(`${name} is compressed; the export only stores`);

    if (view.getUint32(local, true) !== LOCAL) throw new Error(`local header of ${name} missing`);
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.slice(dataStart, dataStart + compressed);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch in ${name}`);
    entries.push({ name, data });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Reads a whole stream into one buffer. */
export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
