import OpenAI from "openai";

export async function POST() {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return Response.json(
        { error: "OPENAI_API_KEY is missing on the server." },
        { status: 500 }
      );
    }

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const session = await client.realtime.clientSecrets.create({
      session: {
        type: "realtime",
        model: "gpt-realtime",
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anySession = session as any;
    return Response.json({
      client_secret: anySession.client_secret?.value ?? anySession.value,
    });
  } catch (error: any) {
    console.error("Realtime session creation failed:", error);

    return Response.json(
      {
        error: error?.message ?? "Failed to create realtime session token.",
      },
      { status: 500 }
    );
  }
}