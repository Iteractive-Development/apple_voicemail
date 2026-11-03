---
name: apple-voicemail
description: Read iPhone voicemails synced to this Mac through apple_voicemail APIs — list with filters, get transcripts, and get audio files.
metadata:
  platforms: darwin
  short-description: List and read iPhone voicemails on this Mac
---

# Apple Voicemail

Use `apple_voicemail/*` routes for voicemail workflows. Voicemails sync from the
iPhone to the Mac's Phone app live — no backup needed. Use `apple-contacts`
first when the user gives a person name instead of a phone number.

## Routes

- `apple_voicemail/get_voicemails` - list voicemails, newest first. Optional:
  `sender` (partial phone number, formatting ignored), `start`/`end` (ISO 8601
  bounds), `mailbox` (`inbox` default, `blocked`, `deleted`, `all`),
  `unread_only` (boolean), `limit` (default 30). Each item carries `id`,
  `sender`, `date`, `durationSeconds`, `isRead`, `transcribed`, `hasAudio` and
  `audioPath`.
- `apple_voicemail/get_transcript` - transcribed text of one voicemail.
  Required: `id` from `get_voicemails`.
- `apple_voicemail/get_audio` - audio recording file path of one voicemail.
  Required: `id`. Optional: `destination` (absolute path to copy the file to).

## Workflows

- Catch up on voicemail: `get_voicemails` with `unread_only: true` ->
  `get_transcript` for each -> summarize by urgency.
- Find a voicemail: resolve contact to number if needed -> `get_voicemails`
  with `sender` -> `get_transcript` -> quote the text.
- Play or share a recording: `get_voicemails` -> `get_audio` -> use the
  returned `path` (pass `destination` to save a copy elsewhere).

## Notes

- `transcribed` false means the store has no transcript yet; audio may still exist.
- Requires macOS 26 (Tahoe) or later with iPhone voicemail sync to the Phone app.
- Reading only; the plugin never writes to the voicemail store.
