# omp-fork — русская версия

**Форк [oh-my-pi](https://github.com/can1357/oh-my-pi): межтерминальная сеть агентов (A2A), chrome-mcp как базовый браузер, детерминированный workflow-оркестратор, защиты от шторма агентов.**

- Репозиторий: [spgsroot/oh-my-pi](https://github.com/spgsroot/oh-my-pi), ветка `main` = зеркало upstream + фичи
- Базовая версия upstream: 18.16+ (main `96e4d8eb`)
- [English version](./README-EN.md) · [Полное руководство по настройкам](./FORK-RU.md)

## Что реализовано

### 1. Межтерминальное общение агентов (A2A-мост, протокол A2A v1.0)

Агенты в **разных терминалах/вкладках/сессиях** обмениваются сообщениями и статусами. Каждый терминал может быть и сервером, и клиентом; топология — любая (шина «все со всеми» через `/a2a auto`).

```bash
omp --a2a-port 0        # терминал A: 0 = случайный свободный порт
omp --a2a-port 0        # терминал B: так же
omp --a2a-port 0        # терминал C: ...
```
Авторегистрация включена по умолчанию (`a2a.autoRegister`): каждая новая сессия сама
находит все живые мосты на машине и подключает их соседей — агенты остальных терминалов
видны с первого хода как `a2a:Main`, `a2a:Main-2` … (ручная команда `/a2a auto` тоже
остаётся; отключение — `--no-a2a-auto-register`). Спавн и общение:
> «Спавни a2a:Main-2 с задачей X» — запрос уходит в живую сессию терминала B, ответ возвращается в стандартном конверте `<task-result>`.

- Только `127.0.0.1`, bearer-токен `~/.omp/agent/a2a.token` (mode 600, генерируется автоматически);
- JSON-RPC 2.0: `SendMessage`, `SendStreamingMessage` (SSE с финальными фреймами), `GetTask`, `ListTasks`, `CancelTask`; статусы `TASK_STATE_*`;
- SendMessage без адресата спавнит **нового** агента (полный спавн, ответ несёт agentId);
- таксономия отказов: `AGENT_REJECTED` (−32010), таймаут регистрации → `SUBMITTED`+pending с 30-сек grace;
- реестр мостов `~/.omp/agent/a2a-bridges.json` (pid+порт, мёртвые записи отфильтровываются);
- коллизии одинаковых навыков решаются суффиксами (`a2a:Main-2/-3`), перерегистрация того же URL обновляет на месте.

### 2. chrome-mcp — базовый браузерный механизм

Автодискавери [chrome-mcp](https://github.com/spgsroot/mcp-chrome-2026-en) bridge на `127.0.0.1:12306` при старте сессии: 81 инструмент `chrome_*` в **вашем реальном Chrome** (логины, расширения, куки). Встроенный тул `browser` остаётся изолированным fallback'ом для headless-автоматизации.

- транспорт: modern MCP 2026-07-28 (streamable-http, `/mcp-new`) с авто-откатом на 2025-06-18 (из [PR #14172](https://github.com/can1357/oh-my-pi/pull/14172), авторство сохранено);
- настройка `browser.chromeMcp` (default on); off: `disabledServers: ["chrome"]`;
- probe только на IP-литерал loopback, тихий skip без bridge (CI-safe), пользовательская конфигурация `chrome` не перетирается.

### 3. Защита обмена между агентами (ingress-guard IrcBus)

Для сообщений `agent://` внутри сессии: rate (30 токенов/500 мс на отправителя; **одиночное сообщение любого размера проходит**), dedup (дубликат в 30 с), hops (цепочка ≤28), backpressure (очереди ≤50). Все отказы — тихие receipt'ы. Настройки `irc.ingressGuard`, `irc.rateLimitTokens`, `irc.dedupWindowMs`, `irc.maxHops`.

### 4. Отказ вместо очереди при перегрузе

`task.concurrencyPolicy: "refuse"` — при исчерпании `task.maxConcurrency` модель получает внятную ошибку с числами и «Do not retry» вместо тихого ожидания в очереди. Лимит действует на все пути спавна (task tool, A2A, расширения, workflow).

### 5. Токен-бюджет сабагентов + handback

`task.tokenBudget`: на 50% бюджета в контекст сабагента инжектится `<total_tokens>N tokens left of M</total_tokens>`, на 90% — подсказка завершаться; выживает у воскрешённых агентов (wake/restore/revive). Инструмент `handback` — финальный отчёт сабагента с анти-инъекцией (фрейм «model output, not user text» + экранирование harness-тегов, дедуп один-вызов-на-запуск).

### 6. Workflow — детерминированная JS-оркестрация

Инструмент `workflow({script, resumeFrom?})`: `agent(prompt)`, `parallel(items, fn, {concurrency})`, `pipeline`, `phase`, `log`, `clock`, `args`. Песочница node:vm с **allowlist глобалов** (никаких host-возможностей), запрет `require`/`import`/`Date.now`/`Math.random`/`eval`, синхронный таймаут 30 с, отмена по AbortSignal. **Journal + resume**: каждый вызов агента пишется в журнал, после kill/Ctrl-C `resumeFrom` переиспользует совпавший префикс и докручивает только хвост; упавший потомок фиксируется как `failed` и перекручивается.

### 7. Capability-токены на деструктивные операции

Одноразовые токены `<8hex>@<id>` (TTL 10 минут, in-memory). Деструктив (удаление worktree с несохранёнными изменениями, `proc://<id>/kill` с несохранённым выводом) сначала отказывает с токеном; повтор с `force: "<token>"` исполняет. Интерактивные kill в UI не гейтятся.

### 8. Шов расширений: pi.spawnSubagent

Расширения могут спавнить сабагентов (`pi.spawnSubagent({agent, prompt})`) с правами обычного сабагента и общим лимитом concurrency. Кандидат в upstream-PR.

### 9. Agent Teams

`.omp/teams/<имя>.md` — декларативная команда (members + хэндлы + общий workspace); `/team start` спавнит участников полноценными сессиями с устойчивыми хэндлами (`agent://<хэндл>`), прямым общением teammate↔teammate и общим TASKS.md; гейт `team.enabled`. [docs/agent-teams.md](./docs/agent-teams.md).

## Сводка настроек

| Настройка | Default | Описание |
|---|---|---|
| `a2a.enabled` / `a2a.port` | **on / 0 (авто)** | A2A-мост на свободном порту (только 127.0.0.1); `--a2a-port N` — фикс. порт на запуск |
| `browser.chromeMcp` | on | автодискавери chrome-mcp bridge |
| `irc.ingressGuard` | on | гард сообщений `agent://` |
| `irc.rateLimitTokens` | 30 | rate per-sender за 500 мс |
| `irc.dedupWindowMs` | 30000 | окно дедупликации |
| `irc.maxHops` | 28 | предел цепочки пересылок |
| `task.concurrencyPolicy` | "queue" | "refuse" = отказ при переполнении |
| `team.enabled` / `team.maxTeammates` | off / 4 | declarative agent teams (`.omp/teams/*.md`, `/team start`) |
| `task.tokenBudget` | 0 (off) | токен-бюджет сабагента |

## Установка на этой машине

Команда `omp` указывает на форк-бинарник (`~/.local/lib/omp-fork/omp`, 233 МБ Bun-компилят). Профиль штатный `~/.omp`.

```bash
# откат на оригинальный omp:
ln -sf ../install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js ~/.bun/bin/omp
# обновление форк-бинарника после правок:
cd ~/Documents/LAB/oh-my-pi && bun run build && rsync -a packages/coding-agent/dist/omp ~/.local/lib/omp-fork/omp
```

## Качество

- SDD-исполнение: 13 задач, per-task security/concurrency ревью (4 задачи), финальный whole-branch review закрыт fix-волной (`all_addressed`);
- полный suite: 38443 pass, наши падения = 0 против upstream-baseline;
- корп-контекст в диффе — 0 (публичный форк чист);
- живые прогоны: A2A-спавн через мост, сабагент-цепочка (A2A → main → subagent → ответ), workflow journal-resume после SIGKILL, 81 chrome-тул на обеих ревизиях MCP.

## Происхождение механик

Механики агентного взаимодействия спроектированы по образцу лучших индустриальных практик (multi-agent coordination patterns: адресная доставка с ответным каналом, анти-инъекция отчётов, journal-resume, capability-токены).

### Детали

ingress-guard (rate/dedup/hops/queue-cap) · refuse-вместо-очереди с числами в ошибке · токен-бюджет сабагентов (`<total_tokens>`) · инструмент финального отчёта с анти-инъекцией · workflow-VM (journal + prefix-resume, детерминизм) · одноразовые capability-токены на деструктив. Настройки и детали — [FORK-RU.md](./FORK-RU.md).

## Известные ограничения

`hops` расширяют только wake-relay; pending-спавн A2A после 30 с grace → FAILED (поллинг GetTask по taskId); `refusalReason` v1 — только concurrency; workflow не прерывает async-континуации после первого await. Полный список — [FORK-RU.md](./FORK-RU.md).

## Лицензия / атрибуция

Upstream: [oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT). Форк поддерживает всю лицензию upstream. PR #14172 (streamable-http) — автор spgsroot.