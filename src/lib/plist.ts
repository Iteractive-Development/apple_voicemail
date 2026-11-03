import { VoicemailStoreError } from "./store";

/** Reads `length` bytes at `offset` as an unsigned big-endian integer. */
function readUint(buffer: Buffer, offset: number, length: number): number {
    let value = 0n;
    for (let i = 0; i < length; i++) {
        value = (value << 8n) | BigInt(buffer[offset + i]);
    }
    return Number(value);
}

/** Reads `length` bytes at `offset` as a signed big-endian two's-complement integer. */
function readInt(buffer: Buffer, offset: number, length: number): number {
    let value = 0n;
    for (let i = 0; i < length; i++) {
        value = (value << 8n) | BigInt(buffer[offset + i]);
    }
    const bits = BigInt(length * 8);
    if (value >= 1n << (bits - 1n)) {
        value -= 1n << bits;
    }
    return Number(value);
}

/** Reads a big-endian float of 4 or 8 bytes at `offset`. */
function readReal(buffer: Buffer, offset: number, length: number): number {
    if (length === 4) return buffer.readFloatBE(offset);
    if (length === 8) return buffer.readDoubleBE(offset);
    throw new VoicemailStoreError(`Unsupported float size in transcript archive: ${length}`);
}

interface PlistValue {
    __uid__?: number;
    $classname?: unknown;
    $class?: unknown;
    "NS.keys"?: PlistValue[];
    "NS.objects"?: PlistValue[];
    [key: string]: unknown;
}

function isUidRef(value: unknown): value is { __uid__: number } {
    return value !== null && typeof value === "object" && typeof (value as { __uid__?: unknown }).__uid__ === "number";
}

/**
 * Parses a binary plist (`bplist00`) into plain JavaScript values. Supports the object types
 * Apple's voicemail transcripts use: null, integers, reals, dates, data, ASCII and UTF-16BE
 * strings, UIDs, arrays, sets and dictionaries.
 */
export function parseBinaryPlist(buffer: Buffer): unknown {
    if (buffer.length < 40 || !buffer.subarray(0, 8).toString("latin1").startsWith("bplist")) {
        throw new VoicemailStoreError("The transcript is not a binary plist");
    }
    const trailer = buffer.subarray(buffer.length - 32);
    const offsetIntSize = trailer[6];
    const objectRefSize = trailer[7];
    const numObjects = readUint(trailer, 8, 8);
    const topObject = readUint(trailer, 16, 8);
    const offsetTableOffset = readUint(trailer, 24, 8);
    const readOffset = (index: number): number => readUint(buffer, offsetTableOffset + index * offsetIntSize, offsetIntSize);

    const parseObject = (index: number): unknown => {
        if (index < 0 || index >= numObjects) {
            throw new VoicemailStoreError("Corrupt transcript archive: object index out of range");
        }
        const offset = readOffset(index);
        const marker = buffer[offset];
        const type = marker >> 4;
        if (type === 0) return null;
        let size = marker & 15;
        let cursor = offset + 1;
        if (size === 15) {
            const exponent = 1 << (buffer[cursor++] & 15);
            size = readUint(buffer, cursor, exponent);
            cursor += exponent;
        }
        switch (type) {
            case 1: {
                const length = 1 << size;
                return length <= 8 ? readInt(buffer, cursor, length) : readUint(buffer, cursor, length);
            }
            case 2:
                return readReal(buffer, cursor, 1 << size);
            case 3:
                return new Date((readReal(buffer, cursor, 8) + 978307200) * 1000).toISOString();
            case 4:
                return buffer.subarray(cursor, cursor + size);
            case 5:
                return buffer.subarray(cursor, cursor + size).toString("ascii");
            case 6: {
                const byteLength = size * 2;
                const bytes = buffer.subarray(cursor, cursor + byteLength);
                try {
                    return new TextDecoder("utf-16be").decode(bytes);
                } catch {
                    const swapped = Buffer.allocUnsafe(byteLength);
                    for (let i = 0; i + 1 < byteLength; i += 2) {
                        swapped[i] = bytes[i + 1];
                        swapped[i + 1] = bytes[i];
                    }
                    return swapped.toString("utf16le");
                }
            }
            case 8:
                return { __uid__: readUint(buffer, cursor, 1 << size) };
            case 10:
            case 12: {
                const items: unknown[] = [];
                for (let i = 0; i < size; i++) {
                    items.push(parseObject(readUint(buffer, cursor + i * objectRefSize, objectRefSize)));
                }
                return items;
            }
            case 13: {
                const keys: unknown[] = [];
                const values: unknown[] = [];
                for (let i = 0; i < size; i++) {
                    keys.push(parseObject(readUint(buffer, cursor + i * objectRefSize, objectRefSize)));
                }
                for (let i = 0; i < size; i++) {
                    values.push(parseObject(readUint(buffer, cursor + (size + i) * objectRefSize, objectRefSize)));
                }
                const dict: Record<string, unknown> = {};
                keys.forEach((key, i) => {
                    if (typeof key === "string") {
                        dict[key] = values[i];
                    }
                });
                return dict;
            }
            default:
                throw new VoicemailStoreError(`Unsupported plist object type 0x${type.toString(16)} in transcript`);
        }
    };

    return parseObject(topObject);
}

