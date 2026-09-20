import express from "express";
import multer from "multer";
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

// Railway supplies PORT automatically.
// 8080 is the fallback.
const PORT = Number(process.env.PORT) || 8080;

// =====================================================
// FOLDERS
// =====================================================

const uploadsDir = path.join(__dirname, "uploads");
const exportsDir = path.join(__dirname, "exports");

fs.mkdirSync(uploadsDir, {
  recursive: true,
});

fs.mkdirSync(exportsDir, {
  recursive: true,
});

// =====================================================
// EXPRESS
// =====================================================

app.use(express.json());

app.use(
  express.urlencoded({
    extended: true,
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
// UPLOADS
// =====================================================

const upload = multer({
  dest: uploadsDir,

  limits: {
    fileSize:
      1024 * 1024 * 1000,
  },
});

// =====================================================
// RUN FFMPEG / FFPROBE
// =====================================================

function run(bin, args) {
  return new Promise(
    (resolve, reject) => {
      const process =
        spawn(bin, args);

      let stdout = "";
      let stderr = "";

      process.stdout.on(
        "data",
        (data) => {
          stdout +=
            data.toString();
        }
      );

      process.stderr.on(
        "data",
        (data) => {
          stderr +=
            data.toString();
        }
      );

      process.on(
        "error",
        (error) => {
          reject(error);
        }
      );

      process.on(
        "close",
        (code) => {
          if (code === 0) {
            resolve({
              out: stdout,
              err: stderr,
            });
          } else {
            reject(
              new Error(
                stderr ||
                  `${bin} exited with code ${code}`
              )
            );
          }
        }
      );
    }
  );
}

// =====================================================
// FFPROBE
// =====================================================

async function probe(file) {
  const { out } =
    await run(
      "ffprobe",
      [
        "-v",
        "error",

        "-show_streams",

        "-show_format",

        "-of",
        "json",

        file,
      ]
    );

  return JSON.parse(out);
}

// =====================================================
// VIDEO ANALYSIS
// =====================================================

async function analyzeVideo(file) {
  const metadata =
    await probe(file);

  const duration =
    Number(
      metadata.format?.duration ||
        0
    );

  const videoStream =
    metadata.streams?.find(
      (stream) =>
        stream.codec_type ===
        "video"
    );

  const audioStream =
    metadata.streams?.find(
      (stream) =>
        stream.codec_type ===
        "audio"
    );

  if (
    !videoStream ||
    !duration
  ) {
    throw new Error(
      "The uploaded file does not contain a readable video."
    );
  }

  // ===================================================
  // SILENCE ANALYSIS
  // ===================================================

  const silence = [];

  if (audioStream) {
    try {
      const { err } =
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

            "-",
          ]
        );

      const starts = [
        ...err.matchAll(
          /silence_start:\s*([\d.]+)/g
        ),
      ].map(
        (match) =>
          Number(match[1])
      );

      const ends = [
        ...err.matchAll(
          /silence_end:\s*([\d.]+)/g
        ),
      ].map(
        (match) =>
          Number(match[1])
      );

      for (
        let i = 0;
        i <
        Math.min(
          starts.length,
          ends.length
        );
        i++
      ) {
        if (
          ends[i] >
          starts[i]
        ) {
          silence.push([
            starts[i],
            ends[i],
          ]);
        }
      }
    } catch (error) {
      console.log(
        "Silence analysis skipped:",
        error.message
      );
    }
  }

  return {
    duration,

    width:
      Number(
        videoStream.width ||
          0
      ),

    height:
      Number(
        videoStream.height ||
          0
      ),

    hasAudio:
      Boolean(audioStream),

    silence,
  };
}

// =====================================================
// CLEAN TEMP FILES
// =====================================================

function cleanup(...files) {
  for (const file of files) {
    if (!file) continue;

    fs.unlink(
      file,
      () => {}
    );
  }
}

// =====================================================
// ESCAPE TEXT FOR FFMPEG
// =====================================================

function escapeDrawText(
  text = ""
) {
  return text
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
    );
}

// =====================================================
// HEALTH CHECK
// =====================================================

