import express from "express";
import multer from "multer";
import OpenAI from "openai";

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const app = express();

const PORT = Number(process.env.PORT || 3000);

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const EXPORT_DIR = path.join(ROOT, "exports");
const WORK_DIR = path.join(ROOT, "work");

for (const dir of [
  PUBLIC_DIR,
  UPLOAD_DIR,
  EXPORT_DIR,
  WORK_DIR
]) {
  fs.mkdirSync(dir, { recursive: true });
}

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 500 * 1024 * 1024
  }
});

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    })
  : null;

app.use(express.static(PUBLIC_DIR));
app.use("/exports", express.static(EXPORT_DIR));

function safeDelete(file) {
  try {
    if (file && fs.existsSync(file)) {
      fs.rmSync(file, {
        recursive: true,
        force: true
      });
    }
  } catch (error) {
    console.error("Cleanup error:", error.message);
  }
}

async function run(command, args) {
  console.log(
    command,
    args.map((x) => JSON.stringify(x)).join(" ")
  );

  const { stdout, stderr } = await execFileAsync(
    command,
    args,
    {
      maxBuffer: 50 * 1024 * 1024
    }
  );

  if (stderr) {
    console.log(stderr);
  }

  return stdout;
}

async function ffprobe(file) {
  const stdout = await run("ffprobe", [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file
  ]);

  return JSON.parse(stdout);
}

function getDuration(info) {
  return Number(info?.format?.duration || 0);
}

function getVideoDimensions(info) {
  const video = info.streams.find(
    (stream) => stream.codec_type === "video"
  );

  return {
    width: Number(video?.width || 1920),
    height: Number(video?.height || 1080)
  };
}

async function extractAudio(video, output) {
  await run("ffmpeg", [
    "-y",
    "-i",
    video,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "mp3",
    "-b:a",
    "64k",
    output
  ]);
}

async function transcribeAudio(audioFile) {
  if (!openai) {
    return {
      text: "",
      segments: []
    };
  }

  const result =
    await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFile),
      model: "gpt-4o-transcribe",
      response_format: "json"
    });

  return {
    text: result.text || "",
    segments: result.segments || []
  };
}

async function extractAnalysisFrames(
  video,
  duration,
  directory
) {
  const frameDirectory =
    path.join(directory, "frames");

  fs.mkdirSync(frameDirectory, {
    recursive: true
  });

  /*
   * Sample the WHOLE video.
   *
   * Short clips get frequent frames.
   * Longer clips get fewer frames so requests
   * don't become enormous.
   */
  let interval = 2;

  if (duration > 60) interval = 3;
  if (duration > 120) interval = 5;
  if (duration > 300) interval = 8;

  const pattern =
    path.join(frameDirectory, "frame-%04d.jpg");

  await run("ffmpeg", [
    "-y",
    "-i",
    video,
    "-vf",
    `fps=1/${interval},scale=640:-2`,
    "-q:v",
    "5",
    pattern
  ]);

  const files = fs
    .readdirSync(frameDirectory)
    .filter((name) => name.endsWith(".jpg"))
    .sort();

  /*
   * Keep requests manageable.
   */
  const maxFrames = 45;

  let selected = files;

  if (files.length > maxFrames) {
    selected = [];

    for (let i = 0; i < maxFrames; i++) {
      const index = Math.floor(
        (i / (maxFrames - 1)) *
          (files.length - 1)
      );

      selected.push(files[index]);
    }

    selected = [...new Set(selected)];
  }

  return selected.map((name, index) => {
    const fullPath =
      path.join(frameDirectory, name);

    const base64 =
      fs.readFileSync(fullPath).toString("base64");

    /*
     * Approximate timestamp for AI context.
     */
    const originalIndex =
      files.indexOf(name);

    const timestamp =
      Math.min(
        duration,
        originalIndex * interval
      );

    return {
      timestamp,
      dataUrl:
        `data:image/jpeg;base64,${base64}`
    };
  });
}