/** Resolves an NSKeyedArchiver archive (`$objects` + `$top`) into plain values. */
export function unarchiveKeyedArchive(archive: unknown): unknown {
    const objects = archive && typeof archive === "object" ? (archive as PlistValue).$objects : null;
    if (!Array.isArray(objects)) return archive;

    const visiting = new Set<number>();
    const resolve = (value: unknown): unknown => {
        if (isUidRef(value)) {
            if (visiting.has(value.__uid__)) return null;
            visiting.add(value.__uid__);
            const target = objects[value.__uid__];
            const resolved = target === undefined ? null : resolve(target);
            visiting.delete(value.__uid__);
            return resolved;
        }
        if (Array.isArray(value)) return value.map(resolve);
        if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
            const record = value as PlistValue;
            if (Array.isArray(record["NS.objects"]) && Array.isArray(record["NS.keys"])) {
                const keys = resolve(record["NS.keys"]) as unknown[];
                const values = resolve(record["NS.objects"]) as unknown[];
                const dict: Record<string, unknown> = {};
                keys.forEach((key, i) => {
                    if (typeof key === "string") {
                        dict[key] = values[i];
                    }
                });
                return dict;
            }
            if (Array.isArray(record["NS.objects"])) {
                return resolve(record["NS.objects"]);
            }
            if (record.$classname !== undefined) return null;
            const plain: Record<string, unknown> = {};
            for (const [key, entry] of Object.entries(record)) {
                if (key !== "$class") {
                    plain[key] = resolve(entry);
                }
            }
            return plain;
        }
        return value;
    };

    const top = archive && typeof archive === "object" && (archive as PlistValue).$top && typeof (archive as PlistValue).$top === "object"
        ? ((archive as PlistValue).$top as Record<string, unknown>)
        : {};
    return resolve(top.root);
}

interface CaptionSegment {
    text: string;
    confidence: number | null;
}

export interface Transcript {
    text: string;
    segments: CaptionSegment[];
    confidence: number | null;
}

function numberOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Shapes a TUCaption transcript archive into text, per-segment captions and confidence. */
export function extractTranscript(archive: unknown): Transcript {
    let rawSegments: unknown[] = [];
    let text: string | null = null;
    let confidence: number | null = null;
    if (Array.isArray(archive)) {
        rawSegments = archive;
    } else if (archive && typeof archive === "object") {
        const record = archive as { segments?: unknown; transcriptionString?: unknown; confidence?: unknown };
        rawSegments = Array.isArray(record.segments) ? record.segments : [];
        if (typeof record.transcriptionString === "string") {
            text = record.transcriptionString;
        }
        confidence = numberOrNull(record.confidence);
    }
    const segments: CaptionSegment[] = rawSegments
        .filter((segment): segment is { text: string; confidence?: unknown } => {
            return (
                segment !== null &&
                typeof segment === "object" &&
                typeof (segment as { text?: unknown }).text === "string"
            );
        })
        .map((segment) => ({ text: segment.text, confidence: numberOrNull(segment.confidence) }));
    if (text === null) {
        text = segments.map((segment) => segment.text).filter((segmentText) => segmentText.length > 0).join(" ").trim();
    }
    return { text, segments, confidence };
}
