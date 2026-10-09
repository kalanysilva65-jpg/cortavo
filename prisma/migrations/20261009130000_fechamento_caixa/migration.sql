-- Fechamento do caixa do dia (redesign v3, fatia F6). Só CRIA uma tabela nova;
-- nenhuma tabela existente é alterada.
--
-- ATENÇÃO (lição do deploy de 2026-10-05): aplicar com o serviço PARADO
-- (systemctl stop cortavo), depois do backup. Quem roda é a Kalany.
CREATE TABLE "fechamentos_caixa" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "barbearia_id" INTEGER NOT NULL,
    "dia" DATETIME NOT NULL,
    "fechado_em" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fechado_por_id" INTEGER,
    "fechado_por_nome" TEXT NOT NULL,
    "entradas" INTEGER NOT NULL,
    "saidas" INTEGER NOT NULL,
    "saldo" INTEGER NOT NULL,
    "por_forma" TEXT NOT NULL,
    "atendimentos" INTEGER NOT NULL,
    "fundo_inicial" INTEGER NOT NULL DEFAULT 0,
    "dinheiro_esperado" INTEGER NOT NULL,
    "dinheiro_contado" INTEGER NOT NULL,
    "diferenca" INTEGER NOT NULL,
    "observacao" TEXT,
    "vezes" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "fechamentos_caixa_barbearia_id_fkey" FOREIGN KEY ("barbearia_id") REFERENCES "barbearias" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "fechamentos_caixa_barbearia_id_dia_key" ON "fechamentos_caixa"("barbearia_id", "dia");
