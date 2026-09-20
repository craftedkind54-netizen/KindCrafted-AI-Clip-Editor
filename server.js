import express from "express";
import multer from "multer";
import OpenAI from "openai";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT) || 8080;
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const uploadsDir = path.join(__dirname, "uploads");
const exportsDir = path.join(__dirname, "exports");
const tempDir = path.join(__dirname, "temp");
for (const dir of [uploadsDir, exportsDir, tempDir]) fs.mkdirSync(dir, { recursive: true });

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/exports", express.static(exportsDir));

const upload = multer({ dest: uploadsDir, limits: { fileSize: 1024 * 1024 * 1024 } });

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "", stderr = "";
    child.stdout.on("data", d => stdout += d.toString());
    child.stderr.on("data", d => stderr += d.toString());
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} failed\n${stderr}`)));
  });
}

const yes = (v, fallback=false) => v == null ? fallback : String(v).toLowerCase() === "true";
const clean = (v, n=60) => String(v || "").replace(/[\r\n]+/g," ").replace(/\s+/g," ").replace(/^["']+|["']+$/g,"").trim().slice(0,n);
function cleanup(...files) { for (const f of files.flat()) try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {} }

async function probe(file) {
  const { stdout } = await run("ffprobe", ["-v","error","-show_streams","-show_format","-of","json",file]);
  return JSON.parse(stdout);
}

function parseSilence(text) {
  const starts=[], out=[];
  for (const line of String(text).split("\n")) {
    const s=line.match(/silence_start:\s*([0-9.]+)/); if(s) starts.push(Number(s[1]));
    const e=line.match(/silence_end:\s*([0-9.]+)/); if(e && starts.length) out.push({start:starts.shift(),end:Number(e[1])});
  }
  return out;
}

async function analyzeVideo(file) {
  const info=await probe(file);
  const v=info.streams.find(s=>s.codec_type==="video");
  const a=info.streams.find(s=>s.codec_type==="audio");
  const duration=Number(info.format?.duration || v?.duration || 0);
  let silence=[];
  if(a) {
    try { const r=await run("ffmpeg",["-hide_banner","-i",file,"-af","silencedetect=noise=-38dB:d=0.65","-f","null","-"]); silence=parseSilence(r.stderr); }
    catch(e){ silence=parseSilence(e.message); }
  }
  return {duration,width:Number(v?.width||0),height:Number(v?.height||0),hasAudio:Boolean(a),silence};
}

async function extractAudio(video,id) {
  const out=path.join(tempDir,`${id}-speech.mp3`);
  await run("ffmpeg",["-y","-i",video,"-vn","-ac","1","-ar","16000","-b:a","64k",out]);
  return out;
}

async function transcribeWords(video,id,hasAudio) {
  if(!openai || !hasAudio) return { text:"", words:[] };
  let audio;
  try {
    audio=await extractAudio(video,id);
    const t=await openai.audio.transcriptions.create({
      file: fs.createReadStream(audio),
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["word"]
    });
    return { text:t.text || "", words:(t.words || []).map(w=>({word:w.word,start:Number(w.start),end:Number(w.end)})) };
  } finally { cleanup(audio); }
}

async function sampleFrames(video,start,end,id,label) {
  const files=[];
  const span=Math.max(.2,end-start);
  for(let i=0;i<4;i++) {
    const at=start+span*((i+1)/5);
    const f=path.join(tempDir,`${id}-${label}-${i}.jpg`);
    try { await run("ffmpeg",["-y","-ss",String(at),"-i",video,"-frames:v","1","-vf","scale=640:-2","-q:v","4",f]); if(fs.existsSync(f)) files.push(f); } catch {}
  }
  return files;
}

const imageURL=f=>`data:image/jpeg;base64,${fs.readFileSync(f).toString("base64")}`;
function parseJSON(text){ try{return JSON.parse(text)}catch{} const m=String(text).match(/\{[\s\S]*\}/); if(!m)return null; try{return JSON.parse(m[0])}catch{return null} }

async function planSegments({ transcript, words, duration, autoMeme }) {
  // AI chooses semantic boundaries; word timestamps provide the timing evidence.
  if(!openai || !transcript.trim()) return [{ title:"Minecraft Short", start:0, end:duration, memeTop:"", memeBottom:"" }];
  const timed=words.map(w=>`[${w.start.toFixed(2)}-${w.end.toFixed(2)}] ${w.word}`).join(" ");
  const r=await openai.responses.create({
    model:"gpt-5",
    input:[{role:"user",content:[{type:"input_text",text:`You are segmenting one gaming recording into separate YouTube Shorts. The creator introduces minigames by saying their names, for example "Minecraft Take It or Leave It" or "Minecraft Dispenser Roulette". Use the timestamped transcript to find every distinct minigame. Start each clip at the beginning of the spoken minigame introduction/name. End it when that minigame finishes, or immediately before the next minigame introduction. Remove unrelated footage before the first minigame and after a minigame when it is clearly unrelated. Do not invent minigames. Return ONLY JSON in this form: {"segments":[{"title":"short accurate title","start":0.0,"end":10.0,"memeTop":"","memeBottom":""}]}. Titles should be 2-7 words and max 40 characters. ${autoMeme ? "Add very short family-friendly meme text only when clearly appropriate." : "Always leave memeTop and memeBottom empty."} Video duration: ${duration.toFixed(2)} seconds. Timestamped transcript: ${timed}`}] }]
  });
  const p=parseJSON(r.output_text);
  const raw=Array.isArray(p?.segments)?p.segments:[];
  const segments=raw.map((s,i)=>({
    title:clean(s.title || `Minecraft Short ${i+1}`,40),
    start:Math.max(0,Math.min(duration,Number(s.start)||0)),
    end:Math.max(0,Math.min(duration,Number(s.end)||duration)),
    memeTop:clean(s.memeTop,45), memeBottom:clean(s.memeBottom,45)
  })).filter(s=>s.end-s.start>=1);
  return segments.length ? segments : [{title:"Minecraft Short",start:0,end:duration,memeTop:"",memeBottom:""}];
}

async function improveSegmentWithVision(video,segment,id,index,autoMeme) {
  if(!openai) return segment;
  const frames=await sampleFrames(video,segment.start,segment.end,id,`seg${index}`);
  try {
    const content=[{type:"input_text",text:`This is a family-friendly Minecraft Short segment. Current detected title: ${segment.title}. Return ONLY JSON {"title":"","memeTop":"","memeBottom":""}. Keep the title accurate, 2-7 words, max 40 characters. ${autoMeme ? "Use short meme text only if the frames clearly justify it." : "Leave meme fields blank."}`}];
    for(const f of frames) content.push({type:"input_image",image_url:imageURL(f),detail:"low"});
    const r=await openai.responses.create({model:"gpt-5",input:[{role:"user",content}]});
    const p=parseJSON(r.output_text)||{};
    return {...segment,title:clean(p.title || segment.title,40),memeTop:autoMeme?clean(p.memeTop,45):"",memeBottom:autoMeme?clean(p.memeBottom,45):"",_frames:frames};
  } catch { return {...segment,_frames:frames}; }
}

function makeText(id,name,text){ const f=path.join(tempDir,`${id}-${name}.txt`); fs.writeFileSync(f,String(text||""),"utf8"); return f; }
function escPath(f){ return f.replace(/\\/g,"/").replace(/:/g,"\\:").replace(/'/g,"\\'"); }
function findFont(){ for(const f of ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf","/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"]) if(fs.existsSync(f)) return f; return null; }
function drawText(textFile,font,size,y,enable=null,box=true){
  let x="drawtext="+(font?`fontfile='${escPath(font)}':`:"font='DejaVu Sans':")+`textfile='${escPath(textFile)}':fontcolor=white:fontsize=${size}:borderw=7:bordercolor=black:`;
  if(box)x+="box=1:boxcolor=black@0.50:boxborderw=20:";
  x+=`x=(w-text_w)/2:y=${y}`;
  if(enable)x+=`:enable='${enable}'`;
  return x;
}

async function renderSegment({video,music,segment,id,index,options}) {
  const outputName=`${id}-clip-${index+1}.mp4`;
  const output=path.join(exportsDir,outputName);
  const font=findFont();
  const temps=[];
  const filters=[];
  if(options.fillScreen) filters.push("scale=1080:1920:force_original_aspect_ratio=increase","crop=1080:1920","setsar=1");
  else filters.push("scale=1080:1920:force_original_aspect_ratio=decrease","pad=1080:1920:(ow-iw)/2:(oh-ih)/2","setsar=1");
  if(options.autoZoom) filters.push("scale=1118:1988","crop=1080:1920:x='19+12*sin(t*0.8)':y='34+18*sin(t*0.55)'");

  // Header=Yes means it MUST render for the first 3 seconds (or entire clip if shorter).
  if(options.autoHeading) {
    const hf=makeText(id,`heading-${index}`,segment.title || "Minecraft Short"); temps.push(hf);
    filters.push(drawText(hf,font,64,"110",`between(t,0,${Math.min(3,segment.end-segment.start).toFixed(2)})`,true));
  }
  if(options.autoMeme && segment.memeTop){ const f=makeText(id,`mt-${index}`,segment.memeTop);temps.push(f);filters.push(drawText(f,font,50,"250",null,false)); }
  if(options.autoMeme && segment.memeBottom){ const f=makeText(id,`mb-${index}`,segment.memeBottom);temps.push(f);filters.push(drawText(f,font,50,"h-text_h-180",null,false)); }

  const len=Math.max(.1,segment.end-segment.start);
  const args=["-y","-ss",String(segment.start),"-t",String(len),"-i",video];
  if(music) args.push("-stream_loop","-1","-i",music);
  args.push("-vf",filters.join(","));
  if(options.keepAudio && music) args.push("-filter_complex","[0:a]volume=1[voice];[1:a]volume=0.16[music];[music][voice]sidechaincompress=threshold=0.025:ratio=10:attack=15:release=300[ducked];[voice][ducked]amix=inputs=2:duration=first:normalize=0[a]","-map","0:v:0","-map","[a]");
  else if(options.keepAudio) args.push("-map","0:v:0","-map","0:a:0?");
  else if(music) args.push("-map","0:v:0","-map","1:a:0","-af","volume=0.20");
  else args.push("-map","0:v:0","-an");
  args.push("-c:v","libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p","-r","30");
  if(options.keepAudio || music) args.push("-c:a","aac","-b:a","192k");
  args.push("-movflags","+faststart","-shortest",output);
  await run("ffmpeg",args);
  cleanup(temps);
  return {title:segment.title,start:segment.start,end:segment.end,duration:len,url:`/exports/${outputName}`,headerAdded:options.autoHeading,memeTop:segment.memeTop,memeBottom:segment.memeBottom};
}

app.get("/api/health",async(req,res)=>res.json({ok:true,openai:Boolean(openai)}));

app.post("/api/edit",upload.fields([{name:"video",maxCount:1},{name:"music",maxCount:1}]),async(req,res)=>{
  const video=req.files?.video?.[0]?.path;
  const music=req.files?.music?.[0]?.path || null;
  if(!video)return res.status(400).json({error:"A video file is required."});
  const id=crypto.randomUUID(); let frameTemps=[];
  try {
    const options={
      autoHeading:yes(req.body.autoHeading,true), autoMeme:yes(req.body.autoMeme,false), autoZoom:yes(req.body.autoZoom,true),
      removeSilence:yes(req.body.removeSilence,true), fillScreen:yes(req.body.fillScreen,true), keepAudio:yes(req.body.keepAudio,true)
    };
    const analysis=await analyzeVideo(video);
    if(!analysis.duration)throw new Error("Could not determine video duration.");
    const tx=await transcribeWords(video,id,analysis.hasAudio);
    let segments=await planSegments({transcript:tx.text,words:tx.words,duration:analysis.duration,autoMeme:options.autoMeme});
    const improved=[];
    for(let i=0;i<segments.length;i++){ const s=await improveSegmentWithVision(video,segments[i],id,i,options.autoMeme); frameTemps.push(...(s._frames||[])); delete s._frames; improved.push(s); }
    segments=improved;
    const clips=[];
    for(let i=0;i<segments.length;i++) clips.push(await renderSegment({video,music,segment:segments[i],id,index:i,options}));
    cleanup(video,music,frameTemps);
    res.json({ok:true,clips,musicAdded:Boolean(music),analysis:{...analysis,transcript:tx.text},options});
  } catch(error){ console.error("EDIT ERROR",error); cleanup(video,music,frameTemps); res.status(500).json({error:error.message||"Video editing failed."}); }
});

app.listen(PORT,()=>{
  console.log(`KindCrafted AI Clip Editor running on port ${PORT}`);
  console.log("Timestamped minigame detection: enabled");
  console.log("Separate Shorts: enabled");
  console.log("3-second required header when selected: enabled");
  console.log("OpenAI analysis:",openai?"enabled":"disabled");
});
