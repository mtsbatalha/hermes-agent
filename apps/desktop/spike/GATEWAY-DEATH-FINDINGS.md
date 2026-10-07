# Morte do gateway após `browser.close()` com turno em voo — repro + correção

> Status: **reproduzido de forma determinística** (2/2 corridas). **F1 aplicada** no workspace
> (HEAD `25bd0b9d`) com testes de regressão; F2/F3 permanecem propostas, não aplicadas.
> Alvo do pedido: `tui_gateway`. Ambiente: Windows 11, git-bash, gateway do workspace (HEAD `25bd0b9d`) via
> `sys.executable -m hermes_cli.main serve --host 127.0.0.1 --port 0` com LLM fake local (`StallMidStream`).

## 1. Resumo

A morte do gateway **não** vem do caminho WS (socket drop + turno travado). Esse caminho é saudável: o reaper
de órfão interrompe o turno e recupera a sessão sem derrubar o processo.

A morte vem do **watchdog de morte do processo-pai** (`hermes_cli/web_server_lifecycle.py`,
`_start_parent_death_watchdog`): `hermes serve` guarda o PID do processo que o criou (em produção o processo
principal do Electron/Desktop — o "browser" que o usuário fecha). Quando esse PID desaparece, o backend se
auto-encerra com **SIGTERM** → `rc=15`. Com um turno em voo, o turno é interrompido no meio do stream.

Isso é **por design** (um backend não deve sobreviver ao Desktop que o possui). O que falha é a
**opacidade e a ausência de defesas contra falso-positivo** desse encerramento — que é justamente o que o
usuário viu: "o gateway parou de escutar", sem evidência clara do porquê.

## 2. Reprodução determinística

Reprodutor: [`_gw_death_repro.py`](_gw_death_repro.py) (temporário; reusa
[`tests/e2e/core/terminal/_gateway_client.py`](../../../tests/e2e/core/terminal/_gateway_client.py) e
[`tests/fakes/fake_llm_provider.py`](../../../tests/fakes/fake_llm_provider.py)).

```bash
cd hermes-agent
V=.../venv            # venv pm que executa o código do WORKSPACE (websockets 15.0.1)
PYTHONPATH="$PWD" "$V/Scripts/python.exe" apps/desktop/spike/_gw_death_repro.py \
    --mode orphan --watch 45 --probe-at 20 --parent-kill-at 1 --tag orphan2
```

`--mode orphan` faz exatamente o roteiro pedido:

1. sobe o backend com um *watch-parent* controlado e `HERMES_PARENT_PID=<pid do pai>`
   (contrato "Desktop antigo": só PID, sem marker/nonce);
2. `session.create` + `prompt.submit` com provider que trava no meio do stream → `message.delta`
   (turno comprovadamente em voo);
3. `client.drop()` — `shutdown(SHUT_RDWR)` sem close frame, ou seja um **`browser.close()` real** (não um
   `websocket.close()` educado);
4. mata o watch-parent (o "browser"/Desktop fechando);
5. observa a liveness HTTP por `--watch` s e faz um probe de nova sessão em socket novo.

Resultado (2 corridas, `_gw-death-repro-orphan.json` e `_gw-death-repro-orphan2.json`):

| corrida | drop → morte do pai | morte do gateway | rc |
|---|---|---|---|
| orphan  | 2.0s                | +6.07s           | **15 (SIGTERM)** |
| orphan2 | 1.0s                | +2.01s           | **15 (SIGTERM)** |

```
[   9.81s] socket_dropped {'abrupt': True}
[  10.81s] watch_parent_killed {'pid': 10816, 'after': 1.0}
[  11.82s] gateway_exited {'rc': 15, 'secondsAfterDrop': 2.01}
VERDICT GATEWAY_DIED  rc=15
```

## 3. Mecanismo exato (timeline com as linhas reais)

