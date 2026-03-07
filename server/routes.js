import { Router } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { supabase } from "./config.js";
import { getUTC8Time, uploadToR2 } from "./utils.js";

const upload = multer({ storage: multer.memoryStorage() });

export function createRouter(io) {
  const router = Router();
  const notifyDashboard = () => io.emit("dashboard_update");

  router.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", message: "Node.js backend is running!" });
  });

  // 1) Initialize a Conversation
  router.post("/api/conversations", async (req, res) => {
    if (!supabase)
      return res.status(500).json({ error: "Supabase not configured" });

    const { start, end, triage, classification } = req.body || {};
    const { data, error } = await supabase
      .from("conversations")
      .insert([{
        start: start || getUTC8Time(),
        end: end || getUTC8Time(),
        triage: triage || "agent",
        classification: classification || "uncertain",
      }])
      .select();

    if (error) return res.status(400).json({ error: error.message });
    notifyDashboard();
    res.json(data[0]);
  });

  // 2) Update a Conversation (e.g. when an AI model finishes classifying it)
  router.patch("/api/conversations/:id", async (req, res) => {
    if (!supabase)
      return res.status(500).json({ error: "Supabase not configured" });

    const { id } = req.params;
    const { triage, classification } = req.body;
    const updates = {};
    if (triage) updates.triage = triage;
    if (classification) updates.classification = classification;

    if (Object.keys(updates).length === 0)
      return res.status(400).json({ error: "No valid fields to update" });

    const { data, error } = await supabase
      .from("conversations")
      .update(updates)
      .eq("id", id)
      .select();

    if (error) return res.status(400).json({ error: error.message });
    notifyDashboard();
    res.json(data[0]);
  });

  // 3) Save a Message
  router.post("/api/messages", async (req, res) => {
    if (!supabase)
      return res.status(500).json({ error: "Supabase not configured" });

    const { conversation_id, author, content, timestamp } = req.body;
    const { data, error } = await supabase
      .from("messages")
      .insert([{
        conversation_id,
        author,
        content,
        timestamp: timestamp || getUTC8Time(),
      }])
      .select();

    if (error) return res.status(400).json({ error: error.message });
    notifyDashboard();
    res.json(data[0]);
  });

  // 4) Retrieve messages for a given conversation
  router.get("/api/conversations/:id/messages", async (req, res) => {
    if (!supabase)
      return res.status(500).json({ error: "Supabase not configured" });

    const { id } = req.params;
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", id)
      .order("timestamp", { ascending: true });

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  });

  // 5) Upload Audio to Cloudflare R2
  router.post("/api/upload-audio", upload.single("audio"), async (req, res) => {
    if (!req.file)
      return res.status(400).json({ error: "No audio file provided" });

    try {
      const fileExtension = req.file.originalname.split(".").pop() || "webm";
      const fileName = `calls/audio-${Date.now()}-${uuidv4()}.${fileExtension}`;
      const publicUrl = await uploadToR2(
        req.file.buffer,
        fileName,
        req.file.mimetype || "audio/webm",
      );
      res.json({ message: "Audio uploaded successfully", url: publicUrl });
    } catch (error) {
      console.error("Error uploading to R2:", error);
      res.status(500).json({ error: "Failed to upload audio" });
    }
  });

  return router;
}
