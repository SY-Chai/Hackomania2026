#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <driver/i2s.h>
#include <freertos/queue.h>

#define LED_PIN 3

// ---- WiFi credentials ----
#define WIFI_SSID "LLI-GUEST"
#define WIFI_PASS "#wifi@408601"

// ---- WebSocket server ----
#ifndef WS_HOST
#define WS_HOST "hackomania2026.onrender.com" // hostname only, no scheme
#endif
#ifndef WS_PORT
#define WS_PORT 443
#endif
#ifndef WS_PATH
#define WS_PATH "/esp32-phone" // optional: /esp32-phone?pab_id=<PAB_UUID>
#endif
#ifndef WS_SECURE
#define WS_SECURE 1 // 1 = wss (Render), 0 = ws (local dev)
#endif

// mic (PDM)
#define MIC_PDM_CLK 38
#define MIC_PDM_DATA 39

// speaker (I2S amp, e.g. MAX98357)
#define AMP_BCLK 45
#define AMP_LRCLK 46
#define AMP_DIN 42
#define AMP_GAIN 41
#define AMP_MODE 40

// I2S port assignments
#define I2S_MIC_PORT I2S_NUM_0
#define I2S_SPK_PORT I2S_NUM_1

// Audio config
#define SAMPLE_RATE 24000
#define MIC_CHUNK_SAMPLES 1920 // 80ms chunks @ 24kHz
#define MIC_CHUNK_BYTES (MIC_CHUNK_SAMPLES * sizeof(int16_t))

WebSocketsClient ws;
volatile bool wsConnected = false;

// Thread-safe queue: mic task pushes chunks, loop() pops and sends
// Each queue item is a full chunk (MIC_CHUNK_BYTES)
#define MIC_QUEUE_LEN 4
static QueueHandle_t micQueue = NULL;

// Speaker queue: WS callback pushes raw chunks, speaker task pops and writes to I2S
// Each item: size (2 bytes) + audio data (up to SPK_MAX_CHUNK bytes)
#define SPK_QUEUE_LEN 10
#define SPK_MAX_CHUNK 4096
static QueueHandle_t spkQueue = NULL;
typedef struct
{
  uint16_t len;
  int16_t data[SPK_MAX_CHUNK / 2];
} SpkChunk;

// ---- Echo suppression ----
// When the speaker is playing, mute the mic to prevent feedback loops.
// After the last speaker write, keep mic muted for ECHO_TAIL_MS extra ms.
// Must be longer than jitter buffer delay (~240ms) + acoustic propagation.
#define ECHO_TAIL_MS 400
volatile unsigned long lastSpkWriteMs = 0;

// ---- Debug counters (reset every second) ----
static volatile int dbgMicPkts = 0;    // mic chunks sent to WS
static volatile int dbgMicPeak = 0;    // loudest mic sample this interval
static volatile int dbgMicGated = 0;   // mic chunks dropped by echo gate
static volatile int dbgMicDropped = 0; // mic chunks dropped (queue full)
static volatile int dbgSpkPkts = 0;    // speaker chunks received from WS
static volatile int dbgSpkPeak = 0;    // loudest speaker sample this interval
static volatile int dbgSpkDropped = 0; // speaker chunks dropped (DMA full)

// ---- Software volume (0–100) ----
// Adjust this to control speaker loudness. 100 = full, 25 = quarter volume.
#define SPEAKER_VOLUME 40

static void applyVolume(uint8_t *data, size_t len)
{
  int16_t *samples = (int16_t *)data;
  size_t count = len / sizeof(int16_t);
  for (size_t i = 0; i < count; i++)
  {
    samples[i] = (int16_t)(((int32_t)samples[i] * SPEAKER_VOLUME) / 100);
  }
}

static bool isSpeakerActive()
{
  return (millis() - lastSpkWriteMs) < ECHO_TAIL_MS;
}

// ---- Mic software gain ----
// PDM mics are typically quiet. Boost the signal before sending.
// Keep gain low to avoid clipping at 16-bit PCM ceiling (32767).
#define MIC_GAIN 1

// ---- Noise gate ----
// Samples with absolute value below this threshold are zeroed out.
// Prevents background hiss from being transmitted and triggering echo suppression.
// Range 0–32767. Raise if background noise bleeds through, lower if speech is clipped.
#define MIC_NOISE_GATE 0

