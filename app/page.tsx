import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import JarvisOrb from "@/components/JarvisOrb";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { SESSION_COOKIE_NAME, verifySignedSessionToken } from "@/lib/auth/session";

export default async function Home() {
  let user: {
    id: string;
    email?: string;
    is_anonymous?: boolean;
    app_metadata?: Record<string, unknown>;
    user_metadata?: Record<string, unknown>;
  } | null = null;

  if (isSupabaseConfigured()) {
    try {
      const supabase = await createClient();
      const { data } = await supabase.auth.getUser();
      if (data?.user) {
        user = data.user;
      }
    } catch {
      user = null;
    }
  }

  // Fallback to verified signed ultron_session_id cookie
  if (!user) {
    try {
      const cookieStore = await cookies();
      const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
      if (sessionCookie) {
        const verifiedUserId = verifySignedSessionToken(sessionCookie);
        if (verifiedUserId) {
          const isAnon = verifiedUserId.startsWith("guest_");
          user = {
            id: verifiedUserId,
            is_anonymous: isAnon,
            email: isAnon ? "guest@ultron.internal" : "",
            app_metadata: isAnon ? { provider: "anonymous" } : {},
            user_metadata: {},
          };
        }
      }
    } catch {
      // Ignored
    }
  }

  if (!user) {
    redirect("/login");
  }

  const isGuest = Boolean(
    user.is_anonymous ||
    user.app_metadata?.provider === "anonymous" ||
    user.id.startsWith("guest_")
  );
  const metadata = user.user_metadata || {};
  const initialUser = {
    id: user.id,
    name: isGuest
      ? "GUEST OPERATOR"
      : (typeof metadata.full_name === "string" && metadata.full_name) ||
        (typeof metadata.name === "string" && metadata.name) ||
        user.email?.split("@")[0] ||
        "OPERATOR",
    email: user.email || (isGuest ? "guest@ultron.internal" : ""),
    avatarUrl:
      (typeof metadata.avatar_url === "string" && metadata.avatar_url) ||
      (typeof metadata.picture === "string" && metadata.picture) ||
      undefined,
    isGuest,
  };

  return <JarvisOrb initialUser={initialUser} />;
}

