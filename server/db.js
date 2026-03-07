import { supabase } from "./config.js";
import { getUTC8Time } from "./utils.js";

/**
 * @param {Function} [notifyFn] - optional callback called after a successful write (e.g. notifyDashboard)
 */
export async function saveMessage(conversationId, authorId, text, notifyFn) {
  if (!supabase || !conversationId) return;

  const { data, error } = await supabase
    .from("messages")
    .insert([{
      conversation_id: conversationId,
      author_id: authorId,
      content: text || "",
      timestamp: getUTC8Time(),
    }])
    .select();

  if (error) {
    console.error("❌ Failed to save message to Supabase:", error);
  } else {
    const savedId = data?.[0]?.id || "unknown";
    console.log(`✅ Saved message to Supabase DB ID: ${savedId}`);
    notifyFn?.();
  }
}

export async function updateConversationAudio(conversationId, fileName, notifyFn) {
  if (!supabase || !conversationId) return;

  const { error } = await supabase
    .from("conversations")
    .update({ audio_url: fileName })
    .eq("id", conversationId);

  if (error) {
    console.error("❌ Failed to update conversation audio_url:", error);
  } else {
    console.log(`✅ Updated conversation ${conversationId} audio_url: ${fileName}`);
    notifyFn?.();
  }
}
