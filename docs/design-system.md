# Design System do Cortavo (v3)

A fonte de verdade do visual é o **sistema v3** da Dani (squad app-cortavo,
pasta `redesign/v3/`): `design-system.md`, `assinatura.md`, `motion-spec.md`,
`tokens.css`, `componentes.css`, `mola.js`, `movimento.js` e os mockups.

No app, essas peças vivem em:

| Peça | Arquivo |
|---|---|
| Tokens (cor, tipo, espaço, raio, sombra, vidro, movimento) | `public/css/tokens.css` |
| Componentes `cv-` | `public/css/cv.css` |
| Casca do painel (navbar, avisos, peças de tela) | `public/css/cv-telas.css`, `public/js/cv-casca.js` |
| PC (menu lateral, grades) | `public/css/cv-pc.css` |
| Telas | `cv-agenda.css`, `cv-caixa.css`, `cv-comissoes.css`, `cv-secretaria.css` |
| Agenda pública | `public/css/cv-agendar.css` |
| Painel-mestre | `public/css/cv-mestre.css` |
| Molas e movimento (M1 a M8) | `public/js/cv-mola.js`, `public/js/cv-movimento.js` |
| Ícones (Lucide, traço 1.75) | `src/views/partials/icone.ejs` |
| Ícone oficial (C branco com check sobre preto) | `src/views/partials/logo-c.ejs` |

Regras que não mudam:

- Preto e branco com cinzas. **Nenhum azul.** Fonte única: Plus Jakarta Sans
  (`public/fonts`, sem Google Fonts).
- Um objeto preto por tela; vidro só em barra, popover e folha.
- Contraste AA, alvos de 44 px, `prefers-reduced-motion` e
  `prefers-reduced-transparency` respeitados.
- O ícone é sempre o oficial; nunca invertido.

Ainda na pilha antiga (migram em fatias próprias): telas com `pg-sv`
(`suave.css` + `sv-*.css`, cores já apontando para os tokens) e as que usam
`tema-minimal.css`, `painel-app.css` e `painel-novo.css` (fidelidade,
horários e formulários avulsos). Ver o relatório do redesign.
