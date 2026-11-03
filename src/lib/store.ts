import { execFile as execFileCallback } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

/** Seconds between 2001-01-01 (Apple's Core Data epoch) and 1970-01-01. */
export const APPLE_EPOCH = 978307200;

const HOME = process.env.HOME ?? "";
export const STORE_DIR = path.join(
    HOME,
    "Library",
    "Group Containers",
    "group.com.apple.FaceTime",
    "com.apple.facetimemessagestored",
    "Data Store",
);
export const DB_PATH = path.join(STORE_DIR, "FaceTimeMessageStore-local.sqlitedb");

const PROVIDER = "com.apple.coretelephony";

/** Error whose message is safe to surface to the user; maps to HTTP 400. */
export class VoicemailStoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "VoicemailStoreError";
    }
}

interface QueryOptions {
    timeout: number;
    maxBuffer: number;
}

const execFile = promisify(execFileCallback);

/** Throws a friendly error when the FaceTime message store is absent or unreadable. */
export async function ensureStore(): Promise<void> {
    try {
        await fs.access(DB_PATH, fs.constants.R_OK);
    } catch {
        throw new VoicemailStoreError(
            "No voicemail store found on this Mac. Voicemails sync from an iPhone to the Phone app on macOS 26 (Tahoe) or later; open the Phone app once and make sure the iPhone and Mac are signed into the same Apple Account.",
        );
    }
}

/** Runs a read-only sqlite3 query and parses its `-json` output. */
export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    try {
        const options: QueryOptions = { timeout: 10_000, maxBuffer: 64 * 1024 * 1024 };
        const { stdout } = await execFile("sqlite3", ["-json", "-readonly", DB_PATH, sql], options);
        const text = stdout.trim();
        return text ? (JSON.parse(text) as T[]) : [];
    } catch (error) {
        const detail = String((error as { stderr?: string; message?: string })?.stderr || (error as Error)?.message || error);
        if (/unable to open|authorization denied|operation not permitted/i.test(detail)) {
            throw new VoicemailStoreError(
                `The voicemail store exists but could not be read (${detail.trim()}). Grant Enconvo (or your terminal) Full Disk Access in System Settings, then try again.`,
            );
        }
        throw new VoicemailStoreError(`Voicemail store query failed: ${detail.trim()}`);
    }
}

/** Quotes a value for SQL, doubling single quotes. */
export function sqlQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/** Escapes LIKE wildcards (and the escape character itself) in user input. */
export function likeEscape(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** The digits of a phone-number-like string, or null when it is not number-like. */
export function digitsOf(input: string): string | null {
    const digits = [...input].filter((char) => char >= "0" && char <= "9").join("");
    if (digits.length < 3) return null;
    const allowed = new Set(["+", "-", " ", "(", ")", "."]);
    for (const char of input) {
        if (!(char >= "0" && char <= "9") && !allowed.has(char)) return null;
    }
    return digits;
}

/** SQL that strips phone formatting characters from an expression. */
export function digitsLikeSql(expression: string): string {
    let result = expression;
    for (const char of ["+", "-", " ", "(", ")", "."]) {
        result = `REPLACE(${result}, ${sqlQuote(char)}, '')`;
    }
    return result;
}

/** Parses an ISO 8601 date/time into Apple epoch seconds. */
export function toAppleEpoch(value: string, name: string): number {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
        throw new VoicemailStoreError(`${name} must be an ISO 8601 date, got ${JSON.stringify(value)}`);
    }
    return Math.floor(parsed / 1000) - APPLE_EPOCH;
}

/** Formats Apple epoch seconds as an ISO 8601 date/time. */
export function isoFromAppleEpoch(seconds: number | null | undefined): string {
    return new Date(((seconds ?? 0) + APPLE_EPOCH) * 1000).toISOString();
}

const MAILBOX_TYPES: Record<string, number> = { inbox: 0, blocked: 1, deleted: 2 };

/** The mailbox name for a ZMAILBOXTYPE value. */
export function mailboxName(type: number | null | undefined): string {
    if (type == null) return "unknown";
    for (const [name, value] of Object.entries(MAILBOX_TYPES)) {
        if (value === type) return name;
    }
    return "unknown";
}

const AUDIO_MIME_TYPES: Record<string, string> = { amr: "audio/amr", m4a: "audio/mp4", mov: "audio/mp4" };

/** The MIME type of a voicemail recording file type, or null. */
export function audioMime(fileType: string | null | undefined): string | null {
    return fileType ? (AUDIO_MIME_TYPES[fileType.toLowerCase()] ?? null) : null;
}

/** The store-relative asset path for a recording, or null when the UUID is malformed. */
export function assetRelativePath(uuidHex: string, fileType: string): string | null {
    if (!/^[0-9a-f]{32}$/i.test(uuidHex)) return null;
    const uuid = uuidHex.toUpperCase();
    const dashed = `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
    return `Assets/${uuid.slice(0, 2)}/${dashed}.${fileType}`;
}

/** Whether the process can read the given path. */
export async function isReadable(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath, fs.constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

/** Accepts an integer id (number or digit-string) and rejects everything else. */
export function parseVoicemailId(raw: unknown): number {
    if (typeof raw === "number" && Number.isInteger(raw)) return raw;
    if (typeof raw === "string" && /^(\d+)$/.test(raw.trim())) return Number.parseInt(raw.trim(), 10);
    throw new VoicemailStoreError("id must be a voicemail id from get_voicemails");
}

export interface VoicemailRow {
    id: number;
    sender?: string | null;
    dateCd?: number | null;
    duration?: number | null;
    fileType?: string | null;
    uuidHex?: string | null;
}

/** Fetches the identifying row of one non-deleted voicemail, or throws. */
export async function fetchVoicemailRow(id: number): Promise<VoicemailRow> {
    const rows = await query<VoicemailRow>(`SELECT Z_PK AS id, ZFROM AS sender, ZDATECREATED AS dateCd,
        ZDURATION AS duration, ZFILETYPE AS fileType, lower(hex(ZRECORDUUID)) AS uuidHex
        FROM ZSTOREDMESSAGE WHERE Z_PK = ${id} AND ZDATEDELETED IS NULL
        AND ZPROVIDER = ${sqlQuote(PROVIDER)}`);
    if (rows.length === 0) {
        throw new VoicemailStoreError(`No voicemail found with id ${id}`);
    }
    return rows[0];
}
