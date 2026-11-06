import { EnconvoResponse } from "@enconvo/api";
import { extractTranscript, parseBinaryPlist, unarchiveKeyedArchive } from "./lib/plist";
import {
    VoicemailStoreError,
    ensureStore,
    fetchVoicemailRow,
    isoFromAppleEpoch,
    parseVoicemailId,
    query,
} from "./lib/store";

/** Reads one voicemail's transcript from the store and shapes it for the response. */
export async function readTranscript(rawId: unknown) {
    await ensureStore();
    const numericId = parseVoicemailId(rawId);
    const row = await fetchVoicemailRow(numericId);
    const transcriptRows = await query<{ transcriptHex: string | null }>(
        `SELECT hex(ZTRANSCRIPT) AS transcriptHex FROM ZSTOREDMESSAGE
        WHERE Z_PK = ${numericId} AND ZTRANSCRIPT IS NOT NULL`,
    );
    if (transcriptRows.length === 0 || !transcriptRows[0].transcriptHex) {
        throw new VoicemailStoreError(`The voicemail with id ${numericId} has no transcript`);
    }
    const archiveBytes = Buffer.from(transcriptRows[0].transcriptHex, "hex");
    return {
        id: numericId,
        sender: row.sender ?? "Unknown",
        date: isoFromAppleEpoch(row.dateCd),
        durationSeconds: Math.round((row.duration ?? 0) * 10) / 10,
        ...extractTranscript(unarchiveKeyedArchive(parseBinaryPlist(archiveBytes))),
    };
}

/** Get the transcribed text of one voicemail by its id, as returned by get_voicemails. */
export default async function main(request: Request) {
    const options = (await request.json().catch(() => ({}))) as { id?: unknown };
    try {
        const transcript = await readTranscript(options.id);
        return EnconvoResponse.json(transcript);
    } catch (error) {
        const status = error instanceof VoicemailStoreError ? 400 : 500;
        return Response.json({ error: (error as Error)?.message ?? String(error) }, { status });
    }
}
