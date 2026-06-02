-- Adiciona colunas de bloqueio de conta por tentativas de login
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lockedUntil"         TIMESTAMP(3);
