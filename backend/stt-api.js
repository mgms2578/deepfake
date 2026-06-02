const express = require('express');
const router = express.Router();
const multer = require('multer');
const https = require('https');
const FormData = require('form-data');
require('dotenv').config();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

/**
 * POST /api/stt
 * 오디오 파일을 받아 gpt-4o-mini-transcribe 모델로 STT 수행 후 반환
 */
router.post('/', upload.single('audio'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No audio file provided' });
    }

    try {
        const form = new FormData();
        // 프론트에서 넘어온 Blob 데이터를 버퍼로 맵핑
        form.append('file', req.file.buffer, {
            filename: 'audio.webm',
            contentType: req.file.mimetype || 'audio/webm'
        });
        
        // 🚀 테스트에서 확정한 모델명 적용
        form.append('model', 'gpt-4o-mini-transcribe'); 
        form.append('language', 'ko');

        const requestOptions = {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                ...form.getHeaders()
            }
        };

        const openaiReq = https.request('https://api.openai.com/v1/audio/transcriptions', requestOptions, (openaiRes) => {
            let body = '';
            openaiRes.on('data', chunk => body += chunk);
            openaiRes.on('end', () => {
                if (openaiRes.statusCode >= 400) {
                    console.error("[STT Error]", body);
                    return res.status(openaiRes.statusCode).json({ error: 'OpenAI API Error', details: body });
                }
                
                try {
                    const data = JSON.parse(body);
                    res.json({ success: true, text: data.text });
                } catch (e) {
                    console.error("[STT Parse Error]", e);
                    res.status(500).json({ error: 'Failed to parse OpenAI response' });
                }
            });
        });

        openaiReq.on('error', (e) => {
            console.error("[STT Request Error]", e);
            res.status(500).json({ error: 'Network error to OpenAI API' });
        });

        form.pipe(openaiReq);

    } catch (e) {
        console.error('STT Global Error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.use((error, req, res, next) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Uploaded STT file is too large' });
    }
    return next(error);
});

module.exports = router;
