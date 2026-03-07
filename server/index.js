require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid'); // Optional, to generate unique filenames

const app = express();
const server = http.createServer(app);
// Setting up Socket.IO for real-time conversation streaming
const io = new Server(server, {
  cors: {
    origin: '*', // Set to your frontend URL in production
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Setup multer for handling file uploads (in memory)
const upload = multer({ storage: multer.memoryStorage() });

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY || ''; // allow fallback just in case
let supabase;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('Supabase client initialized');
} else {
  console.warn('Missing SUPABASE_URL or SUPABASE_SECRET_KEY environment variables.');
}

// Initialize Cloudflare R2 (S3 Client)
const rawEndpoint = process.env.CLOUDFLARE_S3_API || '';
const r2Bucket = 'hackomania-2026';
// Strip bucket name from endpoint if present to avoid duplication in Key
const r2Endpoint = rawEndpoint.endsWith(`/${r2Bucket}`) 
  ? rawEndpoint.replace(`/${r2Bucket}`, '') 
  : rawEndpoint;

const r2Client = new S3Client({
  region: 'auto',
  endpoint: r2Endpoint,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_S3_ACCESS_KEY || '',
    secretAccessKey: process.env.CLOUDFLARE_S3_SECRET_ACCESS_KEY || '',
  },
});

// Audio Utilities
function convertPCM16ToWAV(pcmBuffer, sampleRate = 24000) {
  const numChannels = 1;
  const byteRate = sampleRate * numChannels * 2;
  const blockAlign = numChannels * 2;

  const buffer = Buffer.alloc(44 + pcmBuffer.length);
  
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + pcmBuffer.length, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size
  buffer.writeUInt16LE(1, 20); // AudioFormat (PCM)
  buffer.writeUInt16LE(numChannels, 22); // NumChannels
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(byteRate, 28); // ByteRate
  buffer.writeUInt16LE(blockAlign, 32); // BlockAlign
  buffer.writeUInt16LE(16, 34); // BitsPerSample
  buffer.write('data', 36);
  buffer.writeUInt32LE(pcmBuffer.length, 40);
  
  pcmBuffer.copy(buffer, 44);
  
  return buffer;
}

// uploadToR2 helper
async function uploadToR2(buffer, fileName, mimeType) {
  const params = {
    Bucket: 'hackomania-2026', // Your bucket
    Key: fileName,
    Body: buffer,
    ContentType: mimeType,
  };
  const command = new PutObjectCommand(params);
  await r2Client.send(command);
  return `${process.env.CLOUDFLARE_PUBLIC_API}/${fileName}`;
}

// saveMessage helper
async function saveMessage(conversationId, author, text) {
  if (!supabase || !conversationId) return;

  const row = {
    conversation_id: conversationId,
    author: author,
    content: text || '',
    timestamp: getUTC8Time()
  };

  const { data, error } = await supabase.from('messages').insert([row]).select();
  
  if (error) {
    console.error('❌ Failed to save message to Supabase:', error);
  } else {
    // Supabase returns an array for select()
    const savedId = data?.[0]?.id || 'unknown';
    console.log(`✅ Saved ${author} message to Supabase DB ID: ${savedId}`);
  }
}

// saveConversationAudio helper
async function updateConversationAudio(conversationId, fileName) {
  if (!supabase || !conversationId) return;
  const { error } = await supabase.from('conversations').update({
    audio_url: fileName
  }).eq('id', conversationId);
  
  if (error) {
    console.error('❌ Failed to update conversation audio_url:', error);
  } else {
    console.log(`✅ Updated conversation ${conversationId} audio_url: ${fileName}`);
  }
}

// Helper for UTC+8 Timestamps
function getUTC8Time() {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  // Send as local time string matching the UTC+8 timezone
  return utc8.toISOString().replace('Z', '+08:00');
}

// REST Endpoints
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Node.js backend is running!' });
});

// 1) Initialize a Conversation
app.post('/api/conversations', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });

  const { start, end, triage, classification } = req.body || {};

  const { data, error } = await supabase
    .from('conversations') 
    .insert([{ 
      start: start || getUTC8Time(),
      end: end || getUTC8Time(), // Initially setting start = end
      triage: triage || 'agent', // Default to agent if not provided
      classification: classification || 'uncertain' // Default to uncertain if not provided
    }])
    .select();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data[0]);
});

// 2) Update a Conversation (e.g., when an AI model finishes classifying it)
app.patch('/api/conversations/:id', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { id } = req.params;
  const { triage, classification } = req.body;

  const updates = {};
  if (triage) updates.triage = triage;
  if (classification) updates.classification = classification;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const { data, error } = await supabase
    .from('conversations')
    .update(updates)
    .eq('id', id)
    .select();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data[0]);
});

