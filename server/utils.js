import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, r2Bucket } from "./config.js";

export function convertPCM16ToWAV(pcmBuffer, sampleRate = 24000) {
  const numChannels = 1;
  const byteRate = sampleRate * numChannels * 2;
  const blockAlign = numChannels * 2;

  const buffer = Buffer.alloc(44 + pcmBuffer.length);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + pcmBuffer.length, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);    // Subchunk1Size
  buffer.writeUInt16LE(1, 20);     // AudioFormat (PCM)
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);    // BitsPerSample
  buffer.write("data", 36);
  buffer.writeUInt32LE(pcmBuffer.length, 40);
  pcmBuffer.copy(buffer, 44);

  return buffer;
}

export async function uploadToR2(buffer, fileName, mimeType) {
  const command = new PutObjectCommand({
    Bucket: r2Bucket,
    Key: fileName,
    Body: buffer,
    ContentType: mimeType,
  });
  await r2Client.send(command);
  return `${process.env.CLOUDFLARE_PUBLIC_API}/${fileName}`;
}

export function getUTC8Time() {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return utc8.toISOString().replace("Z", "+08:00");
}