// ---- DC offset removal (high-pass filter) + gain ----
static int32_t dcOffset = 0;

void processMicAudio(int16_t *samples, size_t count)
{
  for (size_t i = 0; i < count; i++)
  {
    // High-pass: remove DC offset
    dcOffset += ((int32_t)samples[i] - dcOffset) / 256;
    int32_t filtered = ((int32_t)samples[i] - dcOffset) * MIC_GAIN;
    // Clamp to 16-bit range
    if (filtered > 32767)
      filtered = 32767;
    if (filtered < -32768)
      filtered = -32768;
    // Noise gate: zero out samples below the noise floor
    if (filtered > -MIC_NOISE_GATE && filtered < MIC_NOISE_GATE)
      filtered = 0;
    samples[i] = (int16_t)filtered;
  }
}

// ---- Mic capture task (runs on core 0) ----
void micTask(void *param)
{
  int16_t *buf = (int16_t *)malloc(MIC_CHUNK_BYTES);
  if (!buf)
  {
    Serial.println("micTask: malloc failed!");
    vTaskDelete(NULL);
    return;
  }

  // Discard first 100ms of mic data (PDM startup noise)
  size_t discard = (SAMPLE_RATE / 10) * sizeof(int16_t);
  uint8_t *trash = (uint8_t *)malloc(discard);
  if (trash)
  {
    size_t rd = 0;
    i2s_read(I2S_MIC_PORT, trash, discard, &rd, portMAX_DELAY);
    free(trash);
  }

  while (true)
  {
    size_t bytesRead = 0;
    i2s_read(I2S_MIC_PORT, buf, MIC_CHUNK_BYTES, &bytesRead, portMAX_DELAY);

    if (bytesRead == MIC_CHUNK_BYTES && wsConnected)
    {
      // Echo suppression: drop mic data while speaker is playing
      if (isSpeakerActive())
      {
        dbgMicGated++;
        continue;
      }

      size_t sampleCount = bytesRead / sizeof(int16_t);
      processMicAudio(buf, sampleCount);

      // Track mic peak for debug
      for (size_t i = 0; i < sampleCount; i++)
      {
        int32_t s = abs((int32_t)buf[i]);
        if (s > dbgMicPeak)
          dbgMicPeak = s;
      }

      // Send PCM16 to queue (don't block if full — drop the chunk)
      if (xQueueSend(micQueue, buf, 0) == pdTRUE)
      {
        dbgMicPkts++;
      }
      else
      {
        dbgMicDropped++;
      }
    }
  }
}

// ---- Mic setup (PDM) ----
void setupMic()
{
  i2s_config_t cfg = {};
  cfg.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX | I2S_MODE_PDM);
  cfg.sample_rate = SAMPLE_RATE;
  cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  cfg.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
  cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  cfg.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  cfg.dma_buf_count = 8;
  // old 320
  cfg.dma_buf_len = 320;
  cfg.use_apll = false;

  i2s_pin_config_t pins = {};
  pins.bck_io_num = I2S_PIN_NO_CHANGE;
  pins.ws_io_num = MIC_PDM_CLK;
  pins.data_out_num = I2S_PIN_NO_CHANGE;
  pins.data_in_num = MIC_PDM_DATA;

  i2s_driver_install(I2S_MIC_PORT, &cfg, 0, NULL);
  i2s_set_pin(I2S_MIC_PORT, &pins);
}

// ---- Speaker setup (I2S) ----
void setupSpeaker()
{
  pinMode(AMP_MODE, OUTPUT);
  digitalWrite(AMP_MODE, HIGH);
  pinMode(AMP_GAIN, OUTPUT);
  digitalWrite(AMP_GAIN, LOW); // LOW = 12dB gain (less noise than 15dB)

  i2s_config_t cfg = {};
  cfg.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX);
  cfg.sample_rate = SAMPLE_RATE;
  cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  cfg.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT; // stereo — MAX98357 expects standard I2S
  cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  cfg.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  cfg.dma_buf_count = 8;
  cfg.dma_buf_len = 320;
  cfg.use_apll = false;
  cfg.tx_desc_auto_clear = true; // silence when no data (prevents static)

  i2s_pin_config_t pins = {};
  pins.bck_io_num = AMP_BCLK;
  pins.ws_io_num = AMP_LRCLK;
  pins.data_out_num = AMP_DIN;
  pins.data_in_num = I2S_PIN_NO_CHANGE;

  i2s_driver_install(I2S_SPK_PORT, &cfg, 0, NULL);
  i2s_set_pin(I2S_SPK_PORT, &pins);
}