function fallbackPlan(duration) {
  /*
   * If AI is unavailable, don't destroy
   * the user's clip. Keep the ending-heavy
   * portion instead.
   */
  const desiredLength =
    Math.min(duration, 45);

  const start =
    Math.max(0, duration - desiredLength);

  return {
    title: "Minecraft Challenge",
    clipType: "minecraft",
    summary:
      "AI analysis unavailable. Using ending-focused fallback.",
    hook:
      "WAIT FOR THE END 👀",
    segments: [
      {
        start,
        end: duration,
        reason:
          "Ending-focused fallback"
      }
    ]
  };
}

function cleanJSON(text) {
  let value = text.trim();

  value = value
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  return JSON.parse(value);
}

async function analyzeVideoStory({
  duration,
  transcript,
  frames
}) {
  if (!openai) {
    return fallbackPlan(duration);
  }

  const content = [
    {
      type: "input_text",
      text: `
You are the story editor for a family-friendly
Minecraft YouTube Shorts creator.

Analyze the ENTIRE video before deciding what to cut.

VIDEO DURATION:
${duration.toFixed(2)} seconds

TRANSCRIPT:
${transcript.text || "(No usable transcript)"}

IMPORTANT CREATOR RULES:

1. The final video must tell a coherent story.

2. The ending often contains the main payoff,
win, loss, reveal, funny moment, reaction,
or result.

3. Work backward from that payoff and keep
the earlier footage that is necessary to
understand or enjoy it.

4. Remove footage that does not contribute:
long walking, waiting, menus, inventory
management, repetitive gameplay, silence,
failed setup, or unrelated conversation.

5. DO NOT remove setup that is necessary
for the ending to make sense.

6. Some videos are Minecraft minigames.

7. A minigame introduction commonly begins
with the spoken word "Minecraft", such as:
"Minecraft Arrow Toss"
"Minecraft Take It or Leave It"

8. If the video is a minigame, identify the
game from the actual video/transcript.
Do NOT assume every Minecraft video is
the same minigame.

9. Preserve:
- the challenge/setup
- necessary rules
- important choices
- meaningful attempts
- funny dialogue
- reactions
- the payoff/result

10. Create a SHORT HEADER/HORIZONTAL HOOK
for approximately the opening 3 seconds.

11. The hook MUST match what ACTUALLY happens
in the whole video.

12. Never invent an event that does not occur.

13. Make the hook interesting without fully
spoiling the payoff when possible.

14. Hook should normally be 3-8 words.

15. Examples of STYLE only:
"HE RISKED ALL HIS DIAMONDS 😭"
"CAN I ACTUALLY HIT THIS?!"
"THIS GOT OUT OF CONTROL..."
Do not copy these unless accurate.

16. Keep the final edit energetic.
Usually aim for 15-45 seconds when the
source supports that, but story coherence
is more important than forcing a length.

17. Do not cut mid-sentence unless necessary.

18. Return ONLY valid JSON.

JSON FORMAT:

{
  "title": "detected game/video title",
  "clipType": "minigame or gameplay",
  "summary": "one sentence explaining the story",
  "hook": "short accurate hook",
  "segments": [
    {
      "start": 0.0,
      "end": 5.5,
      "reason": "why this section matters"
    }
  ]
}

Segment timestamps MUST be within
0-${duration.toFixed(2)} seconds.

Segments MUST be chronological and
must not overlap.
`
    }
  ];

  /*
   * Each frame gets its approximate timestamp
   * immediately before the image.
   */
  for (const frame of frames) {
    content.push({
      type: "input_text",
      text:
        `Frame around ${frame.timestamp.toFixed(1)} seconds:`
    });

    content.push({
      type: "input_image",
      image_url: frame.dataUrl
    });
  }

  const response =
    await openai.responses.create({
      model: "gpt-5.6-luna",
      input: [
        {
          role: "user",
          content
        }
      ]
    });

  const text =
    response.output_text || "";

  const plan =
    cleanJSON(text);

  if (
    !Array.isArray(plan.segments) ||
    plan.segments.length === 0
  ) {
    throw new Error(
      "AI returned no usable video segments."
    );
  }

  return plan;
}

