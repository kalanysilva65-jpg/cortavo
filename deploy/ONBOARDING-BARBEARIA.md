# Onboarding de uma barbearia nova (WhatsApp + cobrança centralizada)

A Cortavo é **Tech Provider** na Meta: não tem linha de crédito para compartilhar.
Cada barbearia conecta o PRÓPRIO WhatsApp (coexistência), e a conta de WhatsApp
Business (WABA) é **dela**. Para a cobrança da Meta cair no **cartão da Cortavo**,
o cartão da Cortavo é cadastrado manualmente na conta de cada barbearia.

> Desde **01/10/2026** a Meta cobra as respostas (IA/equipe via API) acima de
> **1.000 por número/mês** (~R$0,035 cada) e todo lembrete (template).
> **Conta SEM forma de pagamento = a Meta para de entregar as respostas.**
> Por isso o passo 4 é OBRIGATÓRIO antes de ligar a secretária.

## 1. Antes (no Cortavo)
- [ ] Barbearia criada no painel-mestre, com admin.
- [ ] Serviços + preços cadastrados.
- [ ] Barbeiros com **horário de trabalho** (é daí que a secretária tira os horários livres).

## 2. Pré-requisitos (conferir antes da chamada)
- [ ] Número usado no **WhatsApp Business** (app) há **7+ dias**, app atualizado.
- [ ] Celular do número em mãos (o popup pede confirmação por ele).
- [ ] Na Cortavo: serviços, preços, equipe e horários de trabalho cadastrados.
- [ ] O dono consegue entrar em **business.facebook.com** (é admin do portfólio da barbearia).

## 3. Conectar
1. Logado como admin da barbearia → **Secretária** → **Conectar WhatsApp**.
2. No popup: conectar o **WhatsApp Business existente** (não criar número novo) e confirmar no celular.
3. A tela volta como **Conectado** com o número.

## 4. A Cortavo como PARCEIRA na Meta (cobrança centralizada)

**Regra:** a barbearia adiciona o **portfólio Cortavo como parceiro**, pelo **ID do
portfólio**. Nenhum e-mail de pessoa entra nesse processo. O ID fica nos registros
internos da Cortavo e é passado ao dono **na chamada** (não escrever o número neste
repositório).

**O que dizer ao dono (frase pronta):**
> "As mensagens do WhatsApp são cobradas pela Meta, e quem paga é a Cortavo. Para
> isso você adiciona a Cortavo como parceira na sua conta de empresa da Meta. A gente
> só usa esse acesso para colocar o cartão da Cortavo e acompanhar o WhatsApp da
> secretária. Se um dia você cancelar, a Cortavo tira o cartão e sai; você também
> pode remover a parceira quando quiser."

**Passo a passo do dono (junto, na chamada):**
1. Abrir **business.facebook.com** → **Configurações** (engrenagem) → **Usuários** → **Parceiros**.
2. Tocar em **Adicionar** → **Dar a um parceiro acesso aos seus ativos**.
3. Colar o **ID do portfólio da Cortavo** (a Cortavo passa na chamada).
4. Escolher a **Conta do WhatsApp** da barbearia e marcar **controle total**
   (gerenciar a conta, incluindo pagamentos). Salvar.

> Os nomes dos menus da Meta mudam com frequência. Conferir na primeira chamada e
> ajustar este guia se algo estiver diferente.

**O que a Cortavo faz depois (Kalany):**
1. No portfólio **Cortavo** → **Contas do WhatsApp**: a conta da barbearia aparece como
   compartilhada. Atribuir a si mesma (e à pessoa reserva do portfólio) acesso a ela.
2. **Configurações de pagamento** da conta (ou WhatsApp Manager → **Cobrança**) →
   **Adicionar forma de pagamento** → cartão da Cortavo → salvar.
3. Conferir que aparece como **ativo** (pode levar alguns minutos; o erro 131042 nos
   primeiros envios é esse atraso).
4. Só então ligar a secretária. **Conta sem forma de pagamento = a Meta para de
   entregar as respostas.**

**Se a barbearia sair da Cortavo:**
1. A Cortavo remove o cartão da conta do WhatsApp da barbearia.
2. A Cortavo deixa de usar a conta compartilhada; o dono remove a parceira em
   **Configurações → Usuários → Parceiros → Cortavo → Remover**.

> Barbearias conectadas antes desta regra (com acesso por pessoa): trocar pela
> parceria com calma, numa chamada, e depois remover a pessoa antiga do portfólio da
> barbearia. É ação manual na Meta (Kalany).

## 5. Testar
- [ ] De outro celular, mandar "Oi, quero marcar um corte amanhã".
- [ ] A mensagem aparece em **Conversas** e a secretária responde.
- [ ] A resposta aparece também no app WhatsApp Business do barbeiro (sincronização).

## 6. Lembretes (ainda manual)
O template `lembrete_agendamento` precisa existir e estar **aprovado na WABA da barbearia**
(WhatsApp Manager → Modelos → Utilidade, pt_BR, mesmas 3 variáveis: nome, barbearia, hora).
Enquanto não aprovar, a conversa funciona; só o lembrete não sai.

## 7. Acompanhar o custo
Painel-mestre → **Uso & custos** → coluna **WhatsApp msgs (pagas) · lembr.**
- Linha **laranja** = passou de 80% das 1.000 grátis no mês.
- O custo da Meta já entra em **Custo** e **Margem**.
- Para economizar mensagens: ligar `SECRETARIA_DEBOUNCE_MS=8000` no `.env` (agrupa rajadas numa resposta só).
