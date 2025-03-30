const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Temporary storage for converted files
const tempStorage = {};

// ======================
// FFmpeg Verification
// ======================
console.log("🔍 Checking FFmpeg installation...");
exec('ffmpeg -version', (error, stdout, stderr) => {
  if (error) {
    console.error('❌ FFmpeg is NOT available. Please:');
    console.error('1. Open the "Packages" sidebar in Replit (cube icon)');
    console.error('2. Search for "ffmpeg"');
    console.error('3. Click "Add Package"');
    console.error('4. Restart your repl');
    process.exit(1);
  } else {
    const versionLine = stdout.split('\n')[0];
    console.log(`✅ ${versionLine}`);
    console.log('ℹ️ FFmpeg is ready for HLS conversions');
  }
});

// ======================
// File Cleanup System
// ======================
function cleanupOldFiles() {
  const now = Date.now();
  let deletedCount = 0;

  for (const [id, file] of Object.entries(tempStorage)) {
    if (now - file.timestamp > 3600000) { // 1 hour
      try {
        fs.unlinkSync(file.path);
        delete tempStorage[id];
        deletedCount++;
      } catch (err) {
        console.error('⚠️ Error cleaning up file:', err.message);
      }
    }
  }

  if (deletedCount > 0) {
    console.log(`🧹 Cleaned up ${deletedCount} temporary files`);
  }
}

// Run cleanup every hour
setInterval(cleanupOldFiles, 3600000);

// ======================
// API Endpoints
// ======================

// Get video info from Rutube
app.post('/download', async (req, res) => {
  try {
    const { url } = req.body;

    // Validate URL
    if (!url || !url.includes('rutube.ru/video/')) {
      return res.status(400).json({ 
        error: 'Invalid URL',
        message: 'Please provide a valid Rutube video URL (e.g., https://rutube.ru/video/...)'
      });
    }

    // Extract video ID (32-character hash)
    const videoId = url.match(/rutube\.ru\/video\/([a-f0-9]{32})/)?.[1];
    if (!videoId) {
      return res.status(400).json({ 
        error: 'Invalid video ID',
        message: 'Could not extract video ID from URL'
      });
    }

    // Fetch video metadata
    const metadataUrl = `https://rutube.ru/api/play/options/${videoId}/?no_404=true&referer=https%3A%2F%2Frutube.ru`;
    const { data } = await axios.get(metadataUrl, {
      headers: {
        'Referer': 'https://rutube.ru',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 10000 // 10 second timeout
    });

    if (!data?.video_balancer?.m3u8) {
      return res.status(404).json({ 
        error: 'Stream not found',
        message: 'Could not find playable video stream'
      });
    }

    // Return video info
    res.json({
      success: true,
      title: data.title || 'Untitled Video',
      thumbnail: data.thumbnail_url,
      m3u8Url: data.video_balancer.m3u8,
      duration: data.duration,
      originalUrl: url
    });

  } catch (error) {
    console.error('⚠️ Error fetching video:', error.message);

    let status = 500;
    let message = 'Failed to process video';

    if (error.response?.status) {
      status = error.response.status;
      if (status === 404) message = 'Video not found';
    }

    res.status(status).json({ 
      error: message,
      details: error.message
    });
  }
});

// Convert HLS to MP4
app.post('/convert-hls', (req, res) => {
  const { m3u8Url } = req.body;

  if (!m3u8Url) {
    return res.status(400).json({ 
      error: 'Missing URL',
      message: 'No M3U8 URL provided'
    });
  }

  const conversionId = Date.now().toString();
  const outputFile = path.join(__dirname, 'temp', `converted-${conversionId}.mp4`);

  // Create temp directory if needed
  if (!fs.existsSync(path.join(__dirname, 'temp'))) {
    fs.mkdirSync(path.join(__dirname, 'temp'));
  }

  console.log(`🔄 Starting conversion: ${m3u8Url.substring(0, 50)}...`);

  const ffmpeg = exec(
    `ffmpeg -i "${m3u8Url}" -c copy -bsf:a aac_adtstoasc "${outputFile}"`,
    { timeout: 300000 } // 5 minute timeout
  );

  // Log FFmpeg output for debugging
  ffmpeg.stdout.on('data', (data) => console.log('FFmpeg:', data.toString()));
  ffmpeg.stderr.on('data', (data) => console.log('FFmpeg:', data.toString()));

  ffmpeg.on('close', (code) => {
    if (code !== 0) {
      console.error('❌ Conversion failed with code:', code);
      return res.status(500).json({ 
        error: 'Conversion failed',
        message: 'FFmpeg process exited with error'
      });
    }

    console.log('✅ Conversion successful:', outputFile);
    tempStorage[conversionId] = {
      path: outputFile,
      timestamp: Date.now()
    };

    res.json({ 
      success: true,
      downloadUrl: `/download-converted/${conversionId}`,
      expiresAt: Date.now() + 3600000 // 1 hour from now
    });
  });
});

// Download converted file
app.get('/download-converted/:id', (req, res) => {
  const file = tempStorage[req.params.id];

  if (!file) {
    return res.status(404).json({ 
      error: 'File not found',
      message: 'The file either expired or was already downloaded'
    });
  }

  const filename = `rutube-video-${req.params.id}.mp4`;

  res.download(file.path, filename, (err) => {
    if (err) {
      console.error('⚠️ Download failed:', err.message);
      // Don't send response as res.download already handles it
    }
  });
});

// ======================
// Server Startup
// ======================
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log('🔧 Make sure you:');
  console.log('1. Added FFmpeg via Replit Packages');
  console.log('2. Restarted your repl after adding FFmpeg');
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err.message);
  console.error('Stack:', err.stack);
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
});
