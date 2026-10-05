# Publicar o Cortavo na Google Play (Android)

O app é um casco Capacitor que carrega `https://cortavo.com.br` (mesmo do iOS). O
Android reaproveita a config e o site; muda só o empacotamento e a loja. E, ao
contrário do iOS, **dá pra buildar no Windows** — não precisa de Mac.

`appId`: `br.com.cortavo.app` (o mesmo do iOS). Máquina de build: **este PC Windows**.

---

## ⚠️ LEIA PRIMEIRO — a regra dos 12 testadores

Contas de desenvolvedor **pessoais (pessoa física)** criadas atualmente precisam,
ANTES de liberar produção, rodar um **teste fechado com no mínimo 12 testadores
inscritos por 14 dias seguidos**. Só depois o Google libera o botão de produção.

- Contas de **organização/empresa** (com documento de empresa) são **isentas** dessa
  regra — se você tiver CNPJ e quiser, registrar como empresa pula essa etapa.
- Como pessoa física: **junte 12 pessoas desde já** (amigos, familiares, a equipe
  das barbearias parceiras). Elas entram por um link de teste, instalam **e usam de
  verdade** — desde 2026 o Google checa se os testadores **realmente abriram/usaram**
  o app, não basta instalar e deixar parado. Escolha gente que vai abrir algumas vezes.
  Isso adiciona ~2 semanas ao caminho até produção.
  > O número é **12** (o Google baixou de 20 → 12 em dez/2024; se vir "20" em algum
  > lugar, é tela/guia desatualizado).

Planeje: **conta → build → teste interno → teste fechado (14 dias) → produção.**

---

## Passo 0 — Criar a conta no Google Play Console

1. Acesse `play.google.com/console` e entre com a conta Google **da marca**
   (`cortavo.app@gmail.com`), nunca com uma conta pessoal.
2. Escolha o tipo: **Pessoal** (mais rápido, mas cai na regra dos 12 testadores) ou
   **Organização** (precisa de dados da empresa; isenta da regra).
3. Pague a **taxa única de US$ 25**.
4. Faça a **verificação de identidade** (documento + endereço). Pode levar de horas a
   alguns dias — comece por aqui, é o gargalo.

---

## Passo 1 — Preparar a máquina Windows

1. **Android Studio** (`developer.android.com/studio`) — ele já traz o Android SDK e
   um JDK. É o caminho mais fácil pra buildar e assinar no Windows.
2. Node.js você já tem (é o do servidor).
3. Na pasta do projeto, instale a tooling do Capacitor + a plataforma Android + o
   plugin de splash (que já configuramos):
   ```bash
   npm i -D @capacitor/cli
   npm i @capacitor/core @capacitor/android @capacitor/splash-screen @capacitor/assets
   ```
   > Obs.: essas deps são só pro build do app. Se preferir não misturar com as deps do
   > servidor (que vão pro VPS), dá pra separar depois num workspace próprio — mas pra
   > começar, funciona no mesmo projeto.

---

## Passo 2 — Gerar o projeto Android + ícones/splash

1. Gere a plataforma Android (cria a pasta `android/`):
   ```bash
   npx cap add android
   ```
2. Gere ícones e splash a partir da arte (mesma fonte do iOS —
   `design/icone-1024-appstore.png`, PNG 1024×1024, RGB sem alpha):
   ```bash
   npx @capacitor/assets generate --android
   ```
3. Sincronize a config (leva o `capacitor.config.json` — fundo branco, splash — pro
   projeto Android):
   ```bash
   npx cap sync android
   ```

---

## Passo 3 — Keystore de assinatura (GUARDE COM A VIDA)

A keystore é a identidade permanente do app. **Se você perdê-la, nunca mais consegue
publicar uma atualização** — teria que lançar um app novo do zero. Faça backup dela
(e da senha) em pelo menos dois lugares seguros (gerenciador de senhas + nuvem privada).

Gerar (o `keytool` vem com o JDK do Android Studio):
```bash
keytool -genkey -v -keystore cortavo-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias cortavo
```
Guarde: o arquivo `cortavo-release.jks`, a senha da keystore, o alias (`cortavo`) e a
senha do alias.

> Ative também o **Play App Signing** no Console (padrão hoje): o Google guarda a chave
> final de assinatura e você usa a sua como "upload key". É a rede de segurança caso a
> sua keystore se perca — mas mesmo assim, faça backup da sua.

