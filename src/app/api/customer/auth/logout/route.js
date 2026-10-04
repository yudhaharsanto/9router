import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { clearCustomerAuthCookie } from "@/lib/auth/customerSession";

export const dynamic = "force-dynamic";

export async function POST() {
  const cookieStore = await cookies();
  clearCustomerAuthCookie(cookieStore);
  return NextResponse.json({ ok: true });
}
