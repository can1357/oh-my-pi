# oh-my-pi-team-agents

Исследовательский форк [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) о том, **как кодинг-агенты общаются друг с другом**: агенты в разных терминалах, участники команды внутри одной сессии и ограничители, которые держат межагентный трафик в рамках.

[English](README.md) · [Полное руководство по функциям](FORK-RU.md) · [Сборка и сопровождение](README-fork.md)

<p align="center">
  <img src="docs/media/a2a-cross-terminal.gif" alt="Два терминала omp: builder задаёт вопрос a2a:reviewer, reviewer отвечает, ответ возвращается в builder" width="900">
</p>

## Что исследует форк

Статья [**Внутри Claude Code: как общаются агенты и устроены Agent Teams**](https://llmcrew.org/wiki/claude-code-agent-teams-internals) (Claude Code 2.1.311, статический разбор бинарника) восстанавливает устройство межагентного обмена в Claude Code: маршруты `SendMessage`, файловые почтовые ящики участников, возврат отчётов, восстановление, лимиты и границы доверия.

Этот форк - практическая часть того же исследования: те же задачи, реализованные в открытом агенте и проверенные на настоящих терминалах и моделях. Каждый механизм ниже запускается, и каждый проверен вживую (см. [Проверено вживую](#проверено-вживую)).

| Задача | Claude Code 2.1.311 (по статье) | Этот форк |
|---|---|---|
| Две независимо запущенные сессии | Маршрут `local-session`: JSONL через сокет домена Unix, файл сессии `~/.claude/sessions/<pid>.json` | Мост A2A v1.0: JSON-RPC 2.0 поверх HTTP на `127.0.0.1`, bearer-токен, файл реестра `a2a-bridges/<pid>.json` на процесс |
| Сообщения между участниками команды | Файловые ящики `~/.claude/teams/<team>/inboxes/<agent>.json` | Внутрипроцессная IRC-шина, `write agent://<хэндл>`, с ingress-гардом |
| Описание команды | Служебное состояние в `config.json`, перезаписывается системой | Декларативный файл `.omp/teams/<имя>.md`, запуск `/team start` |
| Общий список задач | `~/.claude/tasks/<team>/` | `TASKS.md` в workspace команды; захват строки - соглашение, а не блокировка |
| Отчёт вызывающему | `SubagentHandback`: один отчёт, обрамление отступами | Инструмент `handback`: один отчёт за запуск, рамка «вывод модели, а не текст пользователя», экранирование служебных тегов |
| От чьего имени звучит сообщение пира | Обёртка `cross-session-message`; локальный журнал хешей (не подпись) | Запрос из другого терминала - это **пользовательский** ход, никогда не developer-сообщение; служебные теги в теле экранируются |
| Управляющий протокол команды | `shutdown_*`, `plan_approval_*`, `idle_notification` | Не реализован |

## Механизмы

### 1. Агенты в разных терминалах (мост A2A)

Каждый процесс `omp` поднимает мост [A2A v1.0](https://a2a-protocol.org) на свободном loopback-порту и записывает себя в локальный реестр мостов. Новая сессия находит живые мосты и делает их главных агентов целями `a2a:<имя>` обычного инструмента `task`.

```mermaid
sequenceDiagram
    participant B as терминал builder
    participant R as терминал reviewer
    B->>R: SendMessage (task a2a:reviewer), messageId=m1
    Note over R: доставлено в диалог reviewer как пользовательский ход
    R-->>B: SendMessage, metadata.inReplyTo=m1
    Note over B: помечено как ответ; ответа на него не требуется
```

- Терминал адресуется по имени: `omp --a2a-name reviewer`; без имени - автоимя `<slug-каталога>-<pid>`.
- Запрос попадает в **главный диалог** принимающего терминала; его агент отвечает сам или поручает работу своим субагентам.
- Ответ связывается с запросом автоматически (`metadata.inReplyTo`). Если главный агент принимающего терминала ответил обычным текстом, а не через `task`, его последний текст хода пересылается отправителю.
- Только loopback, bearer-токен `~/.omp/agent/a2a.token`, методы `SendMessage` / `SendStreamingMessage` (SSE) / `GetTask` / `ListTasks` / `CancelTask`.

Протокол и настройки: [docs/a2a.md](docs/a2a.md).

![Итог: reviewer (слева) ответил, builder (справа) показывает ответ](docs/media/a2a-reply.png)

### 2. Agent Teams (внутри сессии)

Файл команды задаёт участников, хэндлы, общий workspace и протокол работы. `/team start <имя>` запускает каждого участника полноценным субагентом с постоянным хэндлом; участники пишут друг другу напрямую через `agent://<хэндл>` и координируются через `TASKS.md`.

```markdown
---
name: review
description: Two-person code review crew
workspace: ./ws
members:
  - agent: task
    handle: Scout
    role: Find defects in src/
  - agent: task
    handle: Reviewer
    role: Confirm or reject each finding against the code
context: |
  Scout writes each finding to agent://Reviewer and waits for the verdict;
  Reviewer answers agent://Scout with CONFIRMED or REJECTED;
  only Scout reports to the lead. Do not edit src/.
---
Review src/invoice.ts and src/money.ts.
```

<p align="center">
  <img src="docs/media/agent-teams.gif" alt="Лид запускает /team start review; Scout и Reviewer переписываются и сообщают подтверждённые находки" width="760">
</p>

`/team list`, `/team status`, `/team stop [имя|all]`. Включение: `team.enabled: true`; не больше `team.maxTeammates` участников (по умолчанию 4). Подробности: [docs/agent-teams.md](docs/agent-teams.md).

> [!IMPORTANT]
> Выбирайте для участников определения, которым разрешено писать и общаться. Промпт собственного определения участника сильнее контекста команды: встроенный read-only `scout` отказывается трогать `TASKS.md`, а `reviewer` со структурированным выводом отчитывается по своей схеме вместо переписки с пирами. Универсальный агент `task` протоколу команды следует.

### 3. Ограничители межагентного трафика

| Ограничитель | Что ограничивает | Настройка |
|---|---|---|
| IRC ingress-гард | Частота на отправителя, окно дедупликации 30 с, цепочка пересылок ≤ 28, очередь ≤ 50; отказ - квитанция, а не исключение | `irc.ingressGuard`, `irc.rateLimitTokens`, `irc.dedupWindowMs`, `irc.maxHops` |
| Отказ вместо очереди | При исчерпании `task.maxConcurrency` спавн отклоняется с числами и «Do not retry», а не ждёт молча; касается task, A2A, расширений и workflow | `task.concurrencyPolicy: refuse` |
| Токен-бюджет субагента | На 50 % - уведомление `<total_tokens>N tokens left of M</total_tokens>`, на 90 % - указание закругляться | `task.tokenBudget` |
| Capability-токены | Разрушительная операция (удаление грязного worktree, kill агента с несохранённым выводом) сначала отказывает с одноразовым токеном `<8hex>@<id>`; повтор с `force` выполняется | - |
| Права пира | Текст из другого терминала приходит модели пользовательским ходом и не получает прав developer-сообщения | - |

### 4. Детерминированная оркестрация workflow

Инструмент `workflow` исполняет JS-скрипт в песочнице `node:vm` с белым списком глобалов (`agent`, `parallel`, `pipeline`, `phase`, `log`, `clock`, `args`; без `require`, `Date.now`, `Math.random`). Каждый вызов агента пишется в журнал; после kill `resumeFrom` воспроизводит завершённые вызовы из журнала и выполняет только незавершённый хвост. Описание: [docs/tools/workflow.md](docs/tools/workflow.md).

### 5. Прочее

- `pi.spawnSubagent({agent, prompt})` позволяет расширениям запускать субагентов в общем лимите параллельности.
- [chrome-mcp](https://github.com/spgsroot/mcp-chrome-2026-en) автоматически обнаруживается на `127.0.0.1:12306` и становится браузером по умолчанию: инструменты `chrome_*` в вашем настоящем Chrome. Встроенный `browser` остаётся изолированным запасным вариантом.

## Проверено вживую

Прогон 2026-11-08: Windows 11, бинарник собран из `main`, модель `openai-codex/gpt-6.1-sol:high`, настоящие окна терминалов, изолированный профиль (`OMP_PROFILE=agents`). Демо-репозиторий - сервис `ledger` из трёх файлов с заложенной ошибкой на единицу в `total()`.

| Механизм | Сценарий | Результат |
|---|---|---|
| A2A: запрос и ответ | builder спрашивает `a2a:reviewer`, корректна ли `total()` | Ответ через 22 с, помечен как ответ на запрос (GIF выше) |
| A2A: ни разу не запрошенный получатель | Тот же запрос в свежий терминал | До `b7c805f4fb` - 3 сбоя из 3 (запрос приходил developer-сообщением, модель спрашивала «что сделать?»); после исправления - ответ |
| A2A: ответ обычным текстом | Получатель отвечает в своём чате, не вызывая `task` | Переслан отправителю с `inReplyTo` |
| Agent Teams | `/team start review`, `/team status` | Оба участника заняли строки в `TASKS.md`, Scout и Reviewer переписывались, Scout отправил лиду подтверждённые находки |
| Agent Teams с определениями `scout`/`reviewer` | Та же команда на встроенных определениях | Участники проигнорировали протокол команды (см. примечание выше) |
| Workflow resume | Двухфазный скрипт убит посреди работы, продолжен с `resumeFrom` | Завершённые вызовы взяты из журнала, выполнен только незавершённый |
| Политика отказа | `maxConcurrency: 1`, три параллельных scout | Один выполнен, два отклонены с «Do not retry» |
| Токен-бюджет | Бюджет 30 000 токенов, субагент читает все файлы | Вставлено `<total_tokens>13896 tokens left of 30000</total_tokens>` |
| `handback` | Субагент завершает работу отчётом из 3 строк | Отчёт доставлен в рамке. Один из ранних прогонов с `task.structured: true` помечен `failed (exit 1)` после успешного `handback`; не расследовано |
| `pi.spawnSubagent` | Инструмент проектного расширения запускает scout | Результат scout вернулся в вызывающую сессию |
| chrome-mcp | Список окон и вкладок | Перечислены окна настоящего Chrome |
| Capability-токен при kill | `proc://<agent>/kill` | Вживую не сработал (транскрипт агента уже был на диске, несохранённой работы не было); покрыт `test/capability-token.test.ts` |

Тесты механизмов: `test/a2a-*.test.ts`, `test/session/irc-bridge-relay.test.ts`, `test/irc-*.test.ts`, `test/teams.test.ts`, `test/workflow.test.ts`, `test/token-budget.test.ts`, `test/handback.test.ts`, `test/capability-token.test.ts`.

## Быстрый старт

Сборка из исходников (Bun ≥ 1.4.4 и Rust-тулчейн для нативного модуля):

```sh
git clone https://github.com/spgsroot/oh-my-pi-team-agents.git
cd oh-my-pi-team-agents
bun install
bun --cwd=packages/natives run build
bun run --cwd packages/coding-agent build
./packages/coding-agent/dist/omp --version
```

Держите форк отдельно от рабочего `omp`: запускайте его бинарник со своим профилем, например `OMP_PROFILE=agents`. Дальше:

```sh
# терминал 1
omp --a2a-name reviewer
# терминал 2
omp --a2a-name builder
#   > read agent://              (в списке есть a2a:reviewer)
#   > Спроси a2a:reviewer, корректна ли total() в src/invoice.ts.

# команды
omp config set team.enabled true
#   > /team start review
```

Подробности сборки, синхронизация с upstream и обёртка с изолированным профилем: [README-fork.md](README-fork.md).

## Известные ограничения

- Ответ по A2A зависит от того, выполнит ли модель-получатель инструкцию конверта; пересылка текстового ответа работает только для главного агента принимающего терминала, не для его субагентов.
- A2A работает только в пределах машины (loopback). Участия в команде из другого терминала нет.
- Нет управляющего протокола команды: нет подтверждения завершения, утверждения плана и уведомлений о простое.
- Захват строк в `TASKS.md` - соглашение; два участника могут править одну строку.
- Отложенный A2A-спавн после 30 с ожидания получает статус FAILED; дальше опрашивайте `GetTask` по id задачи.
- Workflow не может прервать асинхронные продолжения после первого `await`.

Полный список: [FORK-RU.md](FORK-RU.md#известные-ограничения).

## Документация

| Тема | Документ |
|---|---|
| Протокол A2A, настройки | [docs/a2a.md](docs/a2a.md) |
| Формат файла команды, команды `/team` | [docs/agent-teams.md](docs/agent-teams.md) |
| Инструмент workflow | [docs/tools/workflow.md](docs/tools/workflow.md) |
| Все функции и настройки форка | [FORK-RU.md](FORK-RU.md) · [README-EN.md](README-EN.md) |
| Upstream omp (установка, провайдеры, инструменты) | [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) |

## Лицензия

MIT, унаследована от [oh-my-pi](https://github.com/can1357/oh-my-pi), который является форком [Pi](https://github.com/badlogic/pi-mono) автора [@mariozechner](https://github.com/mariozechner). Дополнения форка - [spgsroot](https://github.com/spgsroot).
