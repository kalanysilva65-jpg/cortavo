-- Fase 2.1 (spec 04): plano da Cortavo por barbearia.
-- Só ADICIONA colunas (nada é apagado nem reescrito). Todas as barbearias que já
-- existem recebem "personalizado" pelo DEFAULT: tudo liberado e tetos lidos da
-- Configuracao, exatamente como antes. A data de início fica vazia até a Kalany
-- escolher um plano no painel-mestre.
ALTER TABLE "barbearias" ADD COLUMN "plano_cortavo" TEXT NOT NULL DEFAULT 'personalizado';
ALTER TABLE "barbearias" ADD COLUMN "plano_cortavo_desde" DATETIME;
