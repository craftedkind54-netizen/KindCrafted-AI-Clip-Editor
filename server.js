import express from "express";
import multer from "multer";
import { spawn } from "node:child_process";
import { mkdirSync, unlink } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// =====================================================
// KINDCRAFTED AI CLIP EDITOR
// =====================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOADS_DIR = path.join(__dirname, "uploads");
const EXPORTS_DIR = path.join(__dirname, "exports");

// Create folders automatically
mkdirSync(UPLOADS_DIR, { recursive: true });
mkdirSync(EXPORTS_DIR, { recursive: true });

// =====================================================
// EXPRESS
// =====================================================

const app = express();

const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

app.use(
  express.urlencoded({
    extended: true,
  })
);

app.use(express.static(path.join(__dirname, "public")));

app.use(
  "/exports",
  express.static(EXPORTS_DIR)
);

// =====================================================
// FILE UPLOADS
// =====================================================

const upload = multer({
  dest: UPLOADS_DIR,

  limits: {
    fileSize: 1024 * 1024 * 1000,
  },
});

// =====================================================
// RUN COMMAND
// =====================================================

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args);

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("error", (error) => {
      reject(error);
    });

    process.on("close", (code) => {
      if (code === 0) {
        resolve({
          stdout,
          stderr,
        });
      } else {
        reject(
          new Error(
            stderr ||
              `${command} exited with code ${code}`
          )
        );
      }
    });
  });
}

// =====================================================
// FFPROBE
// =====================================================

function ffprobeJSON(file) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-show_entries",
      "stream=index,codec_type",
      "-of",
      "json",
      file,
    ];

    const process = spawn("ffprobe", args);

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("error", reject);

    process.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            stderr || `ffprobe exited with code ${code}`
          )
        );
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(
          new Error("Could not read the uploaded video.")
        );
      }
    });
  });
}

// =====================================================
// DELETE TEMP FILE
// =====================================================

function deleteFile(file) {
  if (!file) return;

  unlink(file, () => {
    // Ignore cleanup errors.
  });
}

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/api/health", async (req, res) => {
  try {
    await runCommand("ffmpeg", ["-version"]);
    await runCommand("ffprobe", ["-version"]);

    res.json({
      ok: true,
      ffmpeg: true,
      ffprobe: true,
      musicOptional: true,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      ffmpeg: false,
      error:
        "FFmpeg or ffprobe is not available on the server.",
    });
  }
});

