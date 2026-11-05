# omp-fork: полное руководство по функциям и возможностям

**Форк:** `spgsroot/oh-my-pi` (main `a1d33f5`), база — upstream `can1357/oh-my-pi` 18.16+
**Установка на этой машине:** команда `omp` указывает на форк-бинарник
(`~/.bun/bin/omp → ~/.local/lib/omp-fork/omp-launcher.sh → ~/.local/lib/omp-fork/omp`).
Профиль — штатный `~/.omp` (ваши модели, skills, MCP — всё как было).
**Откат на оригинальный omp:**
```bash
ln -sf ../install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js ~/.bun/bin/omp
```
**Обновление форк-бинарника после правок в `~/Documents/oh-my-pi`:**
```bash
cd ~/Documents/oh-my-pi && bun run build && rsync -a packages/coding-agent/dist/omp ~/.local/lib/omp-fork/omp
```

---

## 1. Межтерминальное взаимодействие агентов (A2A-мост)

Агенты в **разных терминалах/сессиях** обмениваются сообщениями и статусами по протоколу
A2A v1.0 (Linux Foundation): JSON-RPC 2.0 поверх HTTP, SSE-стриминг, AgentCard.

### Терминал-сервер (в каждом, где хотите принимать сообщения)

```bash
omp --a2a-port 7601 --model giga-osa/glm-5.3
```
- Мост слушает **только 127.0.0.1:7601** (извне недоступен);
- bearer-токен: `~/.omp/a2a.token` (создаётся автоматически, права 600);
- на экране: `A2A bridge listening on http://127.0.0.1:7601`;
- карточка агента: `GET http://127.0.0.1:7601/.well-known/agent-card.json` —
  имя, навыки (живые агенты сессии), capabilities.

### Терминал-клиент (обращается к другим терминалам)

```bash
/a2a add http://127.0.0.1:7601 --token $(cat ~/.omp/a2a.token)
/a2a add http://127.0.0.1:7602 --token $(cat ~/.omp/a2a.token)
/a2a list
```
Каждый навык чужой карточки становится спавнимым агентом `a2a:<имя>`.
**Коллизии имён** (несколько терминалов с навыком `Main`) разрешаются суффиксами:
`a2a:Main` (первый), `a2a:Main-2`, `a2a:Main-3`… Повторное `/a2a add` того же URL
обновляет регистрацию на месте, без суффикса.

### Общение

В клиентском терминале просто просите модель:
> «Спавни a2a:Main-2 с промптом: как дела у тебя в терминале?»

Запрос уходит в живую сессию терминала 2, там создаётся агент, работает, его ответ
возвращается в стандартном конверте `<task-result>`. Статусы по пути: SUBMITTED →
WORKING → COMPLETED/FAILED (TASK_STATE_*), у спавна с задержкой регистрации —
пейдинг с 30-сек. grace. Вводный статус INPUT_REQUIRED вернёт «waiting for input».

### Что видит внешняя сторона (статусы)

`GetTask`/`ListTasks` по JSON-RPC показывают состояние каждой задачи:
running→WORKING, idle+завершён→COMPLETED/FAILED (по наличию output-артефакта),
parked→WORKING, aborted→CANCELED/FAILED. Убитые советники (advisor) скрыты.

### Схема «6 терминалов» (orca)

Да, работает: 6 терминалов, каждый `omp --a2a-port 760X`. Пример с именами T1..T6:

| Терминал | Команда | Роль |
|---|---|---|
| T1 | `omp --a2a-port 7601` | «координатор»: добавляет всех остальных |
| T2–T6 | `omp --a2a-port 7602..7606` | исполнители |

В T1:
```bash
/a2a add http://127.0.0.1:7602 --token $(cat ~/.omp/a2a.token)
/a2a add http://127.0.0.1:7603 --token $(cat ~/.omp/a2a.token)
# ... 7604, 7605, 7606
```
Появятся `a2a:Main` (T2), `a2a:Main-2` (T3), … `a2a:Main-5` (T6) — имена выдаются
по порядку регистрации; `/a2a list` показывает соответствие имя→URL. Дальше T1
раскидывает задачи параллельно (task tool умеет несколько спавнов за один ход),
агенты отвечают каждый из своего терминала. Учтите: **все терминалы должны
использовать один и тот же токен** (`~/.omp/a2a.token` общий, если профили общие).
Терминалы-исполнители также могут добавлять друг друга — граф любой.

Статусы транслируются: карточка каждого терминала содержит его живых агентов,
так что «кто чем занят» видно через `GetTask`/карточку в любой момент.

## 2. chrome-mcp — браузер в вашем реальном Chrome

При старте omp проверяет bridge на `127.0.0.1:12306` (расширение Chrome +
`~/.local/share/mcp-chrome-bridge`). Если жив — 81 инструмент `chrome_*`:
навигация, клики, чтение страниц, вкладки — в Chrome с вашими логинами и
расширениями. Встроенный тул `browser` остаётся как изолированный fallback
(headless-автоматизация). Настройки: `browser.chromeMcp` (default on);
выключение: `disabledServers: ["chrome"]` или `browser.chromeMcp: false`.

Транспорт: современная ревизия MCP 2026-07-28 (streamable-http, `/mcp-new`)
с автоматическим откатом на 2025-06-18. Проверка bridge:
```bash
curl -sS -X POST http://127.0.0.1:12306/mcp-new -H 'Content-Type: application/json' \
  -H 'Mcp-Method: tools/list' -H 'Mcp-Protocol-Version: 2026-07-28' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

## 3. Защита обмена между агентами (ingress-guard IrcBus)

Для сообщений `agent://` между агентами одной сессии (сабагенты, спавны):
- **rate**: 30 «токенов» (симв./4) на отправителя за 500 мс; **одно сообщение
  любого размера всегда проходит**, следующие в том же окне режутся;
