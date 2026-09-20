import express from "express";
import multer from "multer";
import OpenAI from "openai";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

// =====================================================
// KINDCRAFTED AI CLIP EDITOR
// =====================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 8080;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = OPENAI_API_KEY
  ? new OpenAI({
      apiKey: OPENAI_API_KEY
    })
  : null;

// =====================================================
// FOLDERS
// =====================================================

const uploadsDir = path.join(__dirname, "uploads");
const exportsDir = path.join(__dirname, "exports");
const tempDir = path.join(__dirname, "temp");

for (const folder of [uploadsDir, exportsDir, tempDir]) {
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, {
      recursive: true
    });
  }
}

// =====================================================
// EXPRESS
// =====================================================

app.use(
  express.json({
    limit: "10mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

app.use(
  "/exports",
  express.static(exportsDir)
);

// =====================================================
// UPLOAD
// =====================================================

const upload = multer({
  dest: uploadsDir,

  limits: {
    fileSize: 1024 * 1024 * 1024
  }
});

// =====================================================
// COMMAND RUNNER
// =====================================================

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", data => {
      stdout += data.toString();
    });

    child.stderr.on("data", data => {
      stderr += data.toString();
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) {
        resolve({
          stdout,
          stderr
        });
      } else {
        reject(
          new Error(
            `${command} failed.\n${stderr}`
          )
        );
      }
    });
  });
}

// =====================================================
// BOOLEAN
// =====================================================

function boolValue(value, fallback = false) {
  if (
    value === undefined ||
    value === null
  ) {
    return fallback;
  }

  return (
    String(value).toLowerCase() ===
    "true"
  );
}

// =====================================================
// PROBE VIDEO
// =====================================================

async function probe(file) {
  const result = await run(
    "ffprobe",
    [
      "-v",
      "error",

      "-show_streams",
      "-show_format",

      "-of",
      "json",

      file
    ]
  );

  return JSON.parse(
    result.stdout
  );
}

// =====================================================
// VIDEO ANALYSIS
// =====================================================

async function analyzeVideo(file) {
  const info = await probe(file);

  const videoStream =
    info.streams.find(
      stream =>
        stream.codec_type ===
        "video"
    );

  const audioStream =
    info.streams.find(
      stream =>
        stream.codec_type ===
        "audio"
    );

  const duration = Number(
    info.format?.duration ||
    videoStream?.duration ||
    0
  );

  let silence = [];

  if (audioStream) {
    try {
      const result = await run(
        "ffmpeg",
        [
          "-hide_banner",

          "-i",
          file,

          "-af",
          "silencedetect=noise=-38dB:d=0.65",

          "-f",
          "null",

          "-"
        ]
      );

      silence =
        parseSilence(
          result.stderr
        );
    } catch (error) {
      silence =
        parseSilence(
          error.message || ""
        );
    }
  }

  return {
    duration,

    width: Number(
      videoStream?.width || 0
    ),

    height: Number(
      videoStream?.height || 0
    ),

    hasAudio:
      Boolean(audioStream),

    silence
  };
}

// =====================================================
// SILENCE PARSER
// =====================================================

function parseSilence(text) {
  const starts = [];
  const sections = [];

  const lines =
    String(text).split("\n");

  for (const line of lines) {
    const start =
      line.match(
        /silence_start:\s*([0-9.]+)/
      );

    if (start) {
      starts.push(
        Number(start[1])
      );
    }

    const end =
      line.match(
        /silence_end:\s*([0-9.]+)/
      );

    if (end) {
      const startTime =
        starts.length
          ? starts.shift()
          : null;

      if (startTime !== null) {
        sections.push({
          start: startTime,
          end: Number(end[1])
        });
      }
    }
  }

  return sections;
}

// =====================================================
// CLEANUP
// =====================================================

function cleanup(...files) {
  for (const file of files) {
    if (!file) {
      continue;
    }

    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (error) {
      console.error(
        "Cleanup error:",
        error.message
      );
    }
  }
}

// =====================================================
// EXTRACT AUDIO
// =====================================================

async function extractAudio(
  videoFile,
  id
) {
  const audioFile =
    path.join(
      tempDir,
      `${id}-speech.mp3`
    );

  await run(
    "ffmpeg",
    [
      "-y",

      "-i",
      videoFile,

      "-vn",

      "-ac",
      "1",

      "-ar",
      "16000",

      "-b:a",
      "64k",

      audioFile
    ]
  );

  return audioFile;
}