// =====================================================
// EDIT CLIP
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
    let videoFile = null;
    let musicFile = null;

    try {
      // -------------------------------------------------
      // GET UPLOADED FILES
      // -------------------------------------------------

      videoFile =
        req.files?.video?.[0]?.path || null;

      musicFile =
        req.files?.music?.[0]?.path || null;

      // -------------------------------------------------
      // VIDEO IS REQUIRED
      // MUSIC IS OPTIONAL
      // -------------------------------------------------

      if (!videoFile) {
        return res.status(400).json({
          error:
            "Please upload a video clip.",
        });
      }

      // -------------------------------------------------
      // ANALYZE VIDEO
      // -------------------------------------------------

      const info = await ffprobeJSON(videoFile);

      const duration =
        Number(info?.format?.duration) || 0;

      if (!duration || duration <= 0) {
        throw new Error(
          "Could not determine the video's duration."
        );
      }

      const streams =
        Array.isArray(info?.streams)
          ? info.streams
          : [];

      const videoHasAudio =
        streams.some(
          (stream) =>
            stream.codec_type === "audio"
        );

      // -------------------------------------------------
      // OUTPUT
      // -------------------------------------------------

      const filename =
        `kindcrafted-${Date.now()}.mp4`;

      const outputFile =
        path.join(
          EXPORTS_DIR,
          filename
        );

      // =================================================
      // VIDEO FILTER
      // =================================================

      const videoFilter =
        "scale=1080:1920:" +
        "force_original_aspect_ratio=decrease," +
        "pad=1080:1920:" +
        "(ow-iw)/2:" +
        "(oh-ih)/2," +
        "setsar=1";

      // =================================================
      // MUSIC PROVIDED
      // =================================================

      if (musicFile) {
        const fadeDuration =
          Math.min(2, duration);

        const fadeStart =
          Math.max(
            0,
            duration - fadeDuration
          );

        // -----------------------------------------------
        // VIDEO HAS ORIGINAL AUDIO
        // -----------------------------------------------

        if (videoHasAudio) {
          const filterComplex = [
            `[0:v]${videoFilter}[v]`,

            `[0:a]volume=1.0[original]`,

            `[1:a]` +
              `volume=0.16,` +
              `afade=t=out:` +
              `st=${fadeStart.toFixed(3)}:` +
              `d=${fadeDuration.toFixed(3)}` +
              `[music]`,

            `[original][music]` +
              `amix=` +
              `inputs=2:` +
              `duration=first:` +
              `dropout_transition=2` +
              `[a]`,
          ].join(";");

          await runCommand(
            "ffmpeg",
            [
              "-y",

              "-i",
              videoFile,

              "-stream_loop",
              "-1",

              "-i",
              musicFile,

              "-filter_complex",
              filterComplex,

              "-map",
              "[v]",

              "-map",
              "[a]",

              "-t",
              String(duration),

              "-c:v",
              "libx264",

              "-preset",
              "medium",

              "-crf",
              "20",

              "-c:a",
              "aac",

              "-b:a",
              "192k",

              "-movflags",
              "+faststart",

              outputFile,
            ]
          );
        }

        // -----------------------------------------------
        // VIDEO HAS NO ORIGINAL AUDIO
        // -----------------------------------------------

        else {
          const filterComplex = [
            `[0:v]${videoFilter}[v]`,

            `[1:a]` +
              `volume=0.16,` +
              `afade=t=out:` +
              `st=${fadeStart.toFixed(3)}:` +
              `d=${fadeDuration.toFixed(3)}` +
              `[a]`,
          ].join(";");

          await runCommand(
            "ffmpeg",
            [
              "-y",

              "-i",
              videoFile,

              "-stream_loop",
              "-1",

              "-i",
              musicFile,

              "-filter_complex",
              filterComplex,

              "-map",
              "[v]",

              "-map",
              "[a]",

              "-t",
              String(duration),

              "-c:v",
              "libx264",

              "-preset",
              "medium",

              "-crf",
              "20",

              "-c:a",
              "aac",

              "-b:a",
              "192k",

              "-movflags",
              "+faststart",

              outputFile,
            ]
          );
        }
      }

      // =================================================
      // NO MUSIC PROVIDED
      // =================================================

      else {
        // -----------------------------------------------
        // KEEP ORIGINAL AUDIO
        // -----------------------------------------------

        if (videoHasAudio) {
          await runCommand(
            "ffmpeg",
            [
              "-y",

              "-i",
              videoFile,

              "-vf",
              videoFilter,

              "-map",
              "0:v:0",

              "-map",
              "0:a:0",

              "-c:v",
              "libx264",

              "-preset",
              "medium",

              "-crf",
              "20",

              "-c:a",
              "aac",

              "-b:a",
              "192k",

              "-movflags",
              "+faststart",

              outputFile,
            ]
          );
        }

        // -----------------------------------------------
        // VIDEO HAS NO AUDIO
        // -----------------------------------------------

        else {
          await runCommand(
            "ffmpeg",
            [
              "-y",

              "-i",
              videoFile,

              "-vf",
              videoFilter,

              "-map",
              "0:v:0",

              "-an",

              "-c:v",
              "libx264",

              "-preset",
              "medium",

              "-crf",
              "20",

              "-movflags",
              "+faststart",

              outputFile,
            ]
          );
        }
      }

      // =================================================
      // SUCCESS
      // =================================================

      res.json({
        ok: true,

        musicAdded:
          Boolean(musicFile),

        originalAudio:
          videoHasAudio,

        duration,

        url:
          `/exports/${filename}`,
      });
    } catch (error) {
      console.error(
        "EDIT ERROR:",
        error
      );

      let message =
        error?.message ||
        "Something went wrong while editing the clip.";

      if (
        message.includes("ENOENT") ||
        message.includes("spawn ffmpeg") ||
        message.includes("spawn ffprobe")
      ) {
        message =
          "FFmpeg/ffprobe was not found on the server.";
      }

      res.status(500).json({
        error:
          message.slice(-2000),
      });
    } finally {
      // Delete temporary uploads.
      deleteFile(videoFile);
      deleteFile(musicFile);
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
      "Background music: optional"
    );
  }
);
