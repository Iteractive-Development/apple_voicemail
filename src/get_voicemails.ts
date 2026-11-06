import { EnconvoResponse } from "@enconvo/api";
import path from "path";
import {
    VoicemailStoreError,
    audioMime,
    assetRelativePath,
    digitsLikeSql,
    digitsOf,
    ensureStore,
    isoFromAppleEpoch,
    isReadable,
    likeEscape,
    mailboxName,
    query,
    sqlQuote,
    toAppleEpoch,
    STORE_DIR,
} from "./lib/store";

const PROVIDER = "com.apple.coretelephony";
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;
const MAILBOX_TYPES: Record<string, number> = { inbox: 0, blocked: 1, deleted: 2 };
const VALID_MAILBOXES = new Set(["inbox", "blocked", "deleted", "all"]);

interface GetVoicemailsOptions {
    sender?: unknown;
    start?: unknown;
    end?: unknown;
    mailbox?: unknown;
    unread_only?: unknown;
    limit?: unknown;
}

interface ListFilters {
    sender?: string;
    start?: string;
    end?: string;
    mailbox?: string;
    unreadOnly?: boolean;
    limit?: number;
}

interface MessageRow {
    id: number;
    sender: string | null;
    dateCd: number | null;
    duration: number | null;
    isRead: number | null;
    fileType: string | null;
    uuidHex: string | null;
    transcribed: number;
    mailboxType: number | null;
}

export interface Voicemail {
    id: number;
    sender: string;
    date: string;
    durationSeconds: number;
    isRead: boolean;
    mailbox: string;
    transcribed: boolean;
    hasAudio: boolean;
    audioPath: string | null;
    audioMimeType: string | null;
}

/** Lists voicemails with the given filters, newest first. */
export async function listVoicemails(filters: ListFilters): Promise<Voicemail[]> {
    await ensureStore();
    const conditions: string[] = ["ZDATEDELETED IS NULL", `ZPROVIDER = ${sqlQuote(PROVIDER)}`];

    if (filters.sender && filters.sender.trim()) {
        const sender = filters.sender.trim();
        const senderConditions = [`ZFROM LIKE ${sqlQuote("%" + likeEscape(sender) + "%")} ESCAPE '\\'`];
        const digits = digitsOf(sender);
        if (digits) {
            senderConditions.push(`${digitsLikeSql("ZFROM")} LIKE ${sqlQuote("%" + digits + "%")}`);
        }
        conditions.push(`(${senderConditions.join(" OR ")})`);
    }
    if (filters.start) {
        conditions.push(`ZDATECREATED >= ${toAppleEpoch(filters.start, "start")}`);
    }
    if (filters.end) {
        conditions.push(`ZDATECREATED < ${toAppleEpoch(filters.end, "end")}`);
    }
    if (filters.unreadOnly) {
        conditions.push("ZISREAD = 0");
    }

    const mailbox = filters.mailbox ?? "inbox";
    if (mailbox !== "all") {
        conditions.push(`ZMAILBOXTYPE = ${MAILBOX_TYPES[mailbox]}`);
    }

    let limit = Math.floor(filters.limit ?? DEFAULT_LIMIT);
    if (!Number.isFinite(limit) || limit < 1) {
        limit = DEFAULT_LIMIT;
    }
    limit = Math.min(limit, MAX_LIMIT);

    const sql = `SELECT Z_PK AS id, ZFROM AS sender, ZDATECREATED AS dateCd, ZDURATION AS duration,
        ZISREAD AS isRead, ZFILETYPE AS fileType, lower(hex(ZRECORDUUID)) AS uuidHex,
        CASE WHEN ZTRANSCRIPT IS NULL THEN 0 ELSE 1 END AS transcribed, ZMAILBOXTYPE AS mailboxType
        FROM ZSTOREDMESSAGE WHERE ${conditions.join(" AND ")}
        ORDER BY ZDATECREATED DESC LIMIT ${limit}`;

    const rows = await query<MessageRow>(sql);
    const voicemails: Voicemail[] = [];
    for (const row of rows) {
        const fileType = row.fileType ?? null;
        const mimeType = audioMime(fileType);
        let audioPath: string | null = null;
        if (fileType && mimeType) {
            const relative = assetRelativePath(row.uuidHex ?? "", fileType);
            if (relative) {
                const absolute = path.join(STORE_DIR, relative);
                if (await isReadable(absolute)) {
                    audioPath = absolute;
                }
            }
        }
        voicemails.push({
            id: row.id,
            sender: row.sender ?? "Unknown",
            date: isoFromAppleEpoch(row.dateCd),
            durationSeconds: Math.round((row.duration ?? 0) * 10) / 10,
            isRead: !!row.isRead,
            mailbox: mailboxName(row.mailboxType),
            transcribed: !!row.transcribed,
            hasAudio: audioPath !== null,
            audioPath,
            audioMimeType: audioPath ? mimeType : null,
        });
    }
    return voicemails;
}

/** List voicemails synced from iPhone to this Mac, newest first, with sender, date, duration, read state, transcript availability and audio file path. */
export default async function main(request: Request) {
    const options = (await request.json().catch(() => ({}))) as GetVoicemailsOptions;
    try {
        const mailbox = options.mailbox ?? "inbox";
        if (typeof mailbox !== "string" || !VALID_MAILBOXES.has(mailbox)) {
            return Response.json({ error: "mailbox must be one of: inbox, blocked, deleted, all" }, { status: 400 });
        }
        const voicemails = await listVoicemails({
            sender: typeof options.sender === "string" ? options.sender : undefined,
            start: typeof options.start === "string" ? options.start : undefined,
            end: typeof options.end === "string" ? options.end : undefined,
            mailbox,
            unreadOnly: options.unread_only === true,
            limit: typeof options.limit === "number" ? options.limit : undefined,
        });
        return EnconvoResponse.json({ count: voicemails.length, voicemails });
    } catch (error) {
        const status = error instanceof VoicemailStoreError ? 400 : 500;
        return Response.json({ error: (error as Error)?.message ?? String(error) }, { status });
    }
}