// 3) Save a Message
app.post('/api/messages', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });

  const { conversation_id, author, content, timestamp } = req.body;

  const { data, error } = await supabase
    .from('messages') 
    .insert([
      {
        conversation_id,
        author,
        content,
        timestamp: timestamp || getUTC8Time()
      }
    ])
    .select();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data[0]);
});

// 3) Retrieve messages for a given conversation
app.get('/api/conversations/:id/messages', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });

    const { id } = req.params;
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', id)
    .order('timestamp', { ascending: true }); // using the 'timestampz' column from the schema

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// 4) Upload Audio to Cloudflare R2
app.post('/api/upload-audio', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' });
  }

  try {
    const fileExtension = req.file.originalname.split('.').pop() || 'webm'; // Fallback to webm or wav depending on frontend
    const fileName = `calls/audio-${Date.now()}-${uuidv4()}.${fileExtension}`;
    
    // We get the bucket name from the URL, but the AWS SDK usually expects it as a parameter.
    // Assuming your endpoint is configured correctly, we use a generic bucket name or extract it.
    // For Cloudflare R2, if the endpoint includes the bucket name, you often don't need a Bucket parameter, 
    // or you pass the bucket name explicitly.
    // Let's assume the bucket is 'hackomania-2026' based on your provided URL structure.
    
    const params = {
      Bucket: 'hackomania-2026', // Your bucket name
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || 'audio/webm', // Determine correct mime type
    };

    const command = new PutObjectCommand(params);
    await r2Client.send(command);

    // Construct the public URL for the uploaded file
    const publicUrl = `${process.env.CLOUDFLARE_PUBLIC_API}/${fileName}`;
    
    res.json({ message: 'Audio uploaded successfully', url: publicUrl });

  } catch (error) {
    console.error('Error uploading to R2:', error);
    res.status(500).json({ error: 'Failed to upload audio' });
  }
});

