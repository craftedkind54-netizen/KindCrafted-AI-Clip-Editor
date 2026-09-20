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

function hasAudio(info) {
  return info.streams.some(
    (stream) => stream.codec_type === "audio"
  );
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

  return selected.map((name) => {
    const fullPath =
      path.join(frameDirectory, name);

    const base64 =
      fs.readFileSync(fullPath).toString("base64");

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
    ],

    memes: []
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
You are an AI video editor for a family-friendly
Minecraft YouTube Shorts creator.

You MUST analyze the ENTIRE supplied video context
before making editing decisions.

VIDEO DURATION:
${duration.toFixed(2)} seconds

TRANSCRIPT:
${transcript.text || "(No usable transcript)"}

==================================================
STORY EDITING RULES
==================================================

1. Understand the overall story before cutting.

2. The ending frequently contains the main payoff:
a win, loss, reveal, funny moment, reaction,
unexpected event, challenge result, or punchline.

3. Work backward from that payoff.

4. Keep earlier footage that makes the payoff
understandable, entertaining, or more satisfying.

5. Remove footage that does not contribute:
- long walking
- waiting
- menus
- inventory management
- repetitive gameplay
- unnecessary silence
- failed setup
- unrelated conversation
- dead time

6. Do NOT remove setup necessary for understanding
the story.

7. Keep important dialogue.

8. Do not cut in the middle of an important sentence.

9. Keep funny reactions.

10. Keep surprising moments.

11. Keep enough context so viewers understand
what is happening.

==================================================
MINECRAFT MINIGAME DETECTION
==================================================

Some uploads are Minecraft minigames.

The spoken introduction commonly begins with
the word "Minecraft".

Examples include:
"Minecraft Arrow Toss"
"Minecraft Take It or Leave It"

These are EXAMPLES ONLY.

If the creator says "Minecraft..." and then
introduces a game/challenge, use the actual
spoken introduction and the rest of the video
to understand what the minigame is.

Do NOT assume every video is the same game.

For minigames preserve:
- the challenge
- necessary rules
- important decisions
- meaningful attempts
- funny interactions
- important reactions
- the final result/payoff

==================================================
OPENING HEADER / HOOK
==================================================

Generate ONE short opening header.

The header appears during approximately the
first 3 seconds of the FINAL edited video.

CRITICAL:
The header must match the WHOLE video.

Do not generate the header based only on the
opening.

First understand the entire story and payoff.

The header should:
- be 3-8 words when possible
- be instantly understandable
- create curiosity
- accurately describe/tease the video
- match the actual payoff
- avoid falsely claiming something happened
- avoid unnecessarily spoiling the ending

Examples of STYLE only:

"HE RISKED ALL HIS DIAMONDS 😭"
"CAN I ACTUALLY HIT THIS?!"
"THIS GOT OUT OF CONTROL..."
"THAT WAS NOT THE PLAN 💀"

Do NOT copy these unless they genuinely match
the uploaded video.

==================================================
MEME EDITING
==================================================

You may add 0 to 3 meme-style captions.

Memes are OPTIONAL.

Do not force a meme into the video.

A meme should only be added when it genuinely
matches a funny, awkward, surprising, embarrassing,
unlucky, chaotic, confusing, or dramatic moment.

The meme must make sense based on what actually
happens in the video.

Meme captions should usually be 1-7 words.

Keep them family-friendly.

Do not use sexual, hateful, political,
drug-related, or explicit meme references.

Do not use offensive slurs.

Do not add a meme over important information
the viewer needs to read.

Do not add a meme while the opening hook is
on screen unless it is absolutely necessary.

Prefer meme moments AFTER the opening 3 seconds.

Do not spoil the ending before it happens.

Examples of meme STYLE:

"bro had ONE job 💀"
"well... that happened"
"ain't no way 😭"
"mission failed 💀"
"bro really thought 💀"
"perfectly calculated 😎"
"that was personal 😭"
"famous last words..."
"instant regret 💀"
"task failed successfully"

These are examples of tone only.

Choose wording that actually fits the video.

IMPORTANT:
The meme timestamps you return must refer to
the ORIGINAL uploaded video's timeline.

For each meme return:
- text
- original source timestamp
- duration
- reason

Use approximately 1.0 to 2.5 seconds per meme.

==================================================
FINAL LENGTH
==================================================

Keep the final edit energetic.

Usually aim for approximately 15-45 seconds
when the source material supports it.

Story coherence is more important than forcing
a specific duration.

==================================================
RETURN FORMAT
==================================================

Return ONLY valid JSON.

Do not include Markdown.

Use exactly this structure:

{
  "title": "detected game/video title",
  "clipType": "minigame or gameplay",
  "summary": "one sentence explaining the story",
  "hook": "short accurate opening hook",
  "segments": [
    {
      "start": 0.0,
      "end": 5.5,
      "reason": "why this section matters"
    }
  ],
  "memes": [
    {
      "text": "meme caption",
      "timestamp": 8.4,
      "duration": 1.7,
      "reason": "why the meme fits"
    }
  ]
}

All segment timestamps and meme timestamps MUST
be within 0-${duration.toFixed(2)} seconds.

Segments MUST be chronological.

Segments MUST NOT overlap.

Return 0-3 memes.
`
    }
  ];

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

  if (!Array.isArray(plan.memes)) {
    plan.memes = [];
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
      Math.max(
        0,
        Math.min(duration, start)
      );

    end =
      Math.max(
        0,
        Math.min(duration, end)
      );

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

/*
 * Convert an ORIGINAL video timestamp into
 * a timestamp on the FINAL edited timeline.
 *
 * Example:
 *
 * Original sections kept:
 * 10-15
 * 30-40
 *
 * A meme at original second 34 becomes
 * second 9 of the final video.
 */
function originalTimeToEditedTime(
  timestamp,
  segments
) {
  let editedOffset = 0;

  for (const segment of segments) {
    if (
      timestamp >= segment.start &&
      timestamp <= segment.end
    ) {
      return (
        editedOffset +
        (timestamp - segment.start)
      );
    }

    editedOffset +=
      segment.end - segment.start;
  }

  return null;
}

function normalizeMemes(
  memes,
  segments,
  sourceDuration
) {
  if (!Array.isArray(memes)) {
    return [];
  }

  const result = [];

  for (const meme of memes.slice(0, 3)) {
    const text =
      String(meme.text || "")
        .trim()
        .slice(0, 80);

    let timestamp =
      Number(meme.timestamp);

    let duration =
      Number(meme.duration);

    if (!text) {
      continue;
    }

    if (!Number.isFinite(timestamp)) {
      continue;
    }

    if (
      timestamp < 0 ||
      timestamp > sourceDuration
    ) {
      continue;
    }

    if (!Number.isFinite(duration)) {
      duration = 1.5;
    }

    duration =
      Math.max(
        1,
        Math.min(2.5, duration)
      );

    const editedTimestamp =
      originalTimeToEditedTime(
        timestamp,
        segments
      );

    /*
     * If AI picked a moment that got removed
     * from the final edit, don't show the meme.
     */
    if (editedTimestamp === null) {
      continue;
    }

    /*
     * Keep memes away from the opening hook.
     */
    if (editedTimestamp < 3.2) {
      continue;
    }

    result.push({
      text,
      originalTimestamp: timestamp,
      timestamp: editedTimestamp,
      duration,
      reason:
        String(meme.reason || "")
    });
  }

  return result.slice(0, 3);
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
       * Fill the ENTIRE vertical Short.
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
    path.join(
      directory,
      "story.mp4"
    );

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

/*
 * Writing text to temporary files is much
 * safer than trying to escape every possible
 * punctuation mark directly inside FFmpeg's
 * drawtext=text= option.
 */
function writeTextFile(
  directory,
  filename,
  text
) {
  const file =
    path.join(directory, filename);

  fs.writeFileSync(
    file,
    String(text || ""),
    "utf8"
  );

  return file;
}

function ffmpegPath(file) {
  return file
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

async function addHookMemesAndMusic({
  video,
  music,
  hook,
  memes,
  directory,
  output
}) {
  const info =
    await ffprobe(video);

  const duration =
    getDuration(info);

  const hookFile =
    writeTextFile(
      directory,
      "hook.txt",
      (hook || "WAIT FOR THE END 👀")
        .toUpperCase()
    );

  const videoFilters = [];

  /*
   * OPENING HOOK
   *
   * Top portion of screen so it doesn't
   * completely block the Minecraft action.
   */
  videoFilters.push(
    `drawtext=` +
    `textfile='${ffmpegPath(hookFile)}':` +
    `fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:` +
    `fontcolor=white:` +
    `fontsize=62:` +
    `borderw=7:` +
    `bordercolor=black:` +
    `x=(w-text_w)/2:` +
    `y=170:` +
    `enable='between(t,0,3)'`
  );

  /*
   * MEME CAPTIONS
   *
   * Each meme gets its own text file and
   * appears at the AI-selected moment.
   */
  memes.forEach((meme, index) => {
    const memeFile =
      writeTextFile(
        directory,
        `meme-${index}.txt`,
        meme.text
      );

    const start =
      Math.max(0, meme.timestamp);

    const end =
      Math.min(
        duration,
        start + meme.duration
      );

    videoFilters.push(
      `drawtext=` +
      `textfile='${ffmpegPath(memeFile)}':` +
      `fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:` +
      `fontcolor=white:` +
      `fontsize=56:` +
      `borderw=7:` +
      `bordercolor=black:` +
      `x=(w-text_w)/2:` +
      `y=h*0.68:` +
      `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`
    );
  });

  const videoChain =
    videoFilters.join(",");

  /*
   * Music is intentionally quiet.
   * Original gameplay/voice should dominate.
   */
  const filter = [
    `[1:a]` +
      `volume=0.12,` +
      `atrim=0:${duration},` +
      `asetpts=N/SR/TB` +
      `[music]`,

    /*
     * Duck music whenever the original audio
     * gets louder.
     */
    `[music][0:a]` +
      `sidechaincompress=` +
      `threshold=0.025:` +
      `ratio=8:` +
      `attack=20:` +
      `release=350` +
      `[ducked]`,

    /*
     * Original audio remains dominant.
     */
    `[0:a][ducked]` +
      `amix=` +
      `inputs=2:` +
      `duration=first:` +
      `normalize=0` +
      `[aout]`,

    `[0:v]${videoChain}[vout]`
  ].join(";");

  await run("ffmpeg", [
    "-y",

    "-i",
    video,

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
}

app.get(
  "/api/health",
  async (req, res) => {
    try {
      const ffmpeg =
        await run(
          "ffmpeg",
          ["-version"]
        );

      res.json({
        ok: true,

        ffmpeg:
          ffmpeg.split("\n")[0],

        ai:
          Boolean(
            process.env.OPENAI_API_KEY
          ),

        version:
          "2.1-meme-editor"
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);

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
      path.join(
        WORK_DIR,
        job
      );

    fs.mkdirSync(
      directory,
      {
        recursive: true
      }
    );

    const video =
      req.files?.video?.[0]?.path;

    const music =
      req.files?.music?.[0]?.path;

    if (!video || !music) {
      safeDelete(video);
      safeDelete(music);
      safeDelete(directory);

      return res
        .status(400)
        .json({
          error:
            "Please upload both a video and background music."
        });
    }

    try {
      console.log(
        `[${job}] Starting full AI analysis`
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
        `[${job}] Source: ` +
        `${dimensions.width}x${dimensions.height}`
      );

      console.log(
        `[${job}] Duration: ${duration}s`
      );

      /*
       * =====================================
       * SPEECH ANALYSIS
       * =====================================
       */

      let transcript = {
        text: "",
        segments: []
      };

      if (hasAudio(info)) {
        const audio =
          path.join(
            directory,
            "speech.mp3"
          );

        try {
          await extractAudio(
            video,
            audio
          );

          transcript =
            await transcribeAudio(
              audio
            );

          console.log(
            `[${job}] Transcript created`
          );
        } catch (error) {
          console.error(
            `[${job}] Transcription failed:`,
            error.message
          );
        }
      }

      /*
       * =====================================
       * WHOLE-VIDEO VISUAL ANALYSIS
       * =====================================
       */

      const frames =
        await extractAnalysisFrames(
          video,
          duration,
          directory
        );

      console.log(
        `[${job}] Extracted ${frames.length} analysis frames`
      );

      /*
       * =====================================
       * STORY + HOOK + MEME DECISIONS
       * =====================================
       */

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
          `[${job}] AI analysis failed:`,
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

      /*
       * Convert meme times from the ORIGINAL
       * clip to the FINAL edited timeline.
       */
      const memes =
        normalizeMemes(
          plan.memes,
          segments,
          duration
        );

      console.log(
        `[${job}] Detected type:`,
        plan.clipType
      );

      console.log(
        `[${job}] Title:`,
        plan.title
      );

      console.log(
        `[${job}] Hook:`,
        plan.hook
      );

      console.log(
        `[${job}] Segments:`,
        segments
      );

      console.log(
        `[${job}] Meme edits:`,
        memes
      );

      /*
       * =====================================
       * CUT VIDEO + 9:16
       * =====================================
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
       * =====================================
       * HEADER + MEMES + MUSIC
       * =====================================
       */

      const filename =
        `${job}.mp4`;

      const output =
        path.join(
          EXPORT_DIR,
          filename
        );

      await addHookMemesAndMusic({
        video: story,
        music,
        hook: plan.hook,
        memes,
        directory,
        output
      });

      /*
       * =====================================
       * FINISHED
       * =====================================
       */

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

          segments,

          memes
        }
      });

    } catch (error) {
      console.error(
        `[${job}] Editing failed:`,
        error
      );

      res
        .status(500)
        .json({
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

app.listen(
  PORT,
  "0.0.0.0",
  () => {
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

    console.log(
      "Meme editor: enabled"
    );
  }
);
