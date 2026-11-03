import { EnconvoResponse } from "@enconvo/api";
import fs from "fs/promises";
import path from "path";
import {
    VoicemailStoreError,
    assetRelativePath,
    audioMime,
    ensureStore,
    fetchVoicemailRow,
    isoFromAppleEpoch,
    isReadable,
    parseVoicemailId,
    STORE_DIR,
} from "./lib/store";

/** Resolves one voicemail's audio file, copying it to `destination` when given. */
export async function getAudio(id: unknown, destination?: unknown) {
    await ensureStore();
    const numericId = parseVoicemailId(id);
    const row = await fetchVoicemailRow(numericId);
    const fileType = row.fileType ?? "";
    const mimeType = audioMime(fileType);
    if (!fileType || !mimeType) {
        throw new VoicemailStoreError(`The voicemail with id ${numericId} has no playable audio (file type ${fileType || "unknown"})`);
    }
    const relative = assetRelativePath(row.uuidHex ?? "", fileType);
    if (!relative) {
        throw new VoicemailStoreError(`The voicemail with id ${numericId} has no audio file reference`);
    }
    const storePath = path.join(STORE_DIR, relative);
    if (!(await isReadable(storePath))) {
        throw new VoicemailStoreError(`The audio file of the voicemail with id ${numericId} is missing from the store`);
    }
    const date = isoFromAppleEpoch(row.dateCd);
    if (typeof destination === "string" && destination) {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(storePath, destination);
        return {
            id: numericId,
            sender: row.sender ?? "Unknown",
            date,
            path: destination,
            mimeType,
            bytes: (await fs.stat(destination)).size,
            copied: true,
        };
    }
    return {
        id: numericId,
        sender: row.sender ?? "Unknown",
        date,
        path: storePath,
        mimeType,
        bytes: (await fs.stat(storePath)).size,
        copied: false,
    };
}

/** Get the audio recording of one voicemail by its id. Returns the file path, copying the file somewhere easy to use when the original is not directly readable. */
export default async function main(request: Request) {
    const options = (await request.json()) as { id?: unknown; destination?: unknown };
    try {
        const audio = await getAudio(options.id, options.destination);
        return EnconvoResponse.json(audio);
    } catch (error) {
        const status = error instanceof VoicemailStoreError ? 400 : 500;
        return Response.json({ error: (error as Error)?.message ?? String(error) }, { status });
    }
}
