import { NextResponse } from "next/server";
import { getUsageByKeyName, getSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// GET /api/public/key-usage?name=yudha&token=SECRET
// Public (no login) lookup of token usage by API key name.
// Requires a secret token configured in settings (usageLookupToken).
// Never returns the secret API key string — only name, usage and limit info.
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const name = url.searchParams.get("name");
    const token = url.searchParams.get("token");

    const settings = await getSettings();
    const expected = (settings.usageLookupToken || "").trim();

    // Feature is opt-in: disabled until an admin sets a token.
    if (!expected) {
      return NextResponse.json({ error: "Usage lookup is disabled" }, { status: 403 });
    }
    if (!token || token !== expected) {
      return NextResponse.json({ error: "Invalid or missing token" }, { status: 401 });
    }

    if (!name || !name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const periodParam = url.searchParams.get("period");
    const allowed = ["today", "7d", "30d", "all"];
    const period = allowed.includes(periodParam) ? periodParam : null;

    const results = await getUsageByKeyName(name, { period });
    return NextResponse.json({ name: name.trim(), period, count: results.length, results });
  } catch (error) {
    console.log("Error looking up key usage:", error);
    return NextResponse.json({ error: "Failed to look up usage" }, { status: 500 });
  }
}
