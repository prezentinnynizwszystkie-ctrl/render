const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const WORK_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR);

app.post('/process', async (req, res) => {
  const { projectId } = req.body; // projectId to tutaj order_id z bazy
  
  if (!projectId) return res.status(400).send('Brak projectId (order_id)');
  
  res.send({ status: 'started', message: `Start montażu dla orderu: ${projectId}` });

  processVideo(projectId).catch(err => {
    console.error(`CRITICAL ERROR [${projectId}]:`, err);
  });
});

async function processVideo(orderId) {
  const dir = path.join(WORK_DIR, orderId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);

  try {
    console.log(`[${orderId}] 1. Pobieranie danych o zamówieniu z DB...`);
    
    // 1. POBRANIE METADANYCH Z TABELI story_orders
    const { data: order, error: dbError } = await supabase
        .from('story_orders')
        .select('partner_name, story_title, recipient_sex')
        .eq('order_id', orderId)
        .single();

    if (dbError || !order) throw new Error(`Nie znaleziono order_id ${orderId} w bazie: ${dbError?.message}`);
    
    const { partner_name, story_title, recipient_sex } = order;
    console.log(`[${orderId}] Dane: Partner=${partner_name}, Story=${story_title}, Sex=${recipient_sex}`);

    // 2. DEFINICJA ŚCIEŻEK DO PLIKÓW (Zgodnie z Twoim schematem)
    const bucket = 'stories';
    const basePath = `${partner_name}/${story_title}`; 
    
    // Mapa plików wejściowych
    const files = {
        '1.mp4': {
            // Bezpośrednio w katalogu story_title
            path: `${basePath}/background_video_chapter1_${story_title}_${partner_name}_${recipient_sex}.mp4`,
            local: '1.mp4'
        },
        '1.mp3': {
            // W katalogu [story_title]/[partner_name]/[order_id]
            path: `${basePath}/${partner_name}/${orderId}/chapter_1.mp3`,
            local: '1.mp3'
        },
        '2.mp3': {
            // Muzyka tła Rozdział 1
            path: `${basePath}/music_backgrounds/background_audio_chapter1_${story_title}.mp3`,
            local: '2.mp3'
        },
        '1.png': {
            // User image
            path: `${basePath}/${partner_name}/${orderId}/user_img_${orderId}.png`,
            local: '1.png'
        },
        '1A.mp4': {
            // End video chapter 1
            path: `${basePath}/end_video_chapter1_${story_title}_${partner_name}_${recipient_sex}.mp4`,
            local: '1A.mp4'
        },
        '2.mp4': {
            // Bg video chapter 2
            path: `${basePath}/background_video_chapter2_${story_title}_${partner_name}_${recipient_sex}.mp4`,
            local: '2.mp4'
        },
        '3.mp3': {
            // Voiceover chapter 2
            path: `${basePath}/${partner_name}/${orderId}/chapter_2.mp3`,
            local: '3.mp3'
        },
        '4.mp3': {
             // Muzyka tła Rozdział 2 (NOWY PLIK)
             path: `${basePath}/music_backgrounds/background_audio_chapter2_${story_title}.mp3`,
             local: '4.mp3'
        },
        '3.mp4': {
            // Music video (End of Ch2)
            path: `${basePath}/music_video_${story_title}_${partner_name}_${recipient_sex}.mp4`,
            local: '3.mp4'
        }
    };

    // 3. POBIERANIE PLIKÓW
    console.log(`[${orderId}] Pobieranie plików...`);
    for (const [key, conf] of Object.entries(files)) {
        console.log(`   -> Pobieram ${conf.path}`);
        const { data, error } = await supabase.storage
            .from(bucket)
            .download(conf.path);
        
        if (error) throw new Error(`Błąd pobierania ${key} (${conf.path}): ${error.message}`);
        fs.writeFileSync(path.join(dir, conf.local), Buffer.from(await data.arrayBuffer()));
    }

    // 4. MONTAŻ - ROZDZIAŁ 1
    console.log(`[${orderId}] Renderowanie Rozdziału 1...`);
    const durationLektor1 = await getDuration(path.join(dir, '1.mp3'));
    const ch1Part1 = path.join(dir, 'temp_ch1_part1.mp4');

    await runFFmpegCommand(
       ffmpeg()
        .input(path.join(dir, '1.mp4')) // 0
        .input(path.join(dir, '1.png')) // 1
        .input(path.join(dir, '1.mp3')) // 2 (Lektor)
        .input(path.join(dir, '2.mp3')) // 3 (Muzyka)
        .complexFilter([
           `[1:v]loop=loop=-1:size=2:start=0[imgloop]`,
           `[0:v][imgloop]concat=n=2:v=1:a=0[videobase]`,
           `[videobase]trim=duration=${durationLektor1}[vfinal]`,
           // USUNIĘTO: [3:a]volume=0.3[bgmusic] -> Muzyka leci w oryginale
           `[2:a][3:a]amix=inputs=2:duration=first[afinal]` // Mix bezpośrednio
        ])
        .outputOptions(['-map [vfinal]', '-map [afinal]', '-c:v libx264', '-c:a aac', '-shortest'])
        .save(ch1Part1)
    );

    const ch1Final = path.join(dir, 'chapter1_complete.mp4');
    await concatVideos([ch1Part1, path.join(dir, '1A.mp4')], ch1Final);

    // 5. MONTAŻ - ROZDZIAŁ 2
    console.log(`[${orderId}] Renderowanie Rozdziału 2...`);
    const durationLektor2 = await getDuration(path.join(dir, '3.mp3'));
    const ch2Part1 = path.join(dir, 'temp_ch2_part1.mp4');
    
    await runFFmpegCommand(
        ffmpeg()
         .input(path.join(dir, '2.mp4')) // Input 0: Video
         .input(path.join(dir, '3.mp3')) // Input 1: Lektor
         .input(path.join(dir, '4.mp3')) // Input 2: Muzyka tła
         .complexFilter([
             // Audio mix: Lektor + Muzyka (oryginał głośność)
             // USUNIĘTO: [2:a]volume=0.3...
             `[1:a][2:a]amix=inputs=2:duration=first[afinal]`,
             // Video: Ucięcie do długości lektora
             `[0:v]trim=duration=${durationLektor2}[vfinal]`
         ])
         .outputOptions([
             '-map [vfinal]', 
             '-map [afinal]', 
             '-c:v libx264', 
             '-c:a aac'
         ])
         .save(ch2Part1)
     );

     const ch2Final = path.join(dir, 'chapter2_complete.mp4');
     await concatVideos([ch2Part1, path.join(dir, '3.mp4')], ch2Final);

     // 6. UPLOAD WYNIKÓW
     const outputBasePath = `${partner_name}/orders/${orderId}`;
     
     const outName1 = `${story_title}_${partner_name}_chapter_1.mp4`;
     const outName2 = `${story_title}_${partner_name}_chapter_2.mp4`;

     console.log(`[${orderId}] Upload do: ${outputBasePath}...`);
     
     await uploadFile(supabase, bucket, outputBasePath, ch1Final, outName1);
     await uploadFile(supabase, bucket, outputBasePath, ch2Final, outName2);

     console.log(`[${orderId}] SUKCES! Wyczyszczono pliki tymczasowe.`);
     fs.rmSync(dir, { recursive: true, force: true });

  } catch (err) {
      console.error(err);
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
  }
}

// --- POMOCNIKI ---
function getDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) reject(err);
            else resolve(metadata.format.duration);
        });
    });
}

function runFFmpegCommand(command) {
    return new Promise((resolve, reject) => {
        command
            .on('end', resolve)
            .on('error', (err) => reject(new Error('FFmpeg error: ' + err.message)))
            .run();
    });
}

async function concatVideos(filePaths, outputPath) {
    return new Promise((resolve, reject) => {
        const cmd = ffmpeg();
        filePaths.forEach(fp => cmd.input(fp));
        cmd.on('end', resolve)
           .on('error', reject)
           .mergeToFile(outputPath, path.dirname(outputPath));
    });
}

async function uploadFile(supabaseClient, bucket, pathPrefix, localPath, fileName) {
    const fileContent = fs.readFileSync(localPath);
    const { error } = await supabaseClient.storage
        .from(bucket)
        .upload(`${pathPrefix}/${fileName}`, fileContent, {
            contentType: 'video/mp4',
            upsert: true
        });
    if (error) throw error;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker listening on port ${PORT}`));