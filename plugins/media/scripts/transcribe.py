"""Print a video's timed transcript as JSON on stdout.

Vendored into crunes-plugins for local speech-to-text fallback when web subtitles are absent.
Usage: uv run python -X utf8 -I scripts/transcribe.py <video>
"""
import json
import os
import sys

try:
    import av
    from faster_whisper import WhisperModel
except ImportError as err:
    sys.stderr.write(f"Missing dependency: {err}. Run via uv with faster-whisper and av installed.\n")
    sys.exit(2)

MODEL = os.environ.get("WHISPER_MODEL", "medium")


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: transcribe.py <video-file>\n")
        sys.exit(1)

    video = sys.argv[1]

    with av.open(video) as container:
        has_audio = len(container.streams.audio) > 0
        container_duration_s = (container.duration or 0) / 1_000_000

    if not has_audio:
        result = {
            "language": None,
            "duration_s": container_duration_s,
            "speech_s": 0.0,
            "segments": [],
        }
    else:
        model = WhisperModel(MODEL, device="cpu", compute_type="int8")
        segments, info = model.transcribe(video, vad_filter=True)
        result = {
            "language": info.language,
            "duration_s": info.duration,
            "speech_s": info.duration_after_vad,
            "segments": [
                {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
                for s in segments
            ],
        }

    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
