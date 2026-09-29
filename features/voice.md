# Voice

**Public appeal:** ⭐ Send a voice note and get an answer, spoken if you like. Hermes transcribes voice
memos and speaks through text-to-speech; OpenClaw's companion apps add voice.

**Specified:** idea

**Needed by:** nothing required.

## What it gives
Voice notes in (transcribed, then answered) and, when asked, voice notes out.

## How it fits pikit
- In: a channel receives the audio as an attachment ([rich content](rich-content.md)). An
  `inbound-transcribe` component adds an `inbound.normalize` stage that calls a speech-to-text
  provider through `network.fetch`, with its key from `secrets`, and puts the text in the message;
  the audio stays referenced in `storage.blob`.
- Out: a `voice` part, declared by the component that introduces it (SPEC §5, "Rich content"),
  with its text as `fallback`. A transport that `draws` it sends a voice message; any other sends
  the text. A text-to-speech provider makes the audio.
- Absent: a voice note is a message the channel cannot take, and it says so (the `halted` outcome,
  SPEC §5).

## Pi first
pi-ai 0.99.0 carries text and images (`ImageContent`), not audio, and Pi transcribes nothing. So
the transcription is pikit's for now. If pi-ai gains audio input for a model, the transcription
stage is deleted and the audio goes to the model: check pi-ai before building.

## Open questions
- Which providers first, and whether they are `provider-*` components (like model providers) or
  values of the transcribe component.
- Where audio lives and for how long (`storage.blob`; R2 on Cloudflare, since a SQL row is at most
  2 MB, SPEC §9.2).
- Live voice calls are out of scope here.
