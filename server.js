const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// Setup directories
const TEMP_DIR = path.join(__dirname, 'temp');
const BGM_DIR = path.join(__dirname, 'bgm');
const JOBS_DIR = path.join(__dirname, 'jobs');
const OUTPUT_DIR = path.join(__dirname, 'output');

[TEMP_DIR, BGM_DIR, JOBS_DIR, OUTPUT_DIR].forEach(dir => {
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
});

// Setup multer for file uploads
const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

// Job queue (file-based persistence)
const jobQueue = new Map();

// Load jobs from disk on startup
async function loadJobs() {
  try {
    const files = await fs.readdir(JOBS_DIR);
    const oneMinuteAgo = Date.now() - 60000;
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(JOBS_DIR, file);
        const data = await fs.readFile(filePath, 'utf8');
        const job = JSON.parse(data);
        
        // Check if job is completed and older than 1 minute
        if (job.status === 'completed' && job.completed_at) {
          const completedTime = new Date(job.completed_at).getTime();
          if (completedTime < oneMinuteAgo) {
            // Delete old completed job files
            const jobId = job.job_id;
            const videoPath = path.join(OUTPUT_DIR, `${jobId}_final.mp4`);
            const thumbPath = path.join(OUTPUT_DIR, `${jobId}_thumb.jpg`);
            
            if (fsSync.existsSync(videoPath)) await fs.unlink(videoPath);
            if (fsSync.existsSync(thumbPath)) await fs.unlink(thumbPath);
            if (fsSync.existsSync(filePath)) await fs.unlink(filePath);
            
            console.log(`Startup cleanup: Deleted old job ${jobId}`);
            continue;
          }
        }
        
        // Load job into queue
        jobQueue.set(job.job_id, job);
      }
    }
  } catch (error) {
    console.error('Error loading jobs:', error);
  }
}

// Save job to disk
async function saveJob(job) {
  await fs.writeFile(
    path.join(JOBS_DIR, `${job.job_id}.json`),
    JSON.stringify(job, null, 2)
  );
  jobQueue.set(job.job_id, job);
}

// Helper: Download file from URL
async function downloadFile(url, outputPath) {
  const response = await axios({
    method: 'get',
    url: url,
    responseType: 'stream'
  });
  
  const writer = fsSync.createWriteStream(outputPath);
  response.data.pipe(writer);
  
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Helper: Get random BGM file
async function getRandomBGM() {
  const files = await fs.readdir(BGM_DIR);
  const audioFiles = files.filter(f => 
    f.endsWith('.mp3') || f.endsWith('.wav') || f.endsWith('.m4a')
  );
  
  if (audioFiles.length === 0) {
    return null;
  }
  
  const randomFile = audioFiles[Math.floor(Math.random() * audioFiles.length)];
  return path.join(BGM_DIR, randomFile);
}

// Helper: Execute FFmpeg command
function executeFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args);
    let stderr = '';
    
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(stderr);
      } else {
        reject(new Error(`FFmpeg failed: ${stderr}`));
      }
    });
    
    ffmpeg.on('error', (error) => {
      reject(error);
    });
  });
}

// Helper: Get video metadata
async function getMetadata(videoPath) {
  const args = [
    '-i', videoPath,
    '-hide_banner'
  ];
  
  try {
    await executeFFmpeg(args);
  } catch (error) {
    const output = error.message;
    
    const durationMatch = output.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
    const videoMatch = output.match(/Video: .*, (\d+)x(\d+)/);
    const fpsMatch = output.match(/(\d+(?:\.\d+)?) fps/);
    const audioBitrateMatch = output.match(/Audio: .*, (\d+) kb\/s/);
    
    const stats = await fs.stat(videoPath);
    
    let duration = 0;
    if (durationMatch) {
      duration = parseInt(durationMatch[1]) * 3600 + 
                 parseInt(durationMatch[2]) * 60 + 
                 parseFloat(durationMatch[3]);
    }
    
    const width = videoMatch ? parseInt(videoMatch[1]) : 0;
    const height = videoMatch ? parseInt(videoMatch[2]) : 0;
    const aspectRatio = width && height ? (width / height).toFixed(2) : 0;
    
    return {
      duration: duration,
      width: width,
      height: height,
      fps: fpsMatch ? parseFloat(fpsMatch[1]) : 0,
      audio_bitrate: audioBitrateMatch ? parseInt(audioBitrateMatch[1]) : 0,
      aspect_ratio: aspectRatio,
      file_size: stats.size
    };
  }
}

