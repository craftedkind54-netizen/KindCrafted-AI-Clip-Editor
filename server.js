import express from "express";
import multer from "multer";
import OpenAI from "openai";

import {
  spawn
} from "node:child_process";

import fs from "node:fs";
import path from "node:path";

import {
  fileURLToPath
} from "node:url";

import crypto from "node:crypto";


// =====================================================
// KINDCRAFTED AI CLIP EDITOR
// =====================================================

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);


const app =
  express();

const PORT =
  Number(process.env.PORT) ||
  8080;


const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY;


const openai =
  OPENAI_API_KEY
    ? new OpenAI({
        apiKey:
          OPENAI_API_KEY
      })
    : null;


// =====================================================
// FOLDERS
// =====================================================

const uploadsDir =
  path.join(
    __dirname,
    "uploads"
  );

const exportsDir =
  path.join(
    __dirname,
    "exports"
  );

const tempDir =
  path.join(
    __dirname,
    "temp"
  );


for (
  const folder of [
    uploadsDir,
    exportsDir,
    tempDir
  ]
) {

  if (
    !fs.existsSync(folder)
  ) {

    fs.mkdirSync(
      folder,
      {
        recursive: true
      }
    );

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
    path.join(
      __dirname,
      "public"
    )
  )
);

app.use(
  "/exports",
  express.static(
    exportsDir
  )
);


// =====================================================
// UPLOAD
// =====================================================

const upload =
  multer({

    dest:
      uploadsDir,

    limits: {
      fileSize:
        1024 *
        1024 *
        1024
    }

  });


// =====================================================
// COMMAND RUNNER
// =====================================================

function run(
  command,
  args
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      const child =
        spawn(
          command,
          args
        );


      let stdout = "";
      let stderr = "";


      child.stdout.on(
        "data",
        data => {

          stdout +=
            data.toString();

        }
      );


      child.stderr.on(
        "data",
        data => {

          stderr +=
            data.toString();

        }
      );


      child.on(
        "error",
        reject
      );


      child.on(
        "close",
        code => {

          if (
            code === 0
          ) {

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

        }
      );

    }
  );

}


// =====================================================
// BOOLEAN
// =====================================================

function boolValue(
  value,
  fallback = false
) {

  if (
    value === undefined ||
    value === null
  ) {

    return fallback;

  }


  return (
    String(value)
      .toLowerCase() ===
    "true"
  );

}


// =====================================================
// PROBE VIDEO
// =====================================================

