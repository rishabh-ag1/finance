import dotenv from "dotenv";
dotenv.config();

import { PrismaClient } from "@prisma/client";

// Development only: FINANCE_USE_TEST_DB=1 runs the app against DATABASE_URL_TEST (the database
// the tests fill), to click through screens with data without touching the real database.
if (process.env.FINANCE_USE_TEST_DB === "1" && process.env.NODE_ENV !== "production") {
  if (!process.env.DATABASE_URL_TEST) throw new Error("FINANCE_USE_TEST_DB=1 needs DATABASE_URL_TEST");
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
