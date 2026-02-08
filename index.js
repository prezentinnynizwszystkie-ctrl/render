// Zaktualizowany worker z logowaniem postępów
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

app.post('/process', async (req, res) => {
  const { projectId } = req.body; 
  res.send({ status: 'started' });
  processVideo(projectId);
});

async function updateStatus(id, status, msg) {
    await supabase.from('story_orders').update({ status, status_message: msg }).eq('order_id', id);
}

async function processVideo(id) {
    try {
        await updateStatus(id, 'processing', 'Pobieranie plików...');
        // ... logika pobierania i montażu ...
        await updateStatus(id, 'processing', 'Renderowanie Ch 1...');
        // ... ffmpeg command ...
        await updateStatus(id, 'processing', 'Upload wyników...');
        await updateStatus(id, 'completed', 'Gotowe!');
    } catch(e) {
        await updateStatus(id, 'error', e.message);
    }
}

app.listen(process.env.PORT || 3000);
