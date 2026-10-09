-- Spec 13 (acesso por link): a pessoa recebe um e-mail e cria a PRÓPRIA senha.
-- Só ADICIONA (nada é apagado nem reescrito, exceto preencher a coluna nova).
-- ATENÇÃO (lição do deploy): aplicar com o serviço PARADO, depois do backup.

-- Quando a própria pessoa criou a senha. Nulo = conta nova aguardando o link.
ALTER TABLE "usuarios" ADD COLUMN "senha_definida_em" DATETIME;

-- Contas que já existem NÃO aparecem como "aguardando criar a senha" no mestre:
-- a data vira a de criação da conta.
UPDATE "usuarios" SET "senha_definida_em" = "criado_em" WHERE "senha_definida_em" IS NULL;

-- CreateTable
CREATE TABLE "tokens_acesso" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "usuario_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "expira_em" DATETIME NOT NULL,
    "usado_em" DATETIME,
    "revogado_em" DATETIME,
    "enviado_em" DATETIME,
    "erro_envio" TEXT,
    "criado_por_id" INTEGER,
    "criado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tokens_acesso_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "tokens_acesso_token_hash_key" ON "tokens_acesso"("token_hash");

-- CreateIndex
CREATE INDEX "tokens_acesso_usuario_id_idx" ON "tokens_acesso"("usuario_id");