---

## Passo 4 — Buildar o AAB assinado

A Play exige **AAB** (Android App Bundle), não APK.

Pelo Android Studio (mais simples no Windows):
1. Abra a pasta `android/` no Android Studio (`npx cap open android`).
2. **Build → Generate Signed Bundle / APK → Android App Bundle**.
3. Aponte a keystore criada no passo 3, informe as senhas/alias.
4. Selecione a variante **release**. O `.aab` sai em
   `android/app/release/app-release.aab`.

Antes de buildar, confira em `android/app/build.gradle`:
- `applicationId "br.com.cortavo.app"`
- `versionCode 1` e `versionName "1.0"` (a cada envio novo, **incremente o
  versionCode** — é o número que a Play usa pra ordenar as versões).
- `targetSdkVersion` recente (a Play exige API 34+ atualmente; o Capacitor atual já
  vem assim).

---

## Passo 5 — Criar o app no Play Console e a listagem

1. **Criar app**: nome "Cortavo", idioma padrão Português (Brasil), tipo App, gratuito.
2. **Ficha da loja (Store listing)**:
   - Descrição curta (até 80 caracteres) e completa (até 4000).
   - Ícone 512×512, imagem de destaque 1024×500, e **no mínimo 2 screenshots** de
     celular (pode tirar do app rodando).
   - Categoria: "Negócios" ou "Produtividade".
3. **Política de privacidade**: `https://cortavo.com.br/privacidade` (já pública).
4. **Classificação de conteúdo**: responda o questionário → deve dar "Livre".
5. **Público-alvo**: adultos (não direcionado a crianças).
6. **Segurança de dados (Data safety)** — declare o que o app coleta:
   - **E-mail e senha** (conta da equipe e do cliente) — para autenticação.
   - **Localização aproximada** (a busca "perto de você" do app do cliente) — se você
     mantiver essa função no Android.
   - Diga que os dados trafegam **criptografados (HTTPS)** e como o usuário pode pedir
     exclusão (você já trata isso na política).

---

## Passo 6 — Subir e testar

1. **Teste interno** primeiro (libera na hora, até 100 testadores): suba o AAB em
   *Testing → Internal testing*, adicione seu e-mail, instale pelo link e confira que
   abre, loga e navega.
2. **Teste fechado** (a regra dos 12 testadores, se conta pessoal): crie a trilha
   *Closed testing*, adicione os 12+ e-mails, e deixe rodando **14 dias**.
3. **Produção**: depois do teste fechado cumprido (ou direto, se conta de empresa),
   promova o AAB para produção e envie para revisão. A revisão do Google costuma ser
   mais rápida e menos rígida que a da Apple.

---

## Pontos de atenção específicos deste app

- **Notificações push NÃO vão funcionar no Android só com o web-push.** Dentro da
  WebView do Capacitor, a API de Push do navegador não existe como no Chrome. Para push
  no Android é preciso **FCM nativo** (`@capacitor/push-notifications` + projeto Firebase)
  — é um trabalho à parte. **Recomendo lançar SEM push no Android primeiro** e adicionar
  depois; o app funciona normal sem isso.
- **Geolocalização**: a busca "perto de você" pede a permissão de localização. No
  Android isso exige a permissão no `AndroidManifest.xml` e o usuário aceitar em runtime.
  Se algo travar, dá pra esconder essa função no Android por ora.
- **Política de "conteúdo mínimo / webview"**: a Play aceita apps que são um site
  empacotado desde que entreguem função real (o Cortavo entrega — agenda, caixa etc.).
  Risco baixo, mas se pedirem, a defesa é a mesma do iOS: é uma ferramenta de gestão,
  não um site qualquer numa janela.
- **Correções de CSS/servidor não exigem novo build** (o app carrega o site ao vivo);
  só mudança **nativa** (config Capacitor, plugin, ícone) exige `npx cap sync android` +
  novo AAB.

---

## Ordem recomendada (resumo)

1. Criar conta no Console + verificação de identidade (começa já — é o gargalo).
2. Instalar Android Studio no Windows.
3. `npx cap add android` → assets → `npx cap sync android`.
4. Gerar a keystore (e **fazer backup dela**).
5. Buildar o AAB assinado.
6. Criar o app + listagem + data safety + classificação.
7. Teste interno → teste fechado 14 dias (se pessoal) → produção.
