# Cliente Hermes Web — o que é, o que está validado, o que não está

> Documento de estado da branch `spike/web-renderer`, escrito a partir do commit
> `449032b0` (2026-10-09). É um retrato honesto do que foi provado, com o
> comando/artefato que prova cada item, e do que continua aberto. Não é roadmap
> nem proposta de arquitetura.

## 1. O que é este projeto, de fato

Um **cliente Hermes Web**: o renderer do Hermes Desktop servido pelo **próprio
gateway**, no navegador. Não é o Hermes Desktop, não é um app da Nous e não é um
produto novo descolado — é a conversa do Desktop rodando fora do Electron, com o
mesmo renderer (sem fork de UI) e o mesmo contrato.

O renderer já era código de navegador: o poder nativo chega por um único objeto
tipado, `window.hermesDesktop`. O cliente web fornece esse objeto pelo
`packages/web-bridge` e aponta o renderer **sem modificações** para um gateway
vivo. O que o bridge não implementa é declarado e degradado honestamente, não
fingido.

Estado: **validado de ponta a ponta** no escopo documentado abaixo (Fase 0 com
veredito **GO**).

## 2. Validado — com a evidência

| O que foi validado | Evidência | Como reproduzir |
| --- | --- | --- |
| O renderer **boota e pinta em navegador puro**, em dev e no build de produção | [spike/FINDINGS.md](spike/FINDINGS.md) — "Fase 0 verdict: GO" | `node spike/probe.mjs` |
| **Streaming no wire**: `message.start` → `message.delta` → `message.complete`, com o texto real do modelo | [spike/FINDINGS.md](spike/FINDINGS.md) — "Acceptance criterion: met" | `node spike/stream.mjs` |
| **Tool roda fim a fim**: `tool.generating` / `tool.start` / `tool.complete` (os frames que o tool card do Desktop renderiza) | [spike/FINDINGS.md](spike/FINDINGS.md) | `node spike/stream.mjs --message "Use your shell tool to run: echo toolcard-ok."` |
| **Troca de sessão sem contaminação cruzada**, nos dois sentidos, a 1280×900 e a 390×844 | [spike/FINDINGS.md](spike/FINDINGS.md), [spike/README.md](spike/README.md) | `node spike/stream.mjs --width 390 --height 844 --label narrow` |
| **14 cenários de workflow reais** passando em **1280×900** e em **390×844**, `faults: []` | [spike/WORKFLOW-REPORT.md](spike/WORKFLOW-REPORT.md) — "Final results"; [spike/artifacts/workflows/results.json](spike/artifacts/workflows/results.json) (14/14 `passed`, `faults: []`) | `node spike/workflows.mjs` e `node spike/workflows.mjs --viewport 390x844` |
| Cenários: chat wide/narrow, recusa visível de diagnóstico nativo/keychain, recusa visível de reconexão de gateway, save→reload do gateway, persistência de aparência, chip de URL, upload de arquivo com **readback byte-exato**, recusa visível de pasta, turno com anexo, copy de sessão, paste grande, paste de imagem, **drag-and-drop real de imagem** (CDP), terminal xterm | [spike/WORKFLOW-REPORT.md](spike/WORKFLOW-REPORT.md) — tabela "Final results" | idem acima |
| **Auth nos dois modos, verificada de ponta a ponta contra o servidor real**: ungated (token injetado no HTML) e **gated** (login → cookies `HttpOnly` → REST 200/401 → WS com ticket de uso único) | [CAPABILITY-MATRIX.md](CAPABILITY-MATRIX.md) — "Both modes were verified end to end against the real server"; commit `11ab2a81` | `spike/_gated_serve.py` (modo gated); receita de deploy na matrix |
| **Receita de deploy do cliente web** (build do renderer + `HERMES_WEB_DIST` + os dois modos, com sanity checks) | [CAPABILITY-MATRIX.md](CAPABILITY-MATRIX.md) — "Deploying the web client (both modes)" | comandos na seção |
| **Morte do gateway pós-`browser.close()` com turno em voo: repro determinístico** + correção **F1 aplicada** (watchdog exige leituras órfãs consecutivas) com testes de regressão | [spike/GATEWAY-DEATH-FINDINGS.md](spike/GATEWAY-DEATH-FINDINGS.md); código em `hermes_cli/web_server_lifecycle.py` (`_ORPHAN_SHUTDOWN_CONFIRMATIONS`), testes em `tests/hermes_cli/test_serve_parent_watchdog.py` — commit `48bff675`, presente nesta branch | `python spike/_gw_death_repro.py`; `pytest tests/hermes_cli/test_serve_parent_watchdog.py` |
| A harness **não passa por engano**: URL de preview inválida faz o runner sair com código 1 e registrar a falha | [spike/WORKFLOW-REPORT.md](spike/WORKFLOW-REPORT.md) — "Reproduce" | apontar `--url` para um preview inexistente |

## 3. Mobile — o que está fechado e o que não está

**Fechado, no escopo automatizado.** O round 6 rodou a suíte inteira no viewport
de telefone: **14/14 a 390×844 e 14/14 a 1280×900**, `faults: []` nos dois
([spike/WORKFLOW-REPORT.md](spike/WORKFLOW-REPORT.md) — "Mobile narrow round").
Os gates de streaming também passam a 390×844. Só a harness mudou nesse round —
nenhuma mudança de produto e nenhum rebuild —, então a corrida desktop serve
como prova de não-regressão.

O que muda abaixo do breakpoint de **760px** (medido, não presumido):

- O **nav de settings** colapsa de uma rail de botões por seção para um único
  `TabDropdown` cujo menu carrega as seções — a superfície é a mesma, muda o
  caminho até a linha.