- **dedup**: повтор того же текста тому же адресату в течение 30 с — отказ;
- **hops**: цепочка пересылок >28 — отказ (расширяют только wake-relay);
- **backpressure**: очереди aside/interrupt ≤50, избыток отбрасывается.
Настройки: `irc.ingressGuard` (on), `irc.rateLimitTokens` (30),
`irc.dedupWindowMs` (30000), `irc.maxHops` (28). Все отказы — тихие receipt'ы,
не исключения.

## 4. Отказ вместо очереди при перегрузе спавнами

`task.concurrencyPolicy: "refuse"` (default "queue") — при исчерпании
`task.maxConcurrency` спавн возвращает модели внятную ошибку:
`Concurrent subagent limit reached (N running; task.maxConcurrency=L). Do not
retry; wait for running tasks or ask the user to raise task.maxConcurrency.`
Лимит действует на **все** пути спавна: task tool, `/a2a` (внешние),
`pi.spawnSubagent` (расширения), workflow `agent()`.

## 5. Токен-бюджет сабагентов и инструмент handback

- `task.tokenBudget` (0=off): на 50% бюджета агенту в контекст инжектится
  `<total_tokens>N tokens left of M</total_tokens>`, на 90% — подсказка
  завершаться. Выживает у воскрешённых (wake/restore/revive) агентов.
- **handback**: для сабагентов без структурной схемы (`output`) регистрируется
  инструмент финального отчёта — обёртка над yield с фреймом «model output, not
  user text» и защитой от инъекций harness-тегов; один вызов на запуск.

## 6. Workflow — детерминированная JS-оркестрация

Инструмент `workflow({script, resumeFrom?})`:
```js
// script — тело async-функции с контекстом:
const audit = await agent("проверь аудит логов");
const results = await parallel([u1, u2, u3], u => agent(`обработай ${u}`), { concurrency: 2 });
phase("отчёт");
log("готово", results.length);
return audit.result;
```
- `agent(prompt)` — спавн сабагента (с общим лимитом concurrency!);
- `parallel(items, fn, {concurrency})`, `pipeline`, `phase`, `log`, `clock`, `args`;
- **детерминизм**: `require`/`import`/`Date.now`/`Math.random`/`eval`/`process`
  запрещены (внятные ошибки), песочница — allowlist глобалов, синхронный
  таймаут 30 с, отмена по AbortSignal;
- **journal + resume**: каждый вызов агента пишется в журнал сессии; после
  Ctrl-C/убийства `resumeFrom` повторно использует совпавший префикс и
  докручивает только хвост; упавший потомок фиксируется как `failed` и
  перекручивается на resume.

## 7. Capability-токены на деструктивные операции

Одноразовые токены `<8hex>@<id>`, TTL 10 минут. Деструктив (удаление worktree
с несохранёнными изменениями, `proc://<id>/kill` с несохранённым выводом) при
первой попытке возвращает ошибку **с токеном**; повтор с `force: "<token>"`
исполняет. Интерактивные kill в UI не гейтятся.

## 8. Шов для расширений: pi.spawnSubagent

Расширения теперь могут спавнить сабагентов:
```ts
export default function (pi) {
  pi.spawnSubagent({ agent: "scout", prompt: "найди X" }).then(ref => ...);
}
```
Права обычного сабагента, общий лимит concurrency. (Кандидат на PR в апстрим.)

---

## Настройки — сводка

| Настройка | Default | Что делает |
|---|---|---|
| `a2a.enabled` / `--a2a-port` | off / 7391 | A2A-мост (только 127.0.0.1) |
| `a2a.clientTimeoutMs` | 0 (без лимита) | таймаут клиентских спавнов |
| `browser.chromeMcp` | on | автодискавери chrome-mcp bridge |
| `irc.ingressGuard` | on | гард сообщений agent:// |
| `irc.rateLimitTokens` | 30 | rate per-sender за 500 мс |
| `irc.dedupWindowMs` | 30000 | окно дедупликации |
| `irc.maxHops` | 28 | предел цепочки пересылок |
| `task.concurrencyPolicy` | "queue" | "refuse" = отказ при переполнении |
| `task.tokenBudget` | 0 (off) | токен-бюджет сабагента |

## Известные ограничения

- `hops` расширяют только wake-relay; ручной ответ агента начинает цепь заново;
- pending-спавн A2A после 30 с grace получает FAILED (поллинг GetTask по taskId);
- `refusalReason` телеметрии v1 — только concurrency_limit;
- выключение chrome через per-server `enabled:false` не работает — используйте
  `disabledServers: ["chrome"]`;
- workflow не прерывает async-цикл после первого await (только sync-часть).

## Отличия от upstream omp (кратко)

| Область | upstream | форк |
|---|---|---|
| Кросс-терминальный обмен агентами | нет | A2A-мост (сервер+клиент) |
| Браузер по умолчанию | изолированный Chrome for Testing | ваш Chrome (chrome-mcp) |
| Anti-flood в IrcBus | нет | rate/dedup/hops/backpressure |
| Перегруз спавнами | тихая очередь | опциональный refuse с числами |
| Токен-бюджет | нет (только requests) | `<total_tokens>` в контексте |
| Оркестрация workflow | нет | VM + journal + resume |
| Деструктив | без подтверждения | одноразовые capability-токены |
| Спавн из расширений | нет | pi.spawnSubagent |