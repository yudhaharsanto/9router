import { getProviderConnectionById } from "@/lib/localDb";

// InferHub: wallet balance from the management API.
// GET /api/providers/inferhub/balance?connectionId=<id>
// Docs: https://inferhub.dev/docs/api/reference — GET /me returns
// { balances: { consumer_balance: "12.500000", publisher_earnings: "..." } }
// (USDC decimal strings), authenticated with the same sk-airo- key.
const INFERHUB_ME_URL = "https://inferhub.dev/api/me";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    if (id !== "inferhub") {
      return Response.json({ message: "Balance not available for this provider" });
    }

    const connectionId = new URL(request.url).searchParams.get("connectionId");
    if (!connectionId) {
      return Response.json({ error: "connectionId is required" }, { status: 400 });
    }

    const connection = await getProviderConnectionById(connectionId);
    if (!connection || connection.provider !== "inferhub") {
      return Response.json({ error: "Connection not found" }, { status: 404 });
    }

    const apiKey = (connection.apiKey || "").replace(/^Bearer\s+/i, "").trim();
    if (!apiKey) {
      return Response.json({ message: "No API key on this connection" });
    }

    const res = await fetch(INFERHUB_ME_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = body?.error?.message || body?.error?.code || `InferHub API error (${res.status})`;
      return Response.json({ message: `${message} — re-check your key?` });
    }

    const data = await res.json();
    const balances = data?.balances || {};
    return Response.json({
      balance: {
        consumer: balances.consumer_balance ?? null,
        publisher: balances.publisher_earnings ?? null,
      },
    });
  } catch (error) {
    console.warn(`[InferHub balance] ${error.message}`);
    return Response.json({ message: "Failed to load balance" });
  }
}
