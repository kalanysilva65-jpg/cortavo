-- Fase 2.6 (spec 05): período de teste de 14 dias e vagas de fundador.
-- Só ADICIONA colunas (nada é apagado nem reescrito). Todas as barbearias que já
-- existem ficam com situação "ativa" e sem teste: nada muda para elas.
-- ATENÇÃO (lição do deploy): aplicar com o serviço PARADO, depois do backup.
ALTER TABLE "barbearias" ADD COLUMN "situacao_cortavo" TEXT NOT NULL DEFAULT 'ativa';
ALTER TABLE "barbearias" ADD COLUMN "teste_inicio" DATETIME;
ALTER TABLE "barbearias" ADD COLUMN "teste_fim" DATETIME;
ALTER TABLE "barbearias" ADD COLUMN "teste_prorrogado" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "barbearias" ADD COLUMN "teste_prorrogacao_motivo" TEXT;
ALTER TABLE "barbearias" ADD COLUMN "teste_segurar_pausa" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "barbearias" ADD COLUMN "teste_pago_em" DATETIME;
ALTER TABLE "barbearias" ADD COLUMN "teste_aviso_fim_em" DATETIME;
ALTER TABLE "barbearias" ADD COLUMN "teste_aviso_vencido_em" DATETIME;
ALTER TABLE "barbearias" ADD COLUMN "teste_pausado_em" DATETIME;
ALTER TABLE "barbearias" ADD COLUMN "teste_respostas" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "barbearias" ADD COLUMN "teste_consultas" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "barbearias" ADD COLUMN "fundador" TEXT;
ALTER TABLE "barbearias" ADD COLUMN "fundador_em" DATETIME;
