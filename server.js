import express from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const d of ['uploads','exports']) mkdirSync(path.join(__dirname,d),{recursive:true});
const app=express();
const upload=multer({dest:path.join(__dirname,'uploads')});
app.use(express.static(path.join(__dirname,'public')));
app.use('/exports',express.static(path.join(__dirname,'exports')));

function run(cmd,args){return new Promise((resolve,reject)=>{const p=spawn(cmd,args);let err='';p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',c=>c===0?resolve():reject(new Error(err||`${cmd} exited ${c}`)));});}
function probe(file){return new Promise((resolve,reject)=>{const p=spawn('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file]);let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',c=>c===0?resolve(Number(out.trim())):reject(new Error(err)));});}
app.post('/api/edit',upload.fields([{name:'video',maxCount:1},{name:'music',maxCount:1}]),async(req,res)=>{
 try{
  const video=req.files?.video?.[0]?.path, music=req.files?.music?.[0]?.path;
  if(!video||!music) return res.status(400).json({error:'Upload both a video and music file.'});
  const duration=await probe(video); const fade=Math.max(0,duration-2);
  const out=path.join(__dirname,'exports',`kindcrafted-${Date.now()}.mp4`);
  // Preserve video speech/audio; loop music, lower it under the source audio, and fade it at the end.
  const filter=`[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1[v];[1:a]volume=0.16,afade=t=out:st=${fade.toFixed(3)}:d=2[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=2[a]`;
  await run('ffmpeg',['-y','-i',video,'-stream_loop','-1','-i',music,'-filter_complex',filter,'-map','[v]','-map','[a]','-t',String(duration),'-c:v','libx264','-preset','medium','-crf','20','-c:a','aac','-b:a','192k','-movflags','+faststart',out]);
  res.json({ok:true,url:`/exports/${path.basename(out)}`});
 }catch(e){res.status(500).json({error:e.message.includes('ENOENT')?'FFmpeg/ffprobe was not found. Install FFmpeg first (see README).':e.message.slice(-1200)});}
});
app.listen(3000,()=>console.log('KindCrafted AI Clip Editor: http://localhost:3000'));
