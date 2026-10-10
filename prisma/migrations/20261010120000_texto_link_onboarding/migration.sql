-- Redesign v3 + spec 11. Só ADICIONA colunas (nada é apagado nem reescrito).
-- ATENÇÃO (lição do deploy): aplicar com o serviço PARADO, depois do backup.

-- Texto da mensagem do WhatsApp da tela "Link de agendamento" (antes ficava só
-- no aparelho). Nulo = texto padrão.
ALTER TABLE "barbearias" ADD COLUMN "texto_link" TEXT;

-- Primeiros passos por usuário (spec 11): estado e quando escondeu.
ALTER TABLE "usuarios" ADD COLUMN "onboarding_estado" TEXT;
ALTER TABLE "usuarios" ADD COLUMN "onboarding_oculto_em" DATETIME;

-- Barbearias que já estão em uso (com serviço cadastrado) não veem o passo a
-- passo: a equipe delas já nasce com o cartão escondido (spec 11, aceite 10).
UPDATE "usuarios" SET "onboarding_oculto_em" = CURRENT_TIMESTAMP
WHERE "onboarding_oculto_em" IS NULL
  AND "barbearia_id" IN (SELECT DISTINCT "barbearia_id" FROM "servicos");
