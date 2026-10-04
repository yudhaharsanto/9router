import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { recordWebhookEvent, markWebhookProcessed } from "@/lib/db/repos/webhookEventsRepo.js";import { applyTopupCredit } from "@/lib/db/repos/topupsRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";

export const dynamic = "force-dynamic";

// POST /api/customer/webhooks/tako — Tako payment callback. No session: the
// HMAC over the RAW body IS the authentication (timing-safe compare). Never
// parse before verifying — the signature covers the exact bytes Tako sent.
//
// Contract (spec §3.3):
// - mismatch → 401
// - event persisted FIRST (unique (source, externalId) = replay protection),
//   then credited; 2xx only after the event is durably recorded
// - duplicate delivery → still 200 (idempotent, no double credit)
// - valid signature but unprocessable payload (unknown txn) → 500, event stays
//   'unprocessed' so the reconciliation worker can replay it later.

function callbackSecretMatches(settings) {
  const fromSettings = (settings.takoCallbackSecret || "").trim();
  if (fromSettings) return fromSettings;
  return (process.env.TAKO_CALLBACK_SECRET || "").trim();
}

export async function POST(request) {
  const raw = await request.text();
  const provided = request.headers.get("x-tako-signature") || "";

  const settings = await getSettings();
  const secret = callbackSecretMatches(settings);
  if (!secret) return NextResponse.json({ error: "Webhook not configured" }, { status: 401 });

  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const txnId = String(payload.transactionId || "").trim();
  if (!txnId) return NextResponse.json({ error: "Missing transactionId" }, { status: 400 });

  // Persist before crediting — replay-safe (unique constraint), duplicate
  // deliveries report created:false and skip straight to a 200.
  const { event, created } = await recordWebhookEvent({
    source: "tako",
    externalId: txnId,
    payload: raw,
  });
  if (!created) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  try {
    const result = await applyTopupCredit(txnId);
    if (!result.credited) {
      // Known-but-already-processed replays land here only when the event row
      // was new (e.g. a previous attempt persisted the event then crashed
      // before marking it processed). Not an error — the credit is in place.
      if (result.reason === "already-processed") {
        await markWebhookProcessed(event.id);
        return NextResponse.json({ ok: true, duplicate: true });
      }
      throw new Error(`topup not creditable: ${result.reason}`);
    }
    await markWebhookProcessed(event.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Leave the event 'unprocessed' — reconciliation replays anything still in
    // that state; flipping it to 'failed' here would hide it from the worker.
    console.error("[tako-webhook] credit failed for", txnId, err?.message || err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