// ---- WebSocket event handler ----
void onWsEvent(WStype_t type, uint8_t *payload, size_t length)
{
  switch (type)
  {
  case WStype_CONNECTED:
    Serial.printf("[WS] Connected to %s:%d%s\n", WS_HOST, WS_PORT, WS_PATH);
    wsConnected = true;
    digitalWrite(LED_PIN, HIGH);
    break;
  case WStype_DISCONNECTED:
    Serial.println("[WS] Disconnected");
    wsConnected = false;
    i2s_zero_dma_buffer(I2S_SPK_PORT); // silence speaker immediately
    digitalWrite(LED_PIN, LOW);
    break;
  case WStype_BIN:
    // Server sent PCM16 audio — push to speaker queue
    {
      if (length > 0 && length <= SPK_MAX_CHUNK && (length % sizeof(int16_t) == 0))
      {
        static SpkChunk chunk;
        memcpy(chunk.data, payload, length);
        chunk.len = length;

        // Check peak of PCM
        int32_t peak = 0;
        size_t samples = length / sizeof(int16_t);
        for (size_t i = 0; i < samples; i++)
        {
          int32_t s = abs((int32_t)chunk.data[i]);
          if (s > peak)
            peak = s;
        }

        dbgSpkPkts++;
        if (peak > dbgSpkPeak)
          dbgSpkPeak = peak;

        if (peak > 2000)
        {
          lastSpkWriteMs = millis();
        }

        if (xQueueSend(spkQueue, &chunk, 0) != pdTRUE)
        {
          dbgSpkDropped++;
        }
      }
    }
    break;
  case WStype_TEXT:
    Serial.printf("[WS] Text: %s\n", payload);
    break;
  default:
    break;
  }
}

// ---- Speaker playback task (runs on core 0) ----
// Drains spkQueue and writes to I2S with jitter buffering for network resilience
void spkTask(void *param)
{
  static int16_t stereoBuf[SPK_MAX_CHUNK];
  SpkChunk chunk;
  bool buffering = true;       // start in buffering mode
  const int JITTER_TARGET = 3; // prebuffer this many chunks (~240ms)
  const int JITTER_MAX = 7;    // skip if buffer exceeds this

  while (true)
  {
    // Buffering phase: wait until enough chunks arrive to absorb jitter
    if (buffering)
    {
      if ((int)uxQueueMessagesWaiting(spkQueue) >= JITTER_TARGET)
      {
        buffering = false;
      }
      else
      {
        vTaskDelay(pdMS_TO_TICKS(10));
        continue;
      }
    }

    if (xQueueReceive(spkQueue, &chunk, pdMS_TO_TICKS(200)) == pdTRUE)
    {
      // Skip excess chunks to keep latency bounded
      while ((int)uxQueueMessagesWaiting(spkQueue) > JITTER_MAX)
      {
        xQueueReceive(spkQueue, &chunk, 0);
        dbgSpkDropped++;
      }

      // Apply volume
      applyVolume((uint8_t *)chunk.data, chunk.len);

      // Expand mono to stereo so MAX98357 sees proper I2S frames
      size_t monoSamples = chunk.len / sizeof(int16_t);
      for (size_t i = 0; i < monoSamples; i++)
      {
        stereoBuf[i * 2] = chunk.data[i];
        stereoBuf[i * 2 + 1] = chunk.data[i];
      }
      size_t stereoBytes = monoSamples * 2 * sizeof(int16_t);

      size_t bytesWritten = 0;
      i2s_write(I2S_SPK_PORT, stereoBuf, stereoBytes, &bytesWritten, portMAX_DELAY);
    }
    else
    {
      // No data for 200ms — underrun, rebuffer
      buffering = true;
      i2s_zero_dma_buffer(I2S_SPK_PORT);
    }
  }
}

