import { NextResponse } from "next/server";
import { resolveUserSession, attachSessionCookie } from "@/lib/auth/session";
import {
  getUserDecryptedApiKey,
  updateUserKeyStatus,
} from "@/lib/db/userApiKeyStore";
import { validateGeminiApiKey } from "@/lib/geminiService";

export async function POST(request: Request) {
  try {
    const { userId, isNew } = resolveUserSession(request);
    const body = await request.json().catch(() => ({}));

    // If client supplied a candidate key, test that directly
    let keyToTest = typeof body?.candidateKey === "string" ? body.candidateKey.trim() : "";
    let isSavedKey = false;

    // Otherwise, retrieve user's securely stored key
    if (!keyToTest) {
      const storedKey = await getUserDecryptedApiKey(userId);
      if (storedKey && storedKey.trim().length > 0) {
        keyToTest = storedKey.trim();
        isSavedKey = true;
      }
    }

    if (!keyToTest) {
      return NextResponse.json(
        {
          success: false,
          status: "not_configured",
          message: "No API key configured or provided to test.",
        },
        { status: 400 }
      );
    }

    // Perform validation test
    const testResult = await validateGeminiApiKey(keyToTest);

    // If testing the saved key, update its stored validation status
    if (isSavedKey) {
      await updateUserKeyStatus(userId, testResult.status, testResult.message);
    }

    const response = NextResponse.json({
      success: testResult.valid,
      status: testResult.status,
      message: testResult.message,
      testedAt: new Date().toISOString(),
    });

    if (isNew) {
      attachSessionCookie(response, userId);
    }

    return response;
  } catch (err) {
    console.error("[Settings] Unexpected error during API key test:", err);
    return NextResponse.json(
      {
        success: false,
        status: "error",
        message: "An unexpected error occurred while validating the API key.",
      },
      { status: 500 }
    );
  }
}
