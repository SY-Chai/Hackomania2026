import { fetchUsers } from "@/lib/supabase";

export async function GET() {
  const users = await fetchUsers();
  return Response.json(users);
}