```
# 1) o cliente (browser) some — o caminho SAUDÁVEL faz o certo:
agent.log: tui_gateway.ws: ws closed peer=127.0.0.1:62581 reason=client_disconnect(code=1006,reason=)
           messages=3 parse_errors=0 dispatch_crashes=0 send_failures=0
           reaped_sessions=0 detached_sessions=1

# 2) o pai morre; o watchdog acorda no próximo poll (default 2s) e dispara SIGTERM:
errors.log: WARNING hermes_cli.web_server: Parent-death watchdog: desktop PID 21912 appears orphaned
            (expected_start_marker=None); shutting down.
stderr:     ⚡ Interrupted during API call.

# 3) o handler de SIGTERM interrompe o turno e sai:
agent.log: tui_gateway.server: tui turn finished: ui_session=4782fabb ...
           status=interrupted error_retained=False duration=4.7s
#    e o processo morre por SIGTERM (rc=15)
```

Código no caminho:

- [`hermes_cli/web_server_lifecycle.py:363`](../../../hermes_cli/web_server_lifecycle.py#L363)
  `while not _is_serve_orphaned(...)` → no **primeiro** True chama
  [`_request_orphan_shutdown()`](../../../hermes_cli/web_server_lifecycle.py#L302), que arma um
  *timer* de teto de 10s e faz `signal.raise_signal(SIGTERM)`.
- [`tui_gateway/session_reaper.py:151`](../../../tui_gateway/session_reaper.py#L151)
  `_handle_exit_flush_signal`: `_flush_sessions_before_exit()` → `_stop_turns_before_exit()`
  (settle `_EXIT_TURN_SETTLE_S = 0.5s`, L117) → handler anterior (uvicorn, `timeout_graceful_shutdown=3`).
- [`tui_gateway/entry.py`](../../../tui_gateway/entry.py): `_log_signal` (L116) grava o stack no
  `tui_gateway_crash.log`, imprime `[gateway-signal] SIGTERM` no stderr e arma `_hard_exit`
  (grace 1.0s, L68). `_log_exit` (L172) é quem imprime `[gateway-exit] reason=...`.

## 4. O que **não** é a causa (descartado com experimento)

| hipótese | veredito |
|---|---|
| socket drop abrupto (1006) mata o processo | **não** — `GATEWAY_SURVIVED` em `clean`, `stall` (200s) e `stall` com `grace=3` forçando o reaper |
| turno travado + cliente sumido | **não** — o ciclo `client_gone interrupt` → `status=interrupted` → `client_gone reap` roda inteiro |
| `send deadline` / backpressure do WS | não reproduzido (corrida de backpressure ficou inconclusiva; o `_close_socket(1011)` só fecha o socket) |
| idle-exit | **não** — `web_server_idle_exit` é escopado a SSH (`--ssh-session-token-file`); `should_exit_idle` ainda exige turno parado |
| job object `KILL_ON_JOB_CLOSE` no Windows | **não** — o job é criado e possuído pelo **próprio** gateway (`attach_self_to_kill_on_close_job`) |
| scale-to-zero | **não** — `gateway/scale_to_zero.py` é específico de Fly (`FLY_APP_NAME`/`FLY_MACHINE_ID`) |

## 5. Correção aplicada: F1 — watchdog só age após leituras consecutivas

**Aplicada** em [`hermes_cli/web_server_lifecycle.py`](../../../hermes_cli/web_server_lifecycle.py):

- Nova constante `_ORPHAN_SHUTDOWN_CONFIRMATIONS = 2` (junto de `_ORPHAN_EXIT_CEILING_S`); cada leitura
  positiva de `_is_serve_orphaned` incrementa um contador, e **qualquer leitura saudável zera o streak**
  (oscilação do probe = inconclusiva, o backend segue servindo). Só após 2 leituras consecutivas o loop
  chama `_request_orphan_shutdown()`.
- Testes de regressão em [`tests/hermes_cli/test_serve_parent_watchdog.py`](../../../tests/hermes_cli/test_serve_parent_watchdog.py):
  `test_parent_watchdog_needs_more_than_one_orphaned_reading` (blip único não mata; o loop continua
  fazendo polls) e `test_parent_watchdog_still_reaps_after_consecutive_orphaned_readings` (pai morto de
  verdade ainda dispara o SIGTERM, via handlers de flush). Ambos escritos antes do patch e vistos falhar
  no código antigo (RED), verdes depois (GREEN). Suite dos arquivos relacionados: **252 passed, 5 skipped**.
- Validação e2e com o repro (corrida `orphan3`, [`_gw-death-repro-orphan3.json`](artifacts/_gw-death-repro-orphan3.json)):
  pai morto 1.0s após o drop → gateway morreu **+5.08s** depois do pai (2 polls de 2.0s), `rc=15` — ou
  seja, a detecção genuína continua funcionando, agora com o dobro de evidência exigida.

Custo da defesa: a latência de encerramento sobe de ~1 poll para ~2 polls (2s → 4s com o poll default).
Aceitável: o Desktop já está morto nesse cenário, ninguém está esperando.

### Restantes (propostas, não aplicadas)

### F1 ~~(recomendada)~~ — **APLICADA** (ver seção 5)
`_start_parent_death_watchdog._loop` encerrava na **primeira** leitura positiva de `_is_serve_orphaned`.

### F2 (tui_gateway) — o motivo do encerramento não é persistido nem visível
Hoje o único rastro é 1 WARNING no `errors.log` + 1 linha no crash log. A sessão persiste com
`end_reason = NULL` e o turno só diz `status=interrupted`, sem causa. O operador/cliente não distingue
"o Desktop fechou" de "crashou".
→ Propagar um motivo (`parent_death`) do watchdog para o teardown do `tui_gateway`
(`session_reaper._handle_exit_flush_signal` / `entry._log_exit`) e carimbá-lo em
`sessions.end_reason` (`owner_gone`) + uma linha `[gateway-exit] reason=parent_death interrupted=[sid...]`.
Assim o Desktop, ao reconectar, mostra "backend encerrado porque o app fechou" em vez de um silêncio.

### F3 — orçamento de settle do turno é curto e não configurável
`_EXIT_TURN_SETTLE_S = 0.5s` enquanto o teto do órfão é 10s e o graceful do uvicorn é 3s. Uma resposta
quase pronta é cortada antes de achar o ponto de checkpoint.
→ Tornar o settle do caminho de encerramento-por-dono maior (ou configurável,
ex. `HERMES_TUI_EXIT_TURN_SETTLE_S`) e limitado pelo teto do órfão.

### Decisão registrada
- O usuário não sabe se o app/Desktop estava fechado na ocorrência real → F1 aplicada como defesa
  contra falso-positivo; F2/F3 ficam registradas como propostas.
- Se a ocorrência foi com o **Desktop/app realmente fechando**: a prioridade é **F2** (o backend morrer
  é esperado; o problema é o silêncio).
- Se o app/Desktop estava **vivo** e só a aba/janela web fechou: isso é **falso-positivo** do watchdog →
  F1 já cobre; vale ainda checar *qual* PID o Desktop passa em `HERMES_PARENT_PID`
  (deve ser o processo principal do Electron, nunca o renderer/webview).

## 6. Limitações

- Corrida `--mode backpressure` não concluída (o 2º boot colidiu com o sandbox da 1ª e o serve saiu antes do
  READY); o eixo backpressure fica como não testado.
- O playtest real roda a **cópia instalada** (`AppData/Local/hermes/hermes-agent`, commit `0e37a439bd`, ~7
  semanas mais antiga). Qualquer correção no workspace precisa ser espelhada/reiniciada para valer no playtest.
- Ambiente Windows: `Backend.stop()` do fixture usa `os.killpg` (inexistente no Windows); o repro captura a
  falha em `cleanStop` e não depende dela.