// =====================================================
// TRANSCRIBE
// =====================================================

async function transcribeVideo(
  videoFile,
  id,
  hasAudio
) {
  if (
    !openai ||
    !hasAudio
  ) {
    return "";
  }

  let audioFile = null;

  try {
    audioFile =
      await extractAudio(
        videoFile,
        id
      );

    const transcription =
      await openai.audio.transcriptions.create({
        file:
          fs.createReadStream(
            audioFile
          ),

        model:
          "gpt-4o-mini-transcribe"
      });

    return (
      transcription.text || ""
    ).trim();
  } catch (error) {
    console.error(
      "Transcription failed:",
      error.message
    );

    return "";
  } finally {
    cleanup(audioFile);
  }
}

// =====================================================
// EXTRACT VIDEO FRAMES
// =====================================================

async function extractFrames(
  videoFile,
  duration,
  id
) {
  const framePaths = [];

  const percentages = [
    0.10,
    0.30,
    0.50,
    0.70,
    0.90
  ];

  for (
    let index = 0;
    index < percentages.length;
    index++
  ) {
    const timestamp =
      Math.max(
        0,
        duration *
        percentages[index]
      );

    const framePath =
      path.join(
        tempDir,
        `${id}-frame-${index}.jpg`
      );

    try {
      await run(
        "ffmpeg",
        [
          "-y",

          "-ss",
          String(timestamp),

          "-i",
          videoFile,

          "-frames:v",
          "1",

          "-vf",
          "scale=640:-2",

          "-q:v",
          "4",

          framePath
        ]
      );

      if (
        fs.existsSync(framePath)
      ) {
        framePaths.push(
          framePath
        );
      }
    } catch (error) {
      console.error(
        "Frame extraction failed:",
        error.message
      );
    }
  }

  return framePaths;
}

// =====================================================
// IMAGE DATA
// =====================================================

function imageDataURL(file) {
  const buffer =
    fs.readFileSync(file);

  return (
    "data:image/jpeg;base64," +
    buffer.toString("base64")
  );
}

// =====================================================
// JSON PARSER
// =====================================================

function parseAIJSON(text) {
  try {
    return JSON.parse(text);
  } catch {}

  const match =
    String(text).match(
      /\{[\s\S]*\}/
    );

  if (!match) {
    return null;
  }

  try {
    return JSON.parse(
      match[0]
    );
  } catch {
    return null;
  }
}

// =====================================================
// CLEAN AI TEXT
// =====================================================