// Helper: Extract thumbnail
async function extractThumbnail(videoPath, outputPath, timePercent = 0.3) {
  const metadata = await getMetadata(videoPath);
  const time = metadata.duration * timePercent;
  
  const args = [
    '-ss', time.toString(),
    '-i', videoPath,
    '-vframes', '1',
    '-q:v', '2',
    outputPath,
    '-y'
  ];
  
  await executeFFmpeg(args);
}

// Helper: Generate subtitles with Whisper
async function generateSubtitles(audioPath, outputSrtPath) {
  return new Promise((resolve, reject) => {
    const whisper = spawn('whisper', [
      audioPath,
      '--model', 'tiny',
      '--output_format', 'srt',
      '--output_dir', path.dirname(outputSrtPath)
    ]);
    
    whisper.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        // Silently fail
        resolve();
      }
    });
    
    whisper.on('error', () => {
      // Silently fail
      resolve();
    });
  });
}

// Main processing function
async function processVideo(job) {
  const jobId = job.job_id;
  const layout = job.layout;
  const videoAPath = job.videoA_path;
  const videoBPath = job.videoB_path;
  
  try {
    // Update progress
    job.status = 'processing';
    job.progress = 10;
    await saveJob(job);
    
    // Get metadata for Video A
    const metadataA = await getMetadata(videoAPath);
    const durationA = metadataA.duration;
    
    // Extract audio from Video A
    const audioAPath = path.join(TEMP_DIR, `${jobId}_audioA.aac`);
    await executeFFmpeg([
      '-i', videoAPath,
      '-vn',
      '-acodec', 'aac',
      audioAPath,
      '-y'
    ]);
    
    job.progress = 20;
    await saveJob(job);
    
    // Generate subtitles
    const srtPath = path.join(TEMP_DIR, `${jobId}.srt`);
    await generateSubtitles(audioAPath, srtPath);
    
    job.progress = 30;
    await saveJob(job);
    
    // Get BGM
    const bgmPath = await getRandomBGM();
    
    // Mix audio
    const mixedAudioPath = path.join(TEMP_DIR, `${jobId}_mixed.aac`);
    if (bgmPath) {
      await executeFFmpeg([
        '-i', audioAPath,
        '-i', bgmPath,
        '-filter_complex',
        `[0:a]volume=1.0[a0];[1:a]volume=0.25[a1];[a0][a1]amix=inputs=2:duration=first`,
        '-ac', '2',
        mixedAudioPath,
        '-y'
      ]);
    } else {
      await fs.copyFile(audioAPath, mixedAudioPath);
    }
    
    job.progress = 40;
    await saveJob(job);
    
    // Process videos based on layout
    const tempMergedPath = path.join(TEMP_DIR, `${jobId}_merged.mp4`);
    
    // TikTok dimensions
    const outputWidth = 1080;
    const outputHeight = 1920;
    
    if (layout === 'A_top_B_bottom') {
      // Vertical stack
      const halfHeight = outputHeight / 2;
      
      await executeFFmpeg([
        '-i', videoAPath,
        '-i', videoBPath,
        '-filter_complex',
        `[0:v]scale=${outputWidth}:${halfHeight}:force_original_aspect_ratio=decrease,pad=${outputWidth}:${halfHeight}:(ow-iw)/2:(oh-ih)/2[top];` +
        `[1:v]scale=${outputWidth}:${halfHeight}:force_original_aspect_ratio=decrease,pad=${outputWidth}:${halfHeight}:(ow-iw)/2:(oh-ih)/2,` +
        `loop=loop=-1:size=1:start=0,setpts=N/FRAME_RATE/TB[bottom_loop];` +
        `[top][bottom_loop]vstack=inputs=2[stacked];` +
        `[stacked]trim=duration=${durationA}[v]`,
        '-map', '[v]',
        '-t', durationA.toString(),
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        tempMergedPath,
        '-y'
      ]);
    } else if (layout === 'A_left_B_right') {
      // Horizontal stack
      const halfWidth = outputWidth / 2;
      
      await executeFFmpeg([
        '-i', videoAPath,
        '-i', videoBPath,
        '-filter_complex',
        `[0:v]scale=${halfWidth}:${outputHeight}:force_original_aspect_ratio=decrease,pad=${halfWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2[left];` +
        `[1:v]scale=${halfWidth}:${outputHeight}:force_original_aspect_ratio=decrease,pad=${halfWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,` +
        `loop=loop=-1:size=1:start=0,setpts=N/FRAME_RATE/TB[right_loop];` +
        `[left][right_loop]hstack=inputs=2[stacked];` +
        `[stacked]trim=duration=${durationA}[v]`,
        '-map', '[v]',
        '-t', durationA.toString(),
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        tempMergedPath,
        '-y'
      ]);
    }
    
    job.progress = 60;
    await saveJob(job);
    
    // Add subtitles if they exist
    const tempWithSubsPath = path.join(TEMP_DIR, `${jobId}_subs.mp4`);
    if (fsSync.existsSync(srtPath)) {
      const srtEscaped = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
      await executeFFmpeg([
        '-i', tempMergedPath,
        '-vf', `subtitles=${srtEscaped}`,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        tempWithSubsPath,
        '-y'
      ]);
    } else {
      await fs.copyFile(tempMergedPath, tempWithSubsPath);
    }
    
    job.progress = 75;
    await saveJob(job);
    
    // Add watermark
    const finalOutputPath = path.join(OUTPUT_DIR, `${jobId}_final.mp4`);
    await executeFFmpeg([
      '-i', tempWithSubsPath,
      '-i', mixedAudioPath,
      '-filter_complex',
      `[0:v]drawtext=text='𝘼𝙙𝙫𝙖𝙮254':fontsize=24:fontcolor=white@0.6:x=w-tw-20:y=h-th-20:enable='between(t,0,${durationA})':box=1:boxcolor=black@0.3:boxborderw=5,rotate=10*PI/180:c=none:ow=rotw(10*PI/180):oh=roth(10*PI/180)[v]`,
      '-map', '[v]',
      '-map', '1:a',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-pix_fmt', 'yuv420p',
      finalOutputPath,
      '-y'
    ]);
    
    job.progress = 90;
    await saveJob(job);
    
    // Extract thumbnail
    const thumbnailPath = path.join(OUTPUT_DIR, `${jobId}_thumb.jpg`);
    await extractThumbnail(videoAPath, thumbnailPath);
    
    // Get final metadata
    const finalMetadata = await getMetadata(finalOutputPath);
    
    // Convert to base64
    const videoBuffer = await fs.readFile(finalOutputPath);
    const videoBase64 = videoBuffer.toString('base64');
    
    const thumbBuffer = await fs.readFile(thumbnailPath);
    const thumbBase64 = thumbBuffer.toString('base64');
    
    // Read subtitle text
    let subtitleText = '';
    if (fsSync.existsSync(srtPath)) {
      subtitleText = await fs.readFile(srtPath, 'utf8');
    }
    
    // Update job with results
    job.status = 'completed';
    job.progress = 100;
    job.completed_at = new Date().toISOString();
    job.result = {
      video_url: `/download/${jobId}_final.mp4`,
      video_base64: videoBase64,
      metadata: finalMetadata,
      thumbnail_base64: thumbBase64,
      thumbnail_url: `/download/${jobId}_thumb.jpg`,
      subtitle_text: subtitleText
    };
    
    await saveJob(job);
    
    // Schedule auto-deletion after 1 minute
    setTimeout(async () => {
      try {
        // Delete output files
        if (fsSync.existsSync(finalOutputPath)) {
          await fs.unlink(finalOutputPath);
        }
        if (fsSync.existsSync(thumbnailPath)) {
          await fs.unlink(thumbnailPath);
        }
        
        // Delete job metadata
        const jobFilePath = path.join(JOBS_DIR, `${jobId}.json`);
        if (fsSync.existsSync(jobFilePath)) {
          await fs.unlink(jobFilePath);
        }
        
        // Remove from memory
        jobQueue.delete(jobId);
        
        console.log(`Auto-deleted files for job ${jobId}`);
      } catch (error) {
        console.error(`Error auto-deleting job ${jobId}:`, error);
      }
    }, 60000); // 60000ms = 1 minute
    
    // Cleanup temp files
    const tempFiles = [
      videoAPath,
      videoBPath,
      audioAPath,
      mixedAudioPath,
      tempMergedPath,
      tempWithSubsPath,
      srtPath
    ];
    
    for (const file of tempFiles) {
      try {
        if (fsSync.existsSync(file)) {
          await fs.unlink(file);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    await saveJob(job);
  }
}

// Helper: Handle video input
async function handleVideoInput(req, inputName) {
  const jobId = crypto.randomBytes(16).toString('hex');
  const outputPath = path.join(TEMP_DIR, `${jobId}_${inputName}.mp4`);
  
  // Check for base64
  if (req.body[`${inputName}_base64`]) {
    const base64Data = req.body[`${inputName}_base64`].replace(/^data:video\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    await fs.writeFile(outputPath, buffer);
    return outputPath;
  }
  
  // Check for file upload
  if (req.files && req.files[inputName]) {
    await fs.copyFile(req.files[inputName][0].path, outputPath);
    await fs.unlink(req.files[inputName][0].path);
    return outputPath;
  }
  
  // Check for URL
  if (req.body[`${inputName}_url`]) {
    await downloadFile(req.body[`${inputName}_url`], outputPath);
    return outputPath;
  }
  
  throw new Error(`No input provided for ${inputName}`);
}

// Routes

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok',
    message: 'Vertical Video API',
    endpoints: {
      process: 'POST /api/process',
      job: 'GET /api/job/:id',
      metadata: 'POST /api/metadata',
      download: 'GET /download/:filename'
    }
  });
});