app.get(
  "/api/health",

  async (req, res) => {
    try {
      await run(
        "ffmpeg",
        ["-version"]
      );

      await run(
        "ffprobe",
        ["-version"]
      );

      res.json({
        ok: true,

        editor:
          "KindCrafted AI Clip Editor",

        analysis: true,

        memeEditor: true,

        musicOptional: true,
      });
    } catch (error) {
      res
        .status(500)
        .json({
          ok: false,

          error:
            "FFmpeg/ffprobe is not installed.",
        });
    }
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
      maxCount: 1,
    },

    {
      name: "music",
      maxCount: 1,
    },
  ]),

  async (req, res) => {
    const videoFile =
      req.files?.video?.[0]
        ?.path;

    // MUSIC IS OPTIONAL
    const musicFile =
      req.files?.music?.[0]
        ?.path || null;

    // ONLY VIDEO IS REQUIRED
    if (!videoFile) {
      return res
        .status(400)
        .json({
          error:
            "Choose a video clip.",
        });
    }

    try {
      // ===============================================
      // ANALYZE THE ACTUAL VIDEO
      // ===============================================

      const analysis =
        await analyzeVideo(
          videoFile
        );

      const duration =
        analysis.duration;

      console.log(
        "Video analysis:"
      );

      console.log({
        duration,
        width:
          analysis.width,
        height:
          analysis.height,
        hasAudio:
          analysis.hasAudio,
        silenceSections:
          analysis.silence
            .length,
      });

      // ===============================================
      // OUTPUT FILE
      // ===============================================

      const outputFile =
        path.join(
          exportsDir,

          `kindcrafted-${crypto.randomUUID()}.mp4`
        );

      // ===============================================
      // USER OPTIONS
      // ===============================================

      const heading =
        String(
          req.body.heading ||
            ""
        )
          .trim()
          .slice(0, 120);

      const memeTop =
        String(
          req.body.memeTop ||
            ""
        )
          .trim()
          .slice(0, 120);

      const memeBottom =
        String(
          req.body
            .memeBottom || ""
        )
          .trim()
          .slice(0, 120);

      const autoZoom =
        String(
          req.body.autoZoom ||
            "true"
        ) !== "false";

      // ===============================================
      // 9:16 VIDEO FILTER
      // ===============================================

      /*
       * IMPORTANT:
       *
       * This FILLS the entire
       * 1080x1920 Shorts frame.
       *
       * It does NOT shrink the
       * gameplay and put black
       * bars around it.
       *
       * It scales until the
       * whole 9:16 frame is
       * covered, then crops
       * overflow.
       */

      const videoFilters = [
        "scale=1080:1920:force_original_aspect_ratio=increase",

        "crop=1080:1920",

        "setsar=1",
      ];

      // ===============================================
      // AUTOMATIC MOTION / ZOOM
      // ===============================================

      if (autoZoom) {
        videoFilters.push(
          "scale=iw*1.035:ih*1.035,crop=1080:1920"
        );
      }

      // ===============================================
      // TEXT FONT
      // ===============================================

      const font =
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

      // ===============================================
      // HEADING
      // ===============================================

      if (heading) {
        videoFilters.push(
          `drawtext=` +
            `fontfile=${font}:` +
            `text='${escapeDrawText(
              heading
            )}':` +
            `fontcolor=white:` +
            `fontsize=58:` +
            `borderw=5:` +
            `bordercolor=black:` +
            `x=(w-text_w)/2:` +
            `y=90`
        );
      }

      // ===============================================
      // MEME TOP TEXT
      // ===============================================

      if (memeTop) {
        videoFilters.push(
          `drawtext=` +
            `fontfile=${font}:` +
            `text='${escapeDrawText(
              memeTop
            )}':` +
            `fontcolor=white:` +
            `fontsize=62:` +
            `borderw=6:` +
            `bordercolor=black:` +
            `x=(w-text_w)/2:` +
            `y=180`
        );
      }

      // ===============================================
      // MEME BOTTOM TEXT
      // ===============================================

      if (memeBottom) {
        videoFilters.push(
          `drawtext=` +
            `fontfile=${font}:` +
            `text='${escapeDrawText(
              memeBottom
            )}':` +
            `fontcolor=white:` +
            `fontsize=62:` +
            `borderw=6:` +
            `bordercolor=black:` +
            `x=(w-text_w)/2:` +
            `y=h-text_h-190`
        );
      }

      // ===============================================
      // START FFMPEG
      // ===============================================

      const args = [
        "-y",

        "-i",
        videoFile,
      ];

      // ===============================================
      // OPTIONAL MUSIC INPUT
      // ===============================================

      if (musicFile) {
        /*
         * Loop music forever.
         *
         * The final -t below
         * stops the ENTIRE video
         * at the original VIDEO
         * duration.
         *
         * This prevents a
         * 20-second clip from
         * becoming a 3-minute
         * video because the music
         * was 3 minutes long.
         */

        args.push(
          "-stream_loop",
          "-1",

          "-i",
          musicFile
        );
      }

      // ===============================================
      // VIDEO FILTER
      // ===============================================

      args.push(
        "-vf",
        videoFilters.join(",")
      );

      // ===============================================
      // VIDEO + MUSIC + ORIGINAL AUDIO
      // ===============================================

      if (
        musicFile &&
        analysis.hasAudio
      ) {
        const fadeDuration =
          Math.min(
            2,
            duration
          );

        const fadeStart =
          Math.max(
            0,
            duration -
              fadeDuration
          );

        /*
         * Music starts quiet.
         *
         * Sidechain compression
         * lowers it further while
         * original audio/speech is
         * happening.
         */

        const audioFilter =
          `[1:a]` +
          `volume=0.20,` +
          `afade=` +
          `t=out:` +
          `st=${fadeStart}:` +
          `d=${fadeDuration}` +
          `[background];` +

          `[background][0:a]` +
          `sidechaincompress=` +
          `threshold=0.035:` +
          `ratio=8:` +
          `attack=20:` +
          `release=350` +
          `[ducked];` +

          `[0:a][ducked]` +
          `amix=` +
          `inputs=2:` +
          `duration=first:` +
          `normalize=0` +
          `[audio]`;

        args.push(
          "-filter_complex",
          audioFilter,

          "-map",
          "0:v:0",

          "-map",
          "[audio]"
        );
      }

      // ===============================================
      // MUSIC BUT VIDEO HAS NO ORIGINAL AUDIO
      // ===============================================

      else if (musicFile) {
        const fadeDuration =
          Math.min(
            2,
            duration
          );

        const fadeStart =
          Math.max(
            0,
            duration -
              fadeDuration
          );

        args.push(
          "-filter_complex",

          `[1:a]` +
            `volume=0.20,` +
            `afade=` +
            `t=out:` +
            `st=${fadeStart}:` +
            `d=${fadeDuration}` +
            `[audio]`,

          "-map",
          "0:v:0",

          "-map",
          "[audio]"
        );
      }

      // ===============================================
      // NO MUSIC
      // KEEP ORIGINAL AUDIO
      // ===============================================

      else if (
        analysis.hasAudio
      ) {
        args.push(
          "-map",
          "0:v:0",

          "-map",
          "0:a:0"
        );
      }

      // ===============================================
      // NO MUSIC AND NO AUDIO
      // ===============================================

      else {
        args.push(
          "-map",
          "0:v:0",

          "-an"
        );
      }

      // ===============================================
      // EXPORT SETTINGS
      // ===============================================

      args.push(
        /*
         * THIS IS IMPORTANT.
         *
         * Always stop at the
         * ACTUAL VIDEO duration.
         */

        "-t",
        String(duration),

        // Video codec

        "-c:v",
        "libx264",

        // Railway-friendly speed

        "-preset",
        "veryfast",

        // Good Shorts quality

        "-crf",
        "20",

        // Compatibility

        "-pix_fmt",
        "yuv420p",

        // Audio

        "-c:a",
        "aac",

        "-b:a",
        "192k",

        // Faster playback/download

        "-movflags",
        "+faststart",

        outputFile
      );

      // ===============================================
      // RUN THE EDIT
      // ===============================================

      console.log(
        "Starting video edit..."
      );

      await run(
        "ffmpeg",
        args
      );

      console.log(
        "Video edit complete."
      );

      // ===============================================
      // RETURN RESULT
      // ===============================================

      res.json({
        ok: true,

        url:
          `/exports/${path.basename(
            outputFile
          )}`,

        duration,

        musicAdded:
          Boolean(
            musicFile
          ),

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
            analysis.silence,
        },

        output: {
          width: 1080,

          height: 1920,

          aspectRatio:
            "9:16",

          fillsFrame: true,
        },

        options: {
          heading,

          memeTop,

          memeBottom,

          autoZoom,
        },
      });
    } catch (error) {
      console.error(
        "VIDEO EDIT ERROR:"
      );

      console.error(error);

      let message =
        error?.message ||
        "Editing failed.";

      if (
        message.includes(
          "ENOENT"
        ) ||
        message.includes(
          "spawn ffmpeg"
        ) ||
        message.includes(
          "spawn ffprobe"
        )
      ) {
        message =
          "FFmpeg/ffprobe was not found on the Railway server.";
      }

      res
        .status(500)
        .json({
          error:
            message.slice(
              -2500
            ),
        });
    } finally {
      // ===============================================
      // DELETE TEMP UPLOADS
      // ===============================================

      cleanup(
        videoFile,
        musicFile
      );
    }
  }
);

// =====================================================
// START SERVER
// =====================================================

app.listen(
  PORT,
  "0.0.0.0",

  () => {
    console.log(
      `KindCrafted AI Clip Editor running on port ${PORT}`
    );

    console.log(
      "Video analysis: enabled"
    );

    console.log(
      "Silence analysis: enabled"
    );

    console.log(
      "9:16 full-frame editing: enabled"
    );

    console.log(
      "Heading editor: enabled"
    );

    console.log(
      "Meme editor: enabled"
    );

    console.log(
      "Automatic motion: enabled"
    );

    console.log(
      "Background music: OPTIONAL"
    );
  }
);
