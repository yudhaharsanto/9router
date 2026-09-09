import { NextResponse } from "next/server";
import { handleAutoClawCallback } from "@/lib/oauth/utils/server";

export async function GET(request, { params }) {
  const { method } = await params;
  if (method !== "google" && method !== "zai") {
    return new NextResponse("Not found", { status: 404 });
  }

  const result = handleAutoClawCallback(new URL(request.url));
  const message = result.success
    ? "Login berhasil. Anda dapat menutup halaman ini dan kembali ke 9router."
    : `Login gagal: ${result.error}`;

  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>AutoClaw Login</title></head><body><p>${message}</p></body></html>`,
    {
      status: result.success ? 200 : 400,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}
