# AGENT_MEMORY — the project's standing requirements, decisions and corrections

This folder is the persistent memory of the work on SingersVoice: what the product owner (HN) has asked for,
what was decided, what went wrong and was corrected, and what remains. It was distilled on 23 Nov 2026 from
the whole conversation history and is kept current from then on.

## Mandatory rule for any agent (or person) changing this code

1. **Before any code change, read the files here that touch the area you are about to change** — at the
   least `audio-modes.md` for anything under `apps/web/src/audio`, `packages/protocol/src/audio.ts` or
   `apps/web/public/worklets`; `recording-and-publishing.md` for the Studio, meets, Performances or
   broadcast; `defaults-and-preferences.md` before changing any default; `security-and-privacy.md` before
   touching tokens, keys, logs or anything that leaves the device.
2. **Follow what is documented.** A documented requirement is the owner's; it is not changed by a guess.
   When a new request contradicts a documented one, the new request wins — and the file is updated in the
   same change (date it, keep the earlier line as history where it explains why things are as they are).
3. **Update these files in the same commit as the change** whenever a requirement, a default, a decision or
   a verification result changes. Never leave the code and this memory saying different things.
4. **Verify before claiming.** `verification.md` lists what proves what. "Done" means the listed labs and
   e2es pass and, for audio, the recorded output was measured.

## Files

| File | What it holds |
|---|---|
| `product-architecture.md` | What SingersVoice is, its parts, the two user-facing modes (Performer / Publisher), hosting, how code ships |
| `audio-modes.md` | **The two listening modes (PERFORMER / PUBLISH)**, their signal paths, levels and defaults, the vocal-loudness requirement history |
| `defaults-and-preferences.md` | Every default a singer starts with, where settings live, the owner's working preferences |
| `recording-and-publishing.md` | Offline takes, joins, live meets, films, broadcast, the Performances folder, chapters, roles and plans |
| `security-and-privacy.md` | The constraints that must never be broken (verbatim) |
| `decisions.md` | Implementation decisions and why (framing, stage layout, permissions, settings, mix) |
| `history-and-corrections.md` | Dated bugs, misunderstandings and their corrections; outstanding tasks and known limitations |
| `verification.md` | The commands that verify the app and the numbers they must give |