async function probe(
  file
) {

  const result =
    await run(
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

async function analyzeVideo(
  file
) {

  const info =
    await probe(file);


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


  const duration =
    Number(
      info.format?.duration ||
      videoStream?.duration ||
      0
    );


  let silence = [];


  if (audioStream) {

    try {

      const result =
        await run(
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

    width:
      Number(
        videoStream?.width ||
        0
      ),

    height:
      Number(
        videoStream?.height ||
        0
      ),

    hasAudio:
      Boolean(
        audioStream
      ),

    silence

  };

}


// =====================================================
// SILENCE PARSER
// =====================================================

function parseSilence(
  text
) {

  const starts = [];
  const sections = [];


  const lines =
    String(text)
      .split("\n");


  for (
    const line of lines
  ) {

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


      if (
        startTime !== null
      ) {

        sections.push({

          start:
            startTime,

          end:
            Number(
              end[1]
            )

        });

      }

    }

  }


  return sections;

}


// =====================================================
// CLEANUP
// =====================================================

function cleanup(
  ...files
) {

  for (
    const file of files
  ) {

    if (!file) {
      continue;
    }


    try {

      if (
        fs.existsSync(file)
      ) {

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
      transcription.text ||
      ""
    ).trim();

  } catch (error) {

    console.error(
      "Transcription failed:",
      error.message
    );


    return "";

  } finally {

    cleanup(
      audioFile
    );

  }

}


// =====================================================
// SAMPLE VIDEO FRAMES
// =====================================================

async function extractFrames(
  videoFile,
  duration,
  id
) {

  const framePaths = [];


  const percentages =
    [
      0.10,
      0.30,
      0.50,
      0.70,
      0.90
    ];


  for (
    let index = 0;
    index <
    percentages.length;
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
        fs.existsSync(
          framePath
        )
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
// IMAGE TO DATA URL
// =====================================================

function imageDataURL(
  file
) {

  const buffer =
    fs.readFileSync(file);


  return (
    "data:image/jpeg;base64," +
    buffer.toString(
      "base64"
    )
  );

}


// =====================================================
// SAFE JSON PARSER
// =====================================================

function parseAIJSON(
  text
) {

  try {

    return JSON.parse(
      text
    );

  } catch {}


  const match =
    String(text)
      .match(
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

      type:
        "input_text",

      text:
`You are editing a family-friendly gaming YouTube Short.

Analyze the transcript and sampled video frames.

TRANSCRIPT:
${transcript || "(No understandable speech was detected.)"}

Return ONLY valid JSON in this exact format:

{
  "heading": "",
  "memeTop": "",
  "memeBottom": "",
  "summary": ""
}

Rules:

- Heading must be short and exciting.
- Heading should describe what actually happens.
- Do not invent events.
- Maximum heading length: 45 characters.
- Meme text should only be used when it genuinely fits.
- Meme text should be very short.
- Keep everything family-friendly.
- Do not use profanity.
- Do not use hashtags.
- Do not use quotation marks around the text.
- If meme text is unnecessary, leave memeTop and memeBottom empty.
- summary should briefly explain what happens in the clip.`

    });


    for (
      const framePath
      of framePaths
    ) {

      content.push({

        type:
          "input_image",

        image_url:
          imageDataURL(
            framePath
          ),

        detail:
          "low"

      });

    }


    const response =
      await openai.responses.create({

        model:
          "gpt-5",

        input: [
          {
            role:
              "user",

            content
          }
        ]

      });


    const parsed =
      parseAIJSON(
        response.output_text
      );


    if (!parsed) {

      return fallback;

    }


    return {

      heading:
        autoHeading
          ? String(
              parsed.heading ||
              ""
            ).trim()
          : "",

      memeTop:
        autoMeme
          ? String(
              parsed.memeTop ||
              ""
            ).trim()
          : "",

      memeBottom:
        autoMeme
          ? String(
              parsed.memeBottom ||
              ""
            ).trim()
          : "",

      summary:
        String(
          parsed.summary ||
          ""
        ).trim()

    };

  } catch (error) {

    console.error(
      "AI analysis failed:",
      error.message
    );


    return fallback;

  }

}


// =====================================================
// ESCAPE DRAWTEXT
// =====================================================

function escapeDrawText(
  value
) {

  return String(
    value || ""
  )
    .replace(
      /\\/g,
      "\\\\"
    )
    .replace(
      /:/g,
      "\\:"
    )
    .replace(
      /'/g,
      "\\'"
    )
    .replace(
      /%/g,
      "\\%"
    )
    .replace(
      /\n/g,
      " "
    );

}


// =====================================================
// SILENCE REMOVAL FILTER
// =====================================================

function buildKeepSections(
  duration,
  silence
) {

  if (
    !duration ||
    !silence.length
  ) {

    return [
      {
        start: 0,
        end: duration
      }
    ];

  }


  const sections = [];

  let cursor = 0;


  for (
    const item of silence
  ) {

    // Leave a tiny natural pause.

    const cutStart =
      Math.max(
        cursor,
        item.start + 0.08
      );


    const cutEnd =
      Math.min(
        duration,
        item.end - 0.08
      );


    if (
      cutStart >
      cursor + 0.05
    ) {

      sections.push({

        start:
          cursor,

        end:
          cutStart

      });

    }


    cursor =
      Math.max(
        cursor,
        cutEnd
      );

  }


  if (
    cursor <
    duration
  ) {

    sections.push({

      start:
        cursor,

      end:
        duration

    });

  }


  return sections.filter(
    section =>
      section.end -
      section.start >
      0.05
  );

}


// =====================================================
// HEALTH
// =====================================================

app.get(
  "/api/health",

  async (
    req,
    res
  ) => {

    let ffmpeg = false;
    let ffprobe = false;


    try {

      await run(
        "ffmpeg",
        [
          "-version"
        ]
      );

      ffmpeg = true;

    } catch {}


    try {

      await run(
        "ffprobe",
        [
          "-version"
        ]
      );

      ffprobe = true;

    } catch {}


    res.json({

      ok:
        true,

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
      name:
        "video",

      maxCount:
        1
    },
    {
      name:
        "music",

      maxCount:
        1
    }
  ]),

  async (
    req,
    res
  ) => {

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


    try {

      // =================================================
      // USER OPTIONS
      // =================================================

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


      // =================================================
      // TECHNICAL ANALYSIS
      // =================================================

      const analysis =
        await analyzeVideo(
          videoFile
        );


      if (
        !analysis.duration ||
        analysis.duration <= 0
      ) {

        throw new Error(
          "Could not determine the video duration."
        );

      }


      // =================================================
      // AI ANALYSIS
      // =================================================

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
        "AI analysis:",
        ai
      );


      // =================================================
      // BASE VIDEO FILTER
      // =================================================

      let baseVideo;


      if (fillScreen) {

        baseVideo =
          "scale=1080:1920:" +
          "force_original_aspect_ratio=increase," +
          "crop=1080:1920," +
          "setsar=1";

      } else {

        baseVideo =
          "scale=1080:1920:" +
          "force_original_aspect_ratio=decrease," +
          "pad=1080:1920:" +
          "(ow-iw)/2:" +
          "(oh-ih)/2," +
          "setsar=1";

      }


      // =================================================
      // AUTOMATIC MOTION
      // =================================================

      if (autoZoom) {

        baseVideo +=
          ",scale=1118:1987," +
          "crop=1080:1920:" +
          "x='19+12*sin(t*0.8)':" +
          "y='33+18*sin(t*0.55)'";

      }


      // =================================================
      // TEXT
      // =================================================

      const videoFilters =
        [
          baseVideo
        ];


      const font =
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";


      if (
        ai.heading
      ) {

        videoFilters.push(
          "drawtext=" +
          `fontfile='${font}':` +
          `text='${escapeDrawText(ai.heading)}':` +
          "fontcolor=white:" +
          "fontsize=62:" +
          "borderw=5:" +
          "bordercolor=black:" +
          "x=(w-text_w)/2:" +
          "y=90"
        );

      }


      if (
        ai.memeTop
      ) {

        videoFilters.push(
          "drawtext=" +
          `fontfile='${font}':` +
          `text='${escapeDrawText(ai.memeTop)}':` +
          "fontcolor=white:" +
          "fontsize=54:" +
          "borderw=5:" +
          "bordercolor=black:" +
          "x=(w-text_w)/2:" +
          "y=190"
        );

      }


      if (
        ai.memeBottom
      ) {

        videoFilters.push(
          "drawtext=" +
          `fontfile='${font}':` +
          `text='${escapeDrawText(ai.memeBottom)}':` +
          "fontcolor=white:" +
          "fontsize=54:" +
          "borderw=5:" +
          "bordercolor=black:" +
          "x=(w-text_w)/2:" +
          "y=h-text_h-190"
        );

      }


      // =================================================
      // INPUTS
      // =================================================

      const args =
        [
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


      // =================================================
      // VIDEO
      // =================================================

      args.push(
        "-vf",
        videoFilters.join(",")
      );


      // =================================================
      // AUDIO
      // =================================================

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

      } else if (
        musicFile
      ) {

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


      // =================================================
      // OUTPUT SETTINGS
      // =================================================

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


      // =================================================
      // RENDER
      // =================================================

      await run(
        "ffmpeg",
        args
      );


      // =================================================
      // NOTE ABOUT SILENCE
      // =================================================
      //
      // Silence detection is real.
      //
      // For this version we do NOT physically splice
      // the timeline yet because doing that incorrectly
      // can desynchronize gameplay audio, music and video.
      //
      // The detected silence data is returned below.
      //
      // =================================================


      cleanup(
        videoFile,
        musicFile,
        ...framePaths
      );


      // =================================================
      // RESPONSE
      // =================================================

      res.json({

        ok:
          true,

        url:
          `/exports/${outputName}`,

        duration:
          analysis.duration,

        musicAdded:
          Boolean(
            musicFile
          ),

        ai: {

          enabled:
            Boolean(
              openai
            ),

          heading:
            ai.heading,

          memeTop:
            ai.memeTop,

          memeBottom:
            ai.memeBottom,

          summary:
            ai.summary,

          transcript:
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

          width:
            1080,

          height:
            1920,

          aspectRatio:
            "9:16",

          fillsFrame:
            fillScreen

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
        ...framePaths
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
      "AI headings: enabled"
    );

    console.log(
      "AI meme text: enabled"
    );

    console.log(
      "Background music: OPTIONAL"
    );

  }
);