void setup()
{
  Serial.begin(115200);
  delay(500);
  pinMode(LED_PIN, OUTPUT);
  pinMode(47, OUTPUT);
  digitalWrite(47, LOW);

  setupMic();
  setupSpeaker();

  Serial.println("\n\n=== ESP32-S3 Booting ===");
  Serial.flush();

  // Connect to WiFi
  Serial.printf("Connecting to WiFi '%s'...", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED)
  {
    delay(500);
    Serial.print(".");
    if (++attempts > 30)
    { // 15s timeout
      Serial.println("\nWiFi FAILED! Check SSID/password. Retrying...");
      WiFi.disconnect();
      delay(1000);
      WiFi.begin(WIFI_SSID, WIFI_PASS);
      attempts = 0;
    }
  }
  Serial.printf("\nWiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());

  // Connect WebSocket
#if WS_SECURE
  ws.beginSSL(WS_HOST, WS_PORT, WS_PATH);
#else
  ws.begin(WS_HOST, WS_PORT, WS_PATH);
#endif
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(3000);

  // Create queues
  micQueue = xQueueCreate(MIC_QUEUE_LEN, MIC_CHUNK_BYTES);
  spkQueue = xQueueCreate(SPK_QUEUE_LEN, sizeof(SpkChunk));

  Serial.println("=== Full-Duplex Audio (Phone Call Mode) ===");
  Serial.printf("Sample rate: %d Hz, chunk: %d bytes\n", SAMPLE_RATE, MIC_CHUNK_BYTES);
  Serial.printf("Free heap: %d bytes (PSRAM: %d)\n",
                ESP.getFreeHeap(), ESP.getFreePsram());
  Serial.printf("Min free heap ever: %d bytes\n", ESP.getMinFreeHeap());
  // Clear speaker buffer to avoid startup static
  i2s_zero_dma_buffer(I2S_SPK_PORT);

  // Start audio tasks on core 0 (loop/WS runs on core 1)
  xTaskCreatePinnedToCore(micTask, "mic", 8192, NULL, 5, NULL, 0);
  xTaskCreatePinnedToCore(spkTask, "spk", 8192, NULL, 5, NULL, 0);
}

static unsigned long lastHeapPrint = 0;

void loop()
{
  ws.loop(); // handles incoming WS audio -> speaker via onWsEvent

  // Print status every second
  if (millis() - lastHeapPrint > 1000)
  {
    // Snapshot and reset counters
    int mPkts = dbgMicPkts;
    dbgMicPkts = 0;
    int mPeak = dbgMicPeak;
    dbgMicPeak = 0;
    int mGate = dbgMicGated;
    dbgMicGated = 0;
    int mDrop = dbgMicDropped;
    dbgMicDropped = 0;
    int sPkts = dbgSpkPkts;
    dbgSpkPkts = 0;
    int sPeak = dbgSpkPeak;
    dbgSpkPeak = 0;
    int sDrop = dbgSpkDropped;
    dbgSpkDropped = 0;

    // Build visual bars (20 chars wide, 32768 max)
    char micBar[21], spkBar[21];
    int micBlocks = mPeak / 1638;
    if (micBlocks > 20)
      micBlocks = 20;
    int spkBlocks = sPeak / 1638;
    if (spkBlocks > 20)
      spkBlocks = 20;
    for (int i = 0; i < 20; i++)
    {
      micBar[i] = i < micBlocks ? '#' : ' ';
    }
    for (int i = 0; i < 20; i++)
    {
      spkBar[i] = i < spkBlocks ? '#' : ' ';
    }
    micBar[20] = spkBar[20] = '\0';

    Serial.printf("MIC> %2dpkt pk:%5d [%s]", mPkts, mPeak, micBar);
    if (mGate)
      Serial.printf(" gate:%d", mGate);
    if (mDrop)
      Serial.printf(" DROP:%d", mDrop);
    Serial.printf("  |  SPK< %2dpkt pk:%5d [%s]", sPkts, sPeak, spkBar);
    if (sDrop)
      Serial.printf(" DROP:%d", sDrop);
    Serial.printf("  heap:%d\n", ESP.getFreeHeap());

    lastHeapPrint = millis();
  }

  if (!wsConnected)
  {
    delay(10);
    return;
  }

  // Pop PCM16 chunks from queue and send over WebSocket
  int16_t outBuf[MIC_CHUNK_SAMPLES];
  while (xQueueReceive(micQueue, outBuf, 0) == pdTRUE)
  {
    ws.sendBIN((uint8_t *)outBuf, MIC_CHUNK_BYTES);
  }
}
