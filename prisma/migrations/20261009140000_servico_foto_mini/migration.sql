-- Versão quadrada e leve da foto do serviço (redesign v3, agenda pública).
-- Só ADICIONA uma coluna que nasce nula: nenhum serviço muda.
--
-- ATENÇÃO (lição do deploy de 2026-10-05): aplicar com o serviço PARADO
-- (systemctl stop cortavo), depois do backup. Quem roda é a Kalany.
ALTER TABLE "servicos" ADD COLUMN "foto_mini_url" TEXT;