- A **sidebar de sessões** sai do grid e vira um **overlay de borda** (medido
  260×824 a 390×844, dois terços do viewport); as linhas só existem no DOM
  quando o overlay monta, e Escape o fecha como camada de topo.
- O layout já era responsivo por natureza: a 390px a sidebar se esconde atrás de
  um controle "Show sidebar" e o chat preenche o viewport.

**Não fechado — com ressalva explícita:**

- ⚠️ **O terminal dockado é inutilizável no telefone.** O painel inferior mede
  **53×99 px (~6 colunas)** a 390×844; a TUI repinta por coluna, então uma linha
  de 23 caracteres não pode ser digitada e lida de volta. O cenário `terminal-ui`
  por isso "empresta" um painel de largura desktop no narrow. É o único painel
  `bottom` e o único sem `collapsible`, então não ganha overlay nem apresentação
  específica — **decisão de produto, deixada em aberto** ([spike/WORKFLOW-REPORT.md](spike/WORKFLOW-REPORT.md)
  — "The docked terminal pane does NOT become an overlay" e item correspondente).
- ⚠️ **390×844 é emulação de viewport em Chromium desktop**, não device real:
  sem teste de toque, sem navegador mobile, sem Safari/Firefox/Android (o
  fallback de file picker para navegadores sem suporte ainda não foi verificado —
  eles reportam o motivo, mas ninguém dirigiu o fluxo).
- ⚠️ **Race do 404 de timeline** (abaixo) aparece nos dois viewports.

## 4. Não validado / aberto — inventário honesto

Itens que **não** foram provados, cada um com o status real:

| Item | Status |
| --- | --- |
| Import de **diretório** no browser (drop de pasta) | Aberto — o probe mostrou `webkitGetAsEntry().isDirectory:false` para arquivo, mas nenhum caminho de cópia de diretório foi dirigido |
| **Copy do canvas do xterm** (seleção no terminal) | Não coberto — menus kebab/contexto exercitam o mesmo membro `writeClipboard`, a seleção do xterm não |
| **404 de timeline** (`GET /api/sessions/<id>/timeline`) no boot, logo após o "New session" | Observado, **não reproduzido em isolamento**; apareceu nos dois viewports do round 6 com id novo a cada corrida. É race product-level em `use-timeline-history.ts` (`sessionCreatedThisRun` + zero mensagens locais → lê antes da linha persistir). Consequência limitada: a rail "Show earlier" daquela sessão fica desabilitada pelo resto da vida da página (é capturado, sem fault nem toast). Não reparado aqui |
| 404 de console em **toda** corrida de streaming | Nunca identificado; não foi demonstrado inofensivo ([spike/FINDINGS.md](spike/FINDINGS.md) — "Not proven, and deliberately not claimed") |
| **Ciclo de vida de sessão** além da troca (deletar, renomear, arquivar) | Não coberto — só a troca foi verificada |
| **Multi-profile / registry multi-host** | Não testado — só um perfil, modo local |
| **Logout / `browser.close()` como gesto de usuário** e o eixo **backpressure** do repro de morte do gateway | Corrida `--mode backpressure` não concluída |
| **F2/F3** do gateway-death (motivo do encerramento persistido; settle do turno configurável) | Propostas, **não aplicadas** ([spike/GATEWAY-DEATH-FINDINGS.md](spike/GATEWAY-DEATH-FINDINGS.md)) |
| Ações completas em toda rota, Git review, troca de perfil | Parcial — algumas famílias do bridge seguem parciais ou com forma imprecisa |
| **GC do staging de upload**: nada reclama diretórios órfãos de um cliente que crashou; remover um chip não é GC server-side; rollback de upload parcial multi-arquivo não implementado | Aberto — há ~114 diretórios residuais acumulados na máquina de teste |
| Fechar o socket do terminal não prova encerramento do child do servidor; este terminal é `hermes --tui`, não paridade com o shell do Desktop | Aberto |
| **Diálogo nativo de arquivo**: só o dialog é simulado (com um `File` real do browser); a UX do dialog nativo não é coberta pela suíte | Aberto por construção |
| Copy de erro do bridge em inglês | Localização completa pendente |

## 5. Onde olhar (índice dos docs)

- [spike/README.md](spike/README.md) — como rodar o spike e o que cada check prova.
- [spike/FINDINGS.md](spike/FINDINGS.md) — o veredito da Fase 0, o que foi provado e o que foi deliberadamente não reivindicado.
- [spike/WORKFLOW-REPORT.md](spike/WORKFLOW-REPORT.md) — os 14 cenários, os bugs reparados, os rounds (clipboard, drag-and-drop, mobile) e o inventário de "still not verified".
- [CAPABILITY-MATRIX.md](CAPABILITY-MATRIX.md) — o que o cliente herda, o que descarta, os dois modos de auth e a receita de deploy.
- [spike/GATEWAY-DEATH-FINDINGS.md](spike/GATEWAY-DEATH-FINDINGS.md) — o repro da morte do gateway e a correção F1.
- [README.md](README.md) — o README oficial do Hermes Desktop (upstream), não deste cliente web.

**Nota de saúde documental (importante para não se perder):** a lista "Still not
verified" do [spike/WORKFLOW-REPORT.md](spike/WORKFLOW-REPORT.md) (linha 568)
ainda cita *"Auth on a public/gated deployment and WebSocket ticket exchange"*
como não verificado — **isso está desatualizado**. O relatório foi commitado em
`fff07cdd` (2026-10-07 **16:08**) e a autenticação gated entrou em `11ab2a81`
(2026-10-07 **17:16**), uma hora depois. A verdade mais nova é a
[CAPABILITY-MATRIX.md](CAPABILITY-MATRIX.md), que registra os dois modos
verificados de ponta a ponta. Ao ler o relatório, cruze com a matrix e com este
documento.