// Main processing endpoint
app.post('/api/process', upload.fields([
  { name: 'videoA_file', maxCount: 1 },
  { name: 'videoB_file', maxCount: 1 }
]), async (req, res) => {
  try {
    const layout = req.body.layout || 'A_top_B_bottom';
    const platform = req.body.platform || 'tiktok';
    
    // Validate inputs
    if (!['A_top_B_bottom', 'A_left_B_right'].includes(layout)) {
      return res.status(400).json({ error: 'Invalid layout' });
    }
    
    if (platform !== 'tiktok') {
      return res.status(400).json({ error: 'Only tiktok platform is supported' });
    }
    
    // Handle video inputs
    const videoAPath = await handleVideoInput(req, 'videoA');
    const videoBPath = await handleVideoInput(req, 'videoB');
    
    // Create job
    const jobId = crypto.randomBytes(16).toString('hex');
    const job = {
      job_id: jobId,
      status: 'queued',
      progress: 0,
      layout: layout,
      platform: platform,
      videoA_path: videoAPath,
      videoB_path: videoBPath,
      created_at: new Date().toISOString()
    };
    
    await saveJob(job);
    
    // Start processing asynchronously
    processVideo(job);
    
    res.json({ job_id: jobId });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get job status
app.get('/api/job/:id', async (req, res) => {
  try {
    const jobId = req.params.id;
    const job = jobQueue.get(jobId);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    const response = {
      job_id: job.job_id,
      status: job.status,
      progress: job.progress
    };
    
    if (job.status === 'completed' && job.result) {
      response.result = job.result;
    }
    
    if (job.status === 'failed' && job.error) {
      response.error = job.error;
    }
    
    res.json(response);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Metadata endpoint
app.post('/api/metadata', upload.single('video_file'), async (req, res) => {
  try {
    let videoPath;
    
    // Handle base64
    if (req.body.video_base64) {
      const jobId = crypto.randomBytes(16).toString('hex');
      videoPath = path.join(TEMP_DIR, `${jobId}_meta.mp4`);
      const base64Data = req.body.video_base64.replace(/^data:video\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      await fs.writeFile(videoPath, buffer);
    }
    // Handle file upload
    else if (req.file) {
      videoPath = req.file.path;
    }
    // Handle URL
    else if (req.body.video_url) {
      const jobId = crypto.randomBytes(16).toString('hex');
      videoPath = path.join(TEMP_DIR, `${jobId}_meta.mp4`);
      await downloadFile(req.body.video_url, videoPath);
    }
    else {
      return res.status(400).json({ error: 'No video input provided' });
    }
    
    const metadata = await getMetadata(videoPath);
    
    // Cleanup
    await fs.unlink(videoPath);
    
    res.json(metadata);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Download endpoint
app.get('/download/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(OUTPUT_DIR, filename);
    
    if (!fsSync.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    res.download(filePath);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
loadJobs().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
