-- M5 — Deep Search tier credits.
-- Each user is granted 5 free deep searches per month. Decremented when
-- the user submits a search with searchTier="deep". Reset monthly by a
-- Vercel cron. Unlimited for users on the paid plan.

ALTER TABLE "User"
  ADD COLUMN "deepSearchCreditsRemaining" INTEGER NOT NULL DEFAULT 5;

ALTER TABLE "User"
  ADD COLUMN "subscriptionTier" TEXT NOT NULL DEFAULT 'free';

ALTER TABLE "User"
  ADD COLUMN "lastCreditResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