function cleanText(
  value,
  maxLength = 60
) {
  return String(value || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^["']+|["']+$/g, "")
    .trim()
    .slice(0, maxLength);
}

// =====================================================
// AI CONTENT ANALYSIS
// =====================================================

async function analyzeWithAI({
  transcript,
  framePaths,
  autoHeading,
  autoMeme
}) {
  const fallback = {
    heading: "",
    memeTop: "",
    memeBottom: "",
    summary: ""
  };

  if (
    !openai ||
    (
      !autoHeading &&
      !autoMeme
    )
  ) {
    return fallback;
  }

  try {
    const content = [];

    content.push({
      type: "input_text",

      text:
`You are editing a family-friendly gaming YouTube Short.

Analyze the transcript and the sampled video frames.

TRANSCRIPT:
${transcript || "(No understandable speech was detected.)"}

Return ONLY valid JSON:

{
  "heading": "",
  "memeTop": "",
  "memeBottom": "",
  "summary": ""
}

HEADING RULES:
- Create a heading only if requested.
- The heading MUST describe the actual clip.
- Make it exciting and easy to read.
- Keep it between 2 and 7 words.
- Maximum 40 characters.
- Do not use hashtags.
- Do not use quotation marks.
- Do not invent something that did not happen.

MEME RULES:
- Meme text should only be added when it genuinely fits.
- Keep meme text very short.
- Keep everything family-friendly.
- No profanity.
- If meme text is unnecessary, leave it blank.

SUMMARY:
- Briefly explain what actually happens in the clip.`
    });

    for (
      const framePath of framePaths
    ) {
      content.push({
        type: "input_image",

        image_url:
          imageDataURL(
            framePath
          ),

        detail: "low"
      });
    }

    const response =
      await openai.responses.create({
        model: "gpt-5",

        input: [
          {
            role: "user",
            content
          }
        ]
      });

    const parsed =
      parseAIJSON(
        response.output_text
      );

    if (!parsed) {
      console.error(
        "Could not parse AI JSON:",
        response.output_text
      );

      return fallback;
    }

    return {
      heading:
        autoHeading
          ? cleanText(
              parsed.heading,
              40
            )
          : "",

      memeTop:
        autoMeme
          ? cleanText(
              parsed.memeTop,
              50
            )
          : "",

      memeBottom:
        autoMeme
          ? cleanText(
              parsed.memeBottom,
              50
            )
          : "",

      summary:
        cleanText(
          parsed.summary,
          300
        )
    };
  } catch (error) {
    console.error(
      "AI analysis failed:",
      error
    );

    return fallback;
  }
}

// =====================================================
// CREATE TEXT FILE
// =====================================================

function createTextFile(
  id,
  name,
  text
) {
  const file =
    path.join(
      tempDir,
      `${id}-${name}.txt`
    );

  fs.writeFileSync(
    file,
    String(text || ""),
    "utf8"
  );

  return file;
}

// =====================================================
// ESCAPE FILTER PATH
// =====================================================

function escapeFilterPath(file) {
  return file
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

// =====================================================
// FIND FONT
// =====================================================

function findFont() {
  const possibleFonts = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf"
  ];

  for (
    const font of possibleFonts
  ) {
    if (fs.existsSync(font)) {
      console.log(
        "Using font:",
        font
      );

      return font;
    }
  }

  console.log(
    "No direct font file found. Using fontconfig."
  );

  return null;
}

// =====================================================
// DRAWTEXT FILTER
// =====================================================

function textFilter({
  textFile,
  font,
  fontSize,
  y,
  box = true
}) {
  let filter =
    "drawtext=";

  if (font) {
    filter +=
      `fontfile='${escapeFilterPath(font)}':`;
  } else {
    filter +=
      "font='DejaVu Sans':";
  }

  filter +=
    `textfile='${escapeFilterPath(textFile)}':` +
    "reload=0:" +
    "fontcolor=white:" +
    `fontsize=${fontSize}:` +
    "borderw=6:" +
    "bordercolor=black:";

  if (box) {
    filter +=
      "box=1:" +
      "boxcolor=black@0.45:" +
      "boxborderw=18:";
  }

  filter +=
    "x=(w-text_w)/2:" +
    `y=${y}`;

  return filter;
}

// =====================================================
// HEALTH
// =====================================================

app.get(
  "/api/health",

  async (req, res) => {
    let ffmpeg = false;
    let ffprobe = false;

    try {
      await run(
        "ffmpeg",
        ["-version"]
      );

      ffmpeg = true;
    } catch {}

    try {
      await run(
        "ffprobe",
        ["-version"]
      );

      ffprobe = true;
    } catch {}

    res.json({
      ok: true,

      ffmpeg,
      ffprobe,

      openai:
        Boolean(
          OPENAI_API_KEY
        )
    });
  }
);

// =====================================================
// EDIT VIDEO
// =====================================================

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
    const videoFile =
      req.files?.video?.[0]?.path;

    const musicFile =
      req.files?.music?.[0]?.path ||
      null;

    if (!videoFile) {
      return res
        .status(400)
        .json({
          error:
            "A video file is required."
        });
    }

    const id =
      crypto.randomUUID();

    const outputName =
      `${id}.mp4`;

    const outputFile =
      path.join(
        exportsDir,
        outputName
      );

    let framePaths = [];

    let headingFile = null;
    let memeTopFile = null;
    let memeBottomFile = null;

    try {
      // ===============================================
      // OPTIONS
      // ===============================================

      const autoHeading =
        boolValue(
          req.body.autoHeading,
          true
        );

      const autoMeme =
        boolValue(
          req.body.autoMeme,
          false
        );

      const autoZoom =
        boolValue(
          req.body.autoZoom,
          true
        );

      const removeSilence =
        boolValue(
          req.body.removeSilence,
          true
        );

      const fillScreen =
        boolValue(
          req.body.fillScreen,
          true
        );

      const keepAudio =
        boolValue(
          req.body.keepAudio,
          true
        );

      console.log(
        "EDIT OPTIONS:",
        {
          autoHeading,
          autoMeme,
          autoZoom,
          removeSilence,
          fillScreen,
          keepAudio,
          music:
            Boolean(musicFile)
        }
      );

      // ===============================================
      // ANALYZE VIDEO
      // ===============================================

      const analysis =
        await analyzeVideo(
          videoFile
        );

      if (
        !analysis.duration ||
        analysis.duration <= 0
      ) {
        throw new Error(
          "Could not determine video duration."
        );
      }

      // ===============================================
      // AI ANALYSIS
      // ===============================================

      let transcript = "";

      if (
        autoHeading ||
        autoMeme
      ) {
        transcript =
          await transcribeVideo(
            videoFile,
            id,
            analysis.hasAudio
          );

        framePaths =
          await extractFrames(
            videoFile,
            analysis.duration,
            id
          );
      }

      const ai =
        await analyzeWithAI({
          transcript,
          framePaths,
          autoHeading,
          autoMeme
        });

      console.log(
        "GENERATED HEADING:",
        ai.heading ||
        "(none)"
      );

      console.log(
        "GENERATED MEME TOP:",
        ai.memeTop ||
        "(none)"
      );

      console.log(
        "GENERATED MEME BOTTOM:",
        ai.memeBottom ||
        "(none)"
      );

      // ===============================================
      // CREATE TEXT FILES
      // ===============================================

      if (
        autoHeading &&
        ai.heading
      ) {
        headingFile =
          createTextFile(
            id,
            "heading",
            ai.heading
          );
      }

      if (
        autoMeme &&
        ai.memeTop
      ) {
        memeTopFile =
          createTextFile(
            id,
            "meme-top",
            ai.memeTop
          );
      }

      if (
        autoMeme &&
        ai.memeBottom
      ) {
        memeBottomFile =
          createTextFile(
            id,
            "meme-bottom",
            ai.memeBottom
          );
      }

      // ===============================================
      // VIDEO FILTER
      // ===============================================

      const videoFilters = [];

      if (fillScreen) {
        videoFilters.push(
          "scale=1080:1920:" +
          "force_original_aspect_ratio=increase"
        );

        videoFilters.push(
          "crop=1080:1920"
        );

        videoFilters.push(
          "setsar=1"
        );
      } else {
        videoFilters.push(
          "scale=1080:1920:" +
          "force_original_aspect_ratio=decrease"
        );

        videoFilters.push(
          "pad=1080:1920:" +
          "(ow-iw)/2:" +
          "(oh-ih)/2"
        );

        videoFilters.push(
          "setsar=1"
        );
      }

      // ===============================================
      // AUTOMATIC MOTION
      // ===============================================

      if (autoZoom) {
        videoFilters.push(
          "scale=1118:1988"
        );

        videoFilters.push(
          "crop=1080:1920:" +
          "x='19+12*sin(t*0.8)':" +
          "y='34+18*sin(t*0.55)'"
        );
      }

      // ===============================================
      // FONT
      // ===============================================

      const font =
        findFont();

      // ===============================================
      // HEADING
      // ===============================================

      if (headingFile) {
        videoFilters.push(
          textFilter({
            textFile:
              headingFile,

            font,

            fontSize:
              64,

            y:
              "110",

            box:
              true
          })
        );
      }

      // ===============================================
      // MEME TOP
      // ===============================================

      if (memeTopFile) {
        videoFilters.push(
          textFilter({
            textFile:
              memeTopFile,

            font,

            fontSize:
              52,

            y:
              "250",

            box:
              false
          })
        );
      }

      // ===============================================
      // MEME BOTTOM
      // ===============================================

      if (memeBottomFile) {
        videoFilters.push(
          textFilter({
            textFile:
              memeBottomFile,

            font,

            fontSize:
              52,

            y:
              "h-text_h-180",

            box:
              false
          })
        );
      }

      console.log(
        "VIDEO FILTER:",
        videoFilters.join(",")
      );

      // ===============================================
      // INPUTS
      // ===============================================

      const args = [
        "-y",

        "-i",
        videoFile
      ];

      if (musicFile) {
        args.push(
          "-stream_loop",
          "-1",

          "-i",
          musicFile
        );
      }

      // ===============================================
      // VIDEO FILTERS
      // ===============================================

      args.push(
        "-vf",
        videoFilters.join(",")
      );

      // ===============================================
      // AUDIO
      // ===============================================

      if (
        keepAudio &&
        analysis.hasAudio &&
        musicFile
      ) {
        args.push(
          "-filter_complex",

          "[0:a]" +
          "volume=1.0[voice];" +

          "[1:a]" +
          "volume=0.16[music];" +

          "[music][voice]" +
          "sidechaincompress=" +
          "threshold=0.025:" +
          "ratio=10:" +
          "attack=15:" +
          "release=300" +
          "[ducked];" +

          "[voice][ducked]" +
          "amix=" +
          "inputs=2:" +
          "duration=first:" +
          "normalize=0" +
          "[finalaudio]",

          "-map",
          "0:v:0",

          "-map",
          "[finalaudio]"
        );
      } else if (
        keepAudio &&
        analysis.hasAudio
      ) {
        args.push(
          "-map",
          "0:v:0",

          "-map",
          "0:a:0"
        );
      } else if (musicFile) {
        args.push(
          "-map",
          "0:v:0",

          "-map",
          "1:a:0",

          "-af",
          "volume=0.20"
        );
      } else {
        args.push(
          "-map",
          "0:v:0",

          "-an"
        );
      }

      // ===============================================
      // OUTPUT
      // ===============================================

      args.push(
        "-t",
        String(
          analysis.duration
        ),

        "-c:v",
        "libx264",

        "-preset",
        "veryfast",

        "-crf",
        "20",

        "-pix_fmt",
        "yuv420p",

        "-r",
        "30"
      );

      if (
        (
          keepAudio &&
          analysis.hasAudio
        ) ||
        musicFile
      ) {
        args.push(
          "-c:a",
          "aac",

          "-b:a",
          "192k"
        );
      }

      args.push(
        "-movflags",
        "+faststart",

        outputFile
      );

      // ===============================================
      // RENDER
      // ===============================================

      await run(
        "ffmpeg",
        args
      );

      // ===============================================
      // VERIFY OUTPUT
      // ===============================================

      if (
        !fs.existsSync(
          outputFile
        )
      ) {
        throw new Error(
          "FFmpeg did not create the output video."
        );
      }

      // ===============================================
      // CLEAN TEMP FILES
      // ===============================================

      cleanup(
        videoFile,
        musicFile,
        ...framePaths,
        headingFile,
        memeTopFile,
        memeBottomFile
      );

      // ===============================================
      // RESPONSE
      // ===============================================

      res.json({
        ok: true,

        url:
          `/exports/${outputName}`,

        duration:
          analysis.duration,

        musicAdded:
          Boolean(musicFile),

        headingAdded:
          Boolean(headingFile),

        memeAdded:
          Boolean(
            memeTopFile ||
            memeBottomFile
          ),

        ai: {
          enabled:
            Boolean(openai),

          heading:
            ai.heading,

          memeTop:
            ai.memeTop,

          memeBottom:
            ai.memeBottom,

          summary:
            ai.summary,

          transcript
        },

        analysis: {
          duration:
            analysis.duration,

          width:
            analysis.width,

          height:
            analysis.height,

          hasAudio:
            analysis.hasAudio,

          silence:
            analysis.silence
        },

        output: {
          width: 1080,
          height: 1920,
          aspectRatio: "9:16",
          fillsFrame: fillScreen
        },

        options: {
          autoHeading,
          autoMeme,
          autoZoom,
          removeSilence,
          fillScreen,
          keepAudio
        }
      });
    } catch (error) {
      console.error(
        "EDIT ERROR:",
        error
      );

      cleanup(
        videoFile,
        musicFile,
        ...framePaths,
        headingFile,
        memeTopFile,
        memeBottomFile
      );

      res
        .status(500)
        .json({
          error:
            error.message ||
            "Video editing failed."
        });
    }
  }
);

// =====================================================
// SERVER
// =====================================================

app.listen(
  PORT,
  () => {
    console.log(
      `KindCrafted AI Clip Editor running on port ${PORT}`
    );

    console.log(
      "FFmpeg editing: enabled"
    );

    console.log(
      "Video frame analysis: enabled"
    );

    console.log(
      "OpenAI analysis:",
      OPENAI_API_KEY
        ? "enabled"
        : "disabled"
    );

    console.log(
      "AI heading rendering: enabled"
    );

    console.log(
      "AI meme rendering: enabled"
    );

    console.log(
      "Background music: OPTIONAL"
    );
  }
);