// Real-Time Socket.IO Connections (Useful for text-to-speech realtime streaming)
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  let openAiWs = null;
  let activeConversationId = null;

  // Audio buffering state
  let assistantAudioBuffer = [];
  let userAudioBuffer = [];
  let rollingBuffer = [];
  const MAX_ROLLING_CHUNKS = 20; // Keeps ~1.6 seconds of rolling historical context (4096 bytes per chunk)
  let isRecordingUser = false;
  
  // Aggregate whole conversation audio
  let fullConversationPcm = [];

  // Start an emergency voice session
  socket.on('start_emergency_session', async () => {
    if (openAiWs) {
      console.log(`[Socket ${socket.id}] WebSocket already exists.`);
      return;
    }

    if (!process.env.OPENAI_API_KEY) {
      socket.emit('session_error', 'OPENAI_API_KEY is missing on the server.');
      return;
    }

    console.log(`[Socket ${socket.id}] Starting emergency session with OpenAI`);
    
    // Auto-create a Supabase conversation on connection
    if (supabase) {
      const { data, error } = await supabase.from('conversations').insert([{
        start: getUTC8Time(),
        end: getUTC8Time(),
        triage: 'agent',
        classification: 'uncertain'
      }]).select();

      if (error) {
        console.error(`❌ [Socket ${socket.id}] Failed to create conversation in DB:`, error);
      } else if (data && data.length > 0) {
        activeConversationId = data[0].id;
        console.log(`✅ [Socket ${socket.id}] Conversation created DB ID: ${activeConversationId}`);
      }
    }

    // Connect to OpenAI Realtime API
    const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
    openAiWs = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    openAiWs.on('open', () => {
      console.log(`[Socket ${socket.id}] Connected to OpenAI Realtime API`);

      // 1. Send the initial session.update event
      const sessionUpdate = {
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          instructions: `
You are a calm emergency voice assistant helping seniors who pressed a Personal Alert Button.

Your goals:
- Speak clearly, slowly, and briefly.
- Ask what happened.
- Determine if the situation is urgent, uncertain, or non-urgent.
- Ask one question at a time.
- If the senior may be in danger, prioritise questions about breathing, bleeding, consciousness, pain, mobility, and whether they are alone.
- If the senior speaks unclearly, reassure them and ask simple follow-up questions.
- Keep your replies concise and suitable for speech.
          `.trim(),
          voice: 'alloy', // Optional: specify voice
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'whisper-1',
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.65,
            prefix_padding_ms: 300,
            silence_duration_ms: 1000,
          },
        },
      };

      openAiWs.send(JSON.stringify(sessionUpdate));
      socket.emit('session_started');
    });

    // 2. Receive responses from OpenAI
    openAiWs.on('message', (message) => {
      try {
        const event = JSON.parse(message.toString());

        switch (event.type) {
          case 'response.audio.delta':
            // Base64 decode to PCM16 ArrayBuffer
            if (event.delta) {
              const buffer = Buffer.from(event.delta, 'base64');
              assistantAudioBuffer.push(buffer);
              socket.emit('server_audio', buffer);
            }
            break;

          case 'response.audio_transcript.done':
            socket.emit('history_updated', [{
              id: event.item_id || Date.now().toString(),
              role: 'agent',
              text: event.transcript
            }]);

            // Save Agent Message & Add Audio to aggregate
            if (activeConversationId) {
              const fullPcmBuffer = Buffer.concat(assistantAudioBuffer);
              assistantAudioBuffer = []; // reset for next response
              
              if (fullPcmBuffer.length > 0) {
                fullConversationPcm.push(fullPcmBuffer);
              }
              saveMessage(activeConversationId, 'agent', event.transcript);
            }
            break;

          case 'conversation.item.input_audio_transcription.completed':
            socket.emit('history_updated', [{
              id: event.item_id || Date.now().toString(),
              role: 'user',
              text: event.transcript
            }]);

            // Save User Message & Add Audio to aggregate
            if (activeConversationId) {
              const fullPcmBuffer = Buffer.concat(userAudioBuffer);
              userAudioBuffer = []; // clear context
              
              if (fullPcmBuffer.length > 0) {
                fullConversationPcm.push(fullPcmBuffer);
              }
              saveMessage(activeConversationId, 'user', event.transcript);
            }
            break;

          case 'error':
            console.error(`[Socket ${socket.id}] OpenAI error:`, event.error);
            socket.emit('session_error', event.error?.message || 'Unknown OpenAI error');
            break;
            
          case 'input_audio_buffer.speech_started':
            socket.emit('status_update', 'Listening...');
            isRecordingUser = true;
            // Provide rolling audio context backward 1.6s so we don't clip prefixes
            userAudioBuffer = [...rollingBuffer]; 
            rollingBuffer = [];
            break;

          case 'input_audio_buffer.speech_stopped':
            socket.emit('status_update', 'Processing...');
            isRecordingUser = false;
            break;
        }
      } catch (err) {
        console.error('Error handling OpenAI message:', err);
      }
    });

    openAiWs.on('close', () => {
      console.log(`[Socket ${socket.id}] OpenAI WebSocket closed`);
      socket.emit('session_stopped');

      // Add actual end time to the conversation when socket closes
      if (activeConversationId) {
        supabase.from('conversations').update({ end: getUTC8Time() }).eq('id', activeConversationId)
          .then(() => console.log(`[Socket ${socket.id}] Logged end time for conversation ${activeConversationId}`))
          .catch(err => console.error("Error logging end time:", err));

        // Aggregate and upload the complete conversation audio recording
        if (fullConversationPcm.length > 0) {
          const finalPcm = Buffer.concat(fullConversationPcm);
          const wavBuffer = convertPCM16ToWAV(finalPcm, 24000);
          const fileName = `calls/conversation-${activeConversationId}.wav`;
          
          uploadToR2(wavBuffer, fileName, 'audio/wav')
            .then(() => updateConversationAudio(activeConversationId, fileName))
            .catch(err => console.error('Error uploading complete conversation tracking:', err));
        }
      }

      openAiWs = null;
    });

    openAiWs.on('error', (err) => {
      console.error(`[Socket ${socket.id}] OpenAI WebSocket error:`, err);
      socket.emit('session_error', 'WebSocket error connecting to OpenAI');
    });
  });

  // 3. Receive audio chunks from the frontend client
  socket.on('client_audio', (pcm16Buffer) => {
    if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
      // Encode ArrayBuffer to base64
      const buf = Buffer.from(pcm16Buffer);
      const base64Audio = buf.toString('base64');
      
      const audioEvent = {
        type: 'input_audio_buffer.append',
        audio: base64Audio,
      };

      openAiWs.send(JSON.stringify(audioEvent));

      // Stream buffering
      if (isRecordingUser) {
        userAudioBuffer.push(buf);
      } else {
        rollingBuffer.push(buf);
        if (rollingBuffer.length > MAX_ROLLING_CHUNKS) {
          rollingBuffer.shift();
        }
      }
    }
  });

  socket.on('stop_emergency_session', () => {
    console.log(`[Socket ${socket.id}] stop_emergency_session`);
    if (openAiWs) {
      openAiWs.close();
      openAiWs = null;
    }
  });

  // A user/operator joins a specific conversation room
  socket.on('join_conversation', (conversationId) => {
    socket.join(conversationId);
    console.log(`Socket ${socket.id} joined conversation ${conversationId}`);
  });

  // Handle incoming real-time audio/text segments
  socket.on('send_message_stream', (data) => {
    // data might contain: { conversationId, author, textChunk, isFinal }
    socket.to(data.conversationId).emit('receive_message_stream', data);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    if (openAiWs) {
      openAiWs.close();
      openAiWs = null;
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
