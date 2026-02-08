const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Inicjalizacja klienta Supabase z proces.env (ustawiane w panelu Render)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const WORK_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR);

app.post('/process', async (req, res) => {
  const { projectId } = req.body; 
  if (!projectId) return res.status(400).send('Brak projectId (order_id)');
  
  res.send({ status: 'started', message: `Montaż rozpoczęty dla: ${projectId}` });
  
  processVideo(projectId).catch(err => {
    console.error(`CRITICAL ERROR [${projectId}]:`, err);
  });
});

async function processVideo(orderId) {
  const dir = path.join(WORK_DIR, orderId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);

  try {
    console.log(`[${orderId}] === START MONTAŻU ===`);
    const { data: order, error: dbError } = await supabase
        .from('story_orders')
        .select('partner_name, story_title, recipient_sex')
        .eq('order_id', orderId)
        .single();

    if (dbError || !order) throw new Error(`Nie znaleziono zamówienia ${orderId}`);
    
    const { partner_name, story_title, recipient_sex } = order;
    const bucket = 'stories';
    const basePath = `${partner_name}/${story_title}`; 
    
    const files = {
        '1.mp4': { path: `${basePath}/background_video_chapter1_${story_title}_${partner_name}_${recipient_sex}.mp4`, local: '1.mp4' },
        '1.mp3': { path: `${basePath}/${partner_name}/${orderId}/chapter_1.mp3`, local: '1.mp3' },
        '2.mp3': { path: `${basePath}/music_backgrounds/background_audio_chapter1_${story_title}.mp3`, local: '2.mp3' },
        '1.png': { path: `${basePath}/${partner_name}/${orderId}/user_img_${orderId}.png`, local: '1.png' },
        '1A.mp4': { path: `${basePath}/end_video_chapter1_${story_title}_${partner_name}_${recipient_sex}.mp4`, local: '1A.mp4' },
        '2.mp4': { path: `${basePath}/background_video_chapter2_${story_title}_${partner_name}_${recipient_sex}.mp4`, local: '2.mp4' },
        '3.mp3': { path: `${basePath}/${partner_name}/${orderId}/chapter_2.mp3`, local: '3.mp3' },
        '4.mp3': { path: `${basePath}/music_backgrounds/background_audio_chapter2_${story_title}.mp3`, local: '4.mp3' },
        '3.mp4': { path: `${basePath}/music_video_${story_title}_${partner_name}_${recipient_sex}.mp4`, local: '3.mp4' }
    };

    console.log(`[${orderId}] Pobieranie plików...`);
    for (const [key, conf] of Object.entries(files)) {
        const { data, error } = await supabase.storage.from(bucket).download(conf.path);
        if (error) throw new Error(`Błąd pobierania ${key}: ${error.message}`);
        fs.writeFileSync(path.join(dir, conf.local), Buffer.from(await data.arrayBuffer()));
    }

    console.log(`[${orderId}] Renderowanie Rozdziału 1...`);
    const durationLektor1 = await getDuration(path.join(dir, '1.mp3'));
    const ch1Part1 = path.join(dir, 'temp_ch1_part1.mp4');
    await runFFmpegCommand(ffmpeg().input(path.join(dir, '1.mp4')).input(path.join(dir, '1.png')).input(path.join(dir, '1.mp3')).input(path.join(dir, '2.mp3')).complexFilter([`[1:v]loop=loop=-1:size=2:start=0[imgloop]`,`[0:v][imgloop]concat=n=2:v=1:a=0[videobase]`,`[videobase]trim=duration=${durationLektor1}[vfinal]`,`[2:a][3:a]amix=inputs=2:duration=first[afinal]`]).outputOptions(['-map [vfinal]', '-map [afinal]', '-c:v libx264', '-c:a aac', '-shortest']).save(ch1Part1));

    const ch1Final = path.join(dir, 'chapter1_complete.mp4');
    await concatVideos([ch1Part1, path.join(dir, '1A.mp4')], ch1Final);

    console.log(`[${orderId}] Renderowanie Rozdziału 2...`);
    const durationLektor2 = await getDuration(path.join(dir, '3.mp3'));
    const ch2Part1 = path.join(dir, 'temp_ch2_part1.mp4');
    await runFFmpegCommand(ffmpeg().input(path.join(dir, '2.mp4')).input(path.join(dir, '3.mp3')).input(path.join(dir, '4.mp3')).complexFilter([`[0:v]trim=duration=${durationLektor2}[vfinal]`,`[1:a][2:a]amix=inputs=2:duration=first[afinal]`]).outputOptions(['-map [vfinal]', '-map [afinal]', '-c:v libx264', '-c:a aac']).save(ch2Part1));

    const ch2Final = path.join(dir, 'chapter2_complete.mp4');
    await concatVideos([ch2Part1, path.join(dir, '3.mp4')], ch2Final);

    const outputBasePath = `${partner_name}/orders/${orderId}`;
    console.log(`[${orderId}] Upload gotowych plików...`);
    await uploadFile(supabase, bucket, outputBasePath, ch1Final, `${story_title}_${partner_name}_chapter_1.mp4`);
    await uploadFile(supabase, bucket, outputBasePath, ch2Final, `${story_title}_${partner_name}_chapter_2.mp4`);

    console.log(`[${orderId}] SUKCES!`);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[${orderId}] BŁĄD:`, err);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function getDuration(filePath) { return new Promise((res, rej) => { ffmpeg.ffprobe(filePath, (err, meta) => err ? rej(err) : res(meta.format.duration)); }); }
function runFFmpegCommand(cmd) { return new Promise((res, rej) => cmd.on('end', res).on('error', rej).run()); }
async function concatVideos(files, out) { return new Promise((res, rej) => ffmpeg().on('end', res).on('error', rej).input(files[0]).input(files[1]).mergeToFile(out, path.dirname(out))); }
async function uploadFile(sb, b, p, l, f) { const { error } = await sb.storage.from(b).upload(`${p}/${f}`, fs.readFileSync(l), { contentType: 'video/mp4', upsert: true }); if (error) throw error; }

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Worker listening on port ${PORT}`));
