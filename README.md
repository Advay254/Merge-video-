# Vertical Video API

Complete backend for processing vertical videos in TikTok 9:16 format with subtitles, audio mixing, watermarking, and queue system.

## Features

✅ 3 input methods: base64, file upload, URL download  
✅ Vertical layout merging (A_top_B_bottom, A_left_B_right)  
✅ TikTok 9:16 format (1080x1920)  
✅ Subtitle generation with Whisper Tiny  
✅ Audio mixing with BGM  
✅ Watermarking  
✅ Metadata extraction  
✅ Thumbnail generation  
✅ Job queue system for Render free tier  
✅ Base64 and download link outputs  

---

## Quick Start

### Local Development

1. **Install dependencies:**
```bash
npm install
```

2. **Install system requirements:**
```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install ffmpeg python3 python3-pip
pip3 install openai-whisper

# macOS
brew install ffmpeg python3
pip3 install openai-whisper
```

3. **Add BGM files:**
Place royalty-free music files in the `bgm/` folder:
```
bgm/
  ├── track1.mp3
  ├── track2.mp3
  └── track3.mp3
```

4. **Start server:**
```bash
npm start
```

Server runs on `http://localhost:3000`

---

## Deploy to Render

### Step 1: Prepare Repository

1. Create a new GitHub repository
2. Upload these files:
   - `server.js`
   - `package.json`
   - `Dockerfile`
   - `README.md`
3. Add BGM files to `bgm/` folder
4. Commit and push

### Step 2: Deploy on Render