function normalizeSegments(
  segments,
  duration
) {
  const cleaned = [];

  for (const segment of segments) {
    let start =
      Number(segment.start);

    let end =
      Number(segment.end);

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end)
    ) {
      continue;
    }

    start =
      Math.max(0, Math.min(duration, start));

    end =
      Math.max(0, Math.min(duration, end));

    if (end - start < 0.35) {
      continue;
    }

    cleaned.push({
      start,
      end,
      reason:
        segment.reason || ""
    });
  }

  cleaned.sort(
    (a, b) => a.start - b.start
  );

  const result = [];

  for (const segment of cleaned) {
    const previous =
      result[result.length - 1];

    if (
      previous &&
      segment.start < previous.end
    ) {
      segment.start =
        previous.end;
    }

    if (
      segment.end - segment.start >= 0.35
    ) {
      result.push(segment);
    }
  }

  if (result.length === 0) {
    return fallbackPlan(duration).segments;
  }

  return result;
}

async function cutSegments({
  video,
  segments,
  directory
}) {
  const clips = [];

  for (
    let index = 0;
    index < segments.length;
    index++
  ) {
    const segment =
      segments[index];

    const output =
      path.join(
        directory,
        `segment-${index}.mp4`
      );

    await run("ffmpeg", [
      "-y",
      "-ss",
      String(segment.start),
      "-to",
      String(segment.end),
      "-i",
      video,

      /*
       * FULL 9:16 FRAME.
       *
       * Horizontal video is enlarged until it
       * fills 1080x1920 and then center-cropped.
       *
       * No black bars.
       */
      "-vf",
      [
        "scale=1080:1920:force_original_aspect_ratio=increase",
        "crop=1080:1920"
      ].join(","),

      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",

      "-c:a",
      "aac",
      "-b:a",
      "192k",

      "-movflags",
      "+faststart",

      output
    ]);

    clips.push(output);
  }

  return clips;
}

async function concatenateClips(
  clips,
  directory
) {
  const listFile =
    path.join(directory, "concat.txt");

  const escaped =
    clips
      .map((file) => {
        const value =
          file.replace(/'/g, "'\\''");

        return `file '${value}'`;
      })
      .join("\n");

  fs.writeFileSync(
    listFile,
    escaped
  );

  const output =
    path.join(directory, "story.mp4");

  await run("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    output
  ]);

  return output;
}

