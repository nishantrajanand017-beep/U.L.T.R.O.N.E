import { redirect } from "next/navigation";
import JarvisOrb from "@/components/JarvisOrb";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  let user = null;

  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    user = data?.user || null;
  } catch {
    user = null;
  }

  if (!user) {
    redirect("/login");
  }

  const isGuest = Boolean(
    user.is_anonymous ||
    user.app_metadata?.provider === "anonymous"
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
