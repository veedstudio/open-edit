# Test fixtures

## talking-head.mp4

Ten seconds of a radio interview: three shots, the interviewee on the right, the host on the left, then
the interviewee again. 640x360, 30000/1001 fps, H.264, no audio, 200,742 bytes.

- Source: "Commander, Fleet Activities Yokosuka Interview (997782).webm" on Wikimedia Commons,
  https://commons.wikimedia.org/wiki/File:Commander,_Fleet_Activities_Yokosuka_Interview_(997782).webm,
  from DVIDS video 997782 (VIRIN 260219-N-HE057-1001). U.S. Navy video by Mass Communication Specialist
  2nd Class Nicholas Rodriguez, 18 February 2026.
- Licence: public domain, as a work of a U.S. Navy service member made during official duties
  (Commons template PD-USGov-Military-Navy).
- Made from Commons' 480p VP9 transcode of that file:
  `ffmpeg -ss 30 -i <480p transcode> -t 10 -an -vf scale=640:360 -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -movflags +faststart talking-head.mp4`
- Hand-annotated nose points, in pixels: the interviewee near (412, 115), the host near (215, 118).
  The shots change near 2.469 s and 8.175 s.

## transcripts/

Speech-to-text and voice answers exactly as they came, one file per format a transcript is read in, saved
without whitespace. Apart from the first, the speech is a generated voice reading an ad or explainer script
written for a test brief.

- `whisper-segments.json`: a Whisper JSON with segments and word times, the shape an upload's transcript
  arrives in, of a phone recording of a talk to camera. 16 words over 8 seconds.
- `fal-whisper-words.json`: `fal-ai/whisper`'s answer with `chunk_level` `"word"`: one word per chunk under
  `chunks[].timestamp`. 48 words.
- `fal-whisper-words.fal-result.json` and `fal-whisper-segments.fal-result.json`: the same model on one
  five-second line, kept by `openedit fal run` in its `fal-result.json`, with `chunk_level` `"word"` and with
  its default, one chunk per segment and no word times.
- `typed-words.json`: a fal speech-to-text model's `words[]`, each entry typed `word` or `spacing`.
- `forced-alignment.json`: a fal forced-alignment model's `words[]` (spaces as entries of their own) and
  `characters[]`.
- `voice-character-timestamps.json`: a fal voice model's answer with timestamps asked for: the audio and
  `timestamps[]`, blocks of characters with their start and end times, the bracketed directions given to the
  voice (`[excited]`, `[whispers]`) timed among them.
