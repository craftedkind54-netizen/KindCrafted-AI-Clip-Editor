# KindCrafted AI Clip Editor — Mac Version

Local Version 1 of the KindCrafted clip editor. It does **not** require CapCut authorization.

## What it does
- Upload a video + background music in a local web dashboard.
- Converts the video to vertical 1080×1920 (9:16), preserving aspect ratio with padding.
- Loops or trims music to exactly fit the clip.
- Keeps background music low beneath the original clip audio.
- Fades the background music during the final 2 seconds.
- Exports an H.264/AAC MP4 ready for Shorts and later CapCut import.

## Mac setup
1. Install Homebrew if you do not already have it: https://brew.sh
2. Open Terminal.
3. Install Node and FFmpeg:
   `brew install node ffmpeg`
4. In Terminal, go into this project folder.
5. Run: `npm install`
6. Run: `npm start`
7. Open: http://localhost:3000

## GitHub
Upload the contents of this folder to your GitHub repository. Do not upload `node_modules`.

## CapCut
CapCut integration is intentionally separated. Your CapCut plugin was installed on Windows, but its authorization flow reported U.S. network authorization unavailable. This project therefore performs Version 1 editing locally and exports a normal MP4 you can import into CapCut.

## Next versions
Planned modules can add speech-aware dynamic music ducking, captions, silence removal, beat detection, zooms, sound effects, clip selection, and CapCut integration when authorization is available.
