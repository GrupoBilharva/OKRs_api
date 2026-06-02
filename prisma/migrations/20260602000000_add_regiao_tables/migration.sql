-- CreateTable
CREATE TABLE IF NOT EXISTS "Regiao" (
    "id"        TEXT NOT NULL,
    "nome"      TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Regiao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "RegiaoLoja" (
    "regiaoId" TEXT NOT NULL,
    "lojaId"   TEXT NOT NULL,
    CONSTRAINT "RegiaoLoja_pkey" PRIMARY KEY ("regiaoId", "lojaId")
);

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "regiaoId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Regiao_nome_key" ON "Regiao"("nome");

-- AddForeignKey
ALTER TABLE "RegiaoLoja" ADD CONSTRAINT "RegiaoLoja_regiaoId_fkey"
    FOREIGN KEY ("regiaoId") REFERENCES "Regiao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegiaoLoja" ADD CONSTRAINT "RegiaoLoja_lojaId_fkey"
    FOREIGN KEY ("lojaId") REFERENCES "Loja"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_regiaoId_fkey"
    FOREIGN KEY ("regiaoId") REFERENCES "Regiao"("id") ON DELETE SET NULL ON UPDATE CASCADE;
