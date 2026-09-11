import { NextResponse } from "next/server";
import {
  getElevenLabsPublicConfig,
  testElevenLabsConnection,
} from "@/lib/elevenlabsService";

export async function GET() {
  try {
    const config = getElevenLabsPublicConfig();
    return NextResponse.json(config);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to retrieve ElevenLabs configuration.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST() {
  try {
    const result = await testElevenLabsConnection();
    return NextResponse.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "ElevenLabs connection test failed.";
    return NextResponse.json(
      {
        valid: false,
        status: "error",
        message: msg,
      },
      { status: 500 }
    );
  }
}