function escapeDrawText(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

async function addHookAndMusic({
  video,
  music,
  hook,
  output
}) {
  const info =
    await ffprobe(video);

  const duration =
    getDuration(info);

  const safeHook =
    escapeDrawText(
      (hook || "WAIT FOR THE END 👀")
        .toUpperCase()
    );

  /*
   * Music defaults to 12%.
   * Voice/game audio stays dominant.
   *
   * Sidechain compression ducks music
   * further when original audio becomes loud.
   */
  const filter = [
    /*
     * Loop/trim music to final video length.
     */
    `[1:a]volume=0.12,atrim=0:${duration},asetpts=N/SR/TB[music]`,

    /*
     * Use original audio as sidechain so
     * music backs away during speech/action.
     */
    `[music][0:a]sidechaincompress=threshold=0.025:ratio=8:attack=20:release=350[ducked]`,

    /*
     * Mix original audio + ducked music.
     */
    `[0:a][ducked]amix=inputs=2:duration=first:normalize=0[aout]`,

    /*
     * Header for first ~3 seconds.
     */
    `[0:v]drawtext=` +
      `text='${safeHook}':` +
      `fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:` +
      `fontcolor=white:` +
      `fontsize=62:` +
      `borderw=6:` +
      `bordercolor=black:` +
      `x=(w-text_w)/2:` +
      `y=170:` +
      `enable='between(t,0,3)'` +
      `[vout]`
  ].join(";");

  await run("ffmpeg", [
    "-y",

    "-i",
    video,

    /*
     * Infinite music loop.
     */
    "-stream_loop",
    "-1",
    "-i",
    music,

    "-filter_complex",
    filter,

    "-map",
    "[vout]",

    "-map",
    "[aout]",

    "-t",
    String(duration),

    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",

    "-c:a",
    "aac",
    "-b:a",
    "192k",

    "-movflags",
    "+faststart",

    output
  ]);
}

app.get("/api/health", async (req, res) => {
  try {
    const ffmpeg =
      await run("ffmpeg", ["-version"]);

    res.json({
      ok: true,
      ffmpeg:
        ffmpeg.split("\n")[0],
      ai:
        Boolean(process.env.OPENAI_API_KEY)
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post(
  "/api/edit",
  upload.fields([
    {
      name: "video",
      maxCount: 1
    },
    {
      name: "music",
      maxCount: 1
    }
  ]),
  async (req, res) => {
    const job =
      crypto.randomUUID();

    const directory =
      path.join(WORK_DIR, job);

    fs.mkdirSync(directory, {
      recursive: true
    });

    const video =
      req.files?.video?.[0]?.path;

    const music =
      req.files?.music?.[0]?.path;

    if (!video || !music) {
      safeDelete(video);
      safeDelete(music);
      safeDelete(directory);

      return res.status(400).json({
        error:
          "Please upload both a video and background music."
      });
    }

    try {
      console.log(
        `[${job}] Starting analysis`
      );

      const info =
        await ffprobe(video);

      const duration =
        getDuration(info);

      if (!duration) {
        throw new Error(
          "Could not determine video duration."
        );
      }

      const dimensions =
        getVideoDimensions(info);

      console.log(
        `[${job}] Source ${dimensions.width}x${dimensions.height}, ${duration}s`
      );

      /*
       * AUDIO / SPEECH ANALYSIS
       */
      const audio =
        path.join(
          directory,
          "speech.mp3"
        );

      await extractAudio(
        video,
        audio
      );

      let transcript = {
        text: "",
        segments: []
      };

      try {
        transcript =
          await transcribeAudio(audio);
      } catch (error) {
        console.error(
          "Transcription failed:",
          error.message
        );
      }

      /*
       * VISUAL ANALYSIS ACROSS WHOLE VIDEO
       */
      const frames =
        await extractAnalysisFrames(
          video,
          duration,
          directory
        );

      let plan;

      try {
        plan =
          await analyzeVideoStory({
            duration,
            transcript,
            frames
          });
      } catch (error) {
        console.error(
          "AI analysis failed:",
          error.message
        );

        plan =
          fallbackPlan(duration);
      }

      const segments =
        normalizeSegments(
          plan.segments,
          duration
        );

      console.log(
        `[${job}] Detected type:`,
        plan.clipType
      );

      console.log(
        `[${job}] Hook:`,
        plan.hook
      );

      console.log(
        `[${job}] Segments:`,
        segments
      );

      /*
       * CUT + FULL-SCREEN VERTICAL REFRAME
       */
      const clips =
        await cutSegments({
          video,
          segments,
          directory
        });

      const story =
        await concatenateClips(
          clips,
          directory
        );

      /*
       * HOOK + LOW BACKGROUND MUSIC
       */
      const filename =
        `${job}.mp4`;

      const output =
        path.join(
          EXPORT_DIR,
          filename
        );

      await addHookAndMusic({
        video: story,
        music,
        hook: plan.hook,
        output
      });

      res.json({
        success: true,

        url:
          `/exports/${filename}`,

        analysis: {
          title:
            plan.title ||
            "Minecraft Short",

          type:
            plan.clipType ||
            "gameplay",

          summary:
            plan.summary ||
            "",

          hook:
            plan.hook ||
            "",

          segments
        }
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          error.message ||
          "Video editing failed."
      });
    } finally {
      safeDelete(video);
      safeDelete(music);
      safeDelete(directory);
    }
  }
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `KindCrafted AI Clip Editor running on port ${PORT}`
  );

  console.log(
    `AI analysis: ${
      process.env.OPENAI_API_KEY
        ? "enabled"
        : "disabled"
    }`
  );
});