1. Go to [render.com](https://render.com)
2. Click **New +** → **Web Service**
3. Connect your GitHub repository
4. Configure:
   - **Name:** vertical-video-api
   - **Environment:** Docker
   - **Plan:** Free
   - **Docker Build Context Directory:** Leave empty
   - **Docker Command:** Leave default
5. Click **Create Web Service**

### Step 3: Wait for Deployment

Render will:
- Build the Docker image
- Install FFmpeg and Whisper
- Start the server
- Provide a public URL like: `https://vertical-video-api.onrender.com`

⚠️ **Free tier sleeps after 15 minutes of inactivity**  
The queue system persists jobs to disk, so they survive restarts.

---

## API Endpoints

### 1️⃣ Process Video (Main Endpoint)

**POST** `/api/process`

Creates a job and returns job_id immediately.

**Body (JSON):**
```json
{
  "videoA_base64": "base64_string_here",
  "videoB_url": "https://example.com/video.mp4",
  "layout": "A_top_B_bottom",
  "platform": "tiktok"
}
```

**OR File Upload (multipart/form-data):**
```
videoA_file: [file]
videoB_file: [file]
layout: A_top_B_bottom
platform: tiktok
```

**Response:**
```json
{
  "job_id": "abc123def456"
}
```

**Input Options:**
- `videoA_base64` / `videoB_base64` - Base64 encoded video
- `videoA_file` / `videoB_file` - File upload
- `videoA_url` / `videoB_url` - Download from URL

**Layouts:**
- `A_top_B_bottom` - Vertical stack (A on top, B on bottom)
- `A_left_B_right` - Horizontal split (A left, B right)

**Platform:**
- `tiktok` - 1080x1920 (9:16) output

---

### 2️⃣ Check Job Status

**GET** `/api/job/:job_id`

**Response (Processing):**
```json
{
  "job_id": "abc123def456",
  "status": "processing",
  "progress": 45
}
```

**Response (Completed):**
```json
{
  "job_id": "abc123def456",
  "status": "completed",
  "progress": 100,
  "result": {
    "video_url": "/download/abc123def456_final.mp4",
    "video_base64": "base64_encoded_video...",
    "metadata": {
      "duration": 30.5,
      "width": 1080,
      "height": 1920,
      "fps": 30,
      "audio_bitrate": 192,
      "aspect_ratio": "0.56",
      "file_size": 15728640
    },
    "thumbnail_base64": "base64_encoded_image...",
    "thumbnail_url": "/download/abc123def456_thumb.jpg",
    "subtitle_text": "1\n00:00:00,000 --> 00:00:03,000\nHello world..."
  }
}
```

**Response (Failed):**
```json
{
  "job_id": "abc123def456",
  "status": "failed",
  "progress": 0,
  "error": "Error message here"
}
```

---

### 3️⃣ Get Video Metadata

**POST** `/api/metadata`

**Body (JSON with base64):**
```json
{
  "video_base64": "base64_string_here"
}
```

**OR (JSON with URL):**
```json
{
  "video_url": "https://example.com/video.mp4"
}
```

**OR (File upload):**
```
video_file: [file]
```

**Response:**
```json
{
  "duration": 30.5,
  "width": 1080,
  "height": 1920,
  "fps": 30,
  "audio_bitrate": 128,
  "aspect_ratio": "0.56",
  "file_size": 15728640
}
```

---

### 4️⃣ Download File

**GET** `/download/:filename`

Downloads the processed video or thumbnail.

Example:
```
GET /download/abc123def456_final.mp4
GET /download/abc123def456_thumb.jpg
```

---

## n8n Integration

### Example 1: Process with URLs

**HTTP Request Node:**
- Method: POST
- URL: `https://your-render-url.onrender.com/api/process`
- Body: JSON
```json
{
  "videoA_url": "https://example.com/video1.mp4",
  "videoB_url": "https://example.com/video2.mp4",
  "layout": "A_top_B_bottom",
  "platform": "tiktok"
}
```

**Output:** `{ "job_id": "abc123" }`

### Example 2: Check Job Status

**HTTP Request Node:**
- Method: GET
- URL: `https://your-render-url.onrender.com/api/job/{{$json.job_id}}`

**Use Loop Until Status = "completed"**

### Example 3: Get Metadata

**HTTP Request Node:**
- Method: POST
- URL: `https://your-render-url.onrender.com/api/metadata`
- Body: JSON
```json
{
  "video_url": "https://example.com/video.mp4"
}
```

---

## Processing Flow

1. **Video A** (main video) - determines final length
2. **Video B** (secondary) - looped or trimmed to match Video A
3. **Audio extraction** from Video A
4. **BGM selection** - random track from `bgm/` folder
5. **Audio mixing** - Video A audio + BGM at 25% volume
6. **Subtitle generation** - Whisper Tiny on Video A audio
7. **Layout merging** - Stack videos based on layout parameter
8. **Subtitle burning** - Add subtitles to video
9. **Watermark** - Add "𝘼𝙙𝙫𝙖𝙮254" bottom right
10. **Thumbnail** - Extract random frame from Video A
11. **Output** - 1080x1920 MP4 with mixed audio

---

## Watermark Details

- Text: **𝘼𝙙𝙫𝙖𝙮254**
- Position: Bottom right corner
- Rotation: 10 degrees
- Transparency: 60% (white@0.6)
- Background box: Semi-transparent black

---

## Queue System

Jobs are saved to disk in `jobs/` folder as JSON files:
```
jobs/
  ├── abc123.json
  ├── def456.json
  └── ghi789.json
```

This allows:
- Jobs survive Render server sleep
- Jobs persist across restarts
- Status tracking across sessions

---

## File Cleanup

Temporary files are automatically deleted after processing:
- Input videos
- Extracted audio
- Intermediate merged videos
- Subtitle files

Only kept permanently:
- Final output video
- Thumbnail
- Job metadata JSON

---

## Troubleshooting

### Server won't start
- Check FFmpeg: `ffmpeg -version`
- Check Whisper: `whisper --help`
- Install missing dependencies

### Whisper fails silently
- This is by design
- Videos will process without subtitles if Whisper fails
- Check logs for Whisper errors

### Jobs stuck in "queued"
- Check server logs
- Restart server
- Jobs will resume from disk

### File size limits
- Max upload: 500MB per file
- For larger files, use URL input method

---

## Environment Variables

Optional configuration:

```bash
PORT=3000  # Server port (default: 3000)
```

---

## License

MIT

---

## Support

For issues or questions, check server logs:
```bash
# On Render
Logs tab in dashboard

# Local
npm start (shows console output)
```
