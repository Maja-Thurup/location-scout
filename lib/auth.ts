import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";

export type AuthedRequest = NextRequest & {
  userId: string;
  dbUserId: string;
};

export type AuthedHandler = (req: AuthedRequest) => Promise<Response> | Response;

/**
 * Wrap an API route handler so it only runs for authenticated users.
 * Also lazily upserts a corresponding row in the local `User` table
 * so server code can join against `dbUserId` without an extra round-trip.
 */
export function withAuth(handler: AuthedHandler) {
  return async (req: NextRequest): Promise<Response> => {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const dbUser = await prisma.user.upsert({
      where: { clerkId: userId },
      create: {
        clerkId: userId,
        email: "",
      },
      update: {},
      select: { id: true },
    });

    const authedReq = Object.assign(req, {
      userId,
      dbUserId: dbUser.id,
    }) as AuthedRequest;

    return handler(authedReq);
  };
}

/**
 * For server components / server actions: returns the local DB user id,
 * upserting from Clerk if missing. Throws if not signed in.
 */
export async function requireDbUser(): Promise<{ clerkId: string; dbUserId: string }> {
  const { userId } = await auth();
  if (!userId) {
    throw new Error("Not authenticated");
  }

  const dbUser = await prisma.user.upsert({
    where: { clerkId: userId },
    create: { clerkId: userId, email: "" },
    update: {},
    select: { id: true },
  });

  return { clerkId: userId, dbUserId: dbUser.id };
}
