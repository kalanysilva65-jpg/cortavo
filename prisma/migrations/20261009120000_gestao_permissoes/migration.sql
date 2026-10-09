-- Spec 12, fatia B3 (permissões e Gestão). Só ADICIONA: colunas novas que
-- nascem nulas, um índice e uma tabela nova. Nada é apagado, renomeado nem
-- reescrito; os agendamentos existentes ficam exatamente como estão.
-- O status "faltou" não precisa de coluna: `status` já é texto livre.
--
-- ATENÇÃO (lição do deploy de 2026-10-05): aplicar com o serviço PARADO
-- (systemctl stop cortavo), depois do backup. Com o app rodando, a migração
-- falha com "database is locked". Quem roda é a Kalany.

-- Cancelamento: quando, quem e por quê (G13).
ALTER TABLE "agendamentos" ADD COLUMN "cancelado_em" DATETIME;
ALTER TABLE "agendamentos" ADD COLUMN "cancelado_por" TEXT;
ALTER TABLE "agendamentos" ADD COLUMN "cancelado_por_id" INTEGER;
ALTER TABLE "agendamentos" ADD COLUMN "motivo_cancelamento" TEXT;

-- Faturamento/ticket/atendimentos filtram por concluido_em.
CREATE INDEX "agendamentos_barbearia_id_concluido_em_idx" ON "agendamentos"("barbearia_id", "concluido_em");

-- Baixa de comissão (G15).
CREATE TABLE "comissao_pagamentos" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "barbearia_id" INTEGER NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "periodo_inicio" DATETIME NOT NULL,
    "periodo_fim" DATETIME NOT NULL,
    "valor" INTEGER NOT NULL,
    "valor_calculado" INTEGER NOT NULL,
    "pago_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pago_por_id" INTEGER,
    "pago_por_nome" TEXT NOT NULL,
    "observacao" TEXT,
    "caixa_id" INTEGER,
    CONSTRAINT "comissao_pagamentos_barbearia_id_fkey" FOREIGN KEY ("barbearia_id") REFERENCES "barbearias" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "comissao_pagamentos_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "comissao_pagamentos_barbearia_id_usuario_id_periodo_inicio_idx" ON "comissao_pagamentos"("barbearia_id", "usuario_id", "periodo_inicio");
