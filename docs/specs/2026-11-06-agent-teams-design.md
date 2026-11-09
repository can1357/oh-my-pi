# Agent Teams — дизайн-аналог Claude Code Agent Teams

**Дата:** 2026-11-06 · **База:** ветка `main`, коммит `b126e9a` · **Статус:** реализовано за гейтом `team.enabled`; ниже сохранён исторический дизайн, актуальное поведение и ограничения описаны в [руководстве Agent Teams](../agent-teams.md).
**Пакет:** `packages/coding-agent` · **Входные карты:** `local://a2a-map.md`, `local://subagent-infra-map.md`, `local://tests-docs-map.md` (ключевые утверждения перепроверены по коду; корректировки — §14)

**Поправка 2026-11-09:** §§1–14 ниже — исторический срез; актуальные изменения
и исправления зафиксированы в [§15](#15-поправка-2026-11-09-протокол-agent-teams).

---

## 1. Зачем (Intent)

Сегодня в omp сессия умеет порождать сабагентов (`task` tool), которые могут обмениваться сообщениями (`IrcBus`, `write agent://<id>`), видят друг друга в ростере (`# Peers` в подсказке сабагента) и переживают парковку/возрождение. Но «команда» как сущность не существует: нет декларативного описания «лид + участники», нет общего пространства команды, нет устойчивых хэндлов участников, нет команды запуска/остановки команды. Каждый спавн — разовый акт главного агента.

Claude Code Agent Teams (экспериментальная функция CC) вводит: lead-сессию + teammates (каждый — отдельная полная сессия со своим контекстом), прямые сообщения teammate↔teammate (не через лида), общий task list с семантикой «заявил задачу», mailbox-файлы на агента, конфиг команды с массивом members (лид несёт тип `team-lead`), переиспользование subagent-определений для teammates (frontmatter: tools/model/effort/prompt body), уведомление лида об idle с финальным ответом, shutdown request/approve, отображение in-process vs split-pane (tmux/iTerm2), экспериментальный гейтинг флагом окружения.

Цель этого документа — выбрать архитектуру аналога для форка omp и определить минимальный вертикальный срез wave 2.

Вердикт скаута подтверждён поиском по исходникам: `teammate|AgentTeam|teamId|teams/` в `packages/coding-agent/src/` — **0 совпадений**. Понятия «команда» в коде нет; ~80% примитивов (markdown-агенты, реестр, шина, общий cwd) уже есть.

## 2. Цели (Goals)

1. Пользователь описывает команду одним markdown-файлом (участники + общее пространство + общий контекст) и запускает её одной командой.
2. Каждый teammate — полноценная долгоживущая сессия со своим контекстом, своим транскриптом и своей строкой в Agent Hub (без нового UI).
3. Teammate↔teammate и lead↔teammate общаются напрямую через существующий `IrcBus` (`write agent://<id>`), минуя лида.
4. Участники адресуются устойчивыми хэндлами из файла команды (не `CalmPanda` из генератора имён).
5. Команда останавливается одной командой; транскрипты и возможность revive сохраняются.
6. Функция закрыта экспериментальным сеттингом `team.enabled` (default off) — как в CC.
7. Blast radius минимален: новый модуль + аддитивные опции, ни одного изменения семантики существующих путей спавна/сообщений.

## 3. Не-цели wave 2 (Non-goals)

Отложено осознанно, с причинами — см. §3.1.

- **Split-pane отображение** (tmux/iTerm2): TUI-работа тяжёлая — один только `packages/tui/src/overlays/agent-hub.ts` это 2602 строки; реестр уже даёт бесплатные строки в Agent Hub и в pinned `Subagents`-блоке.
- **Кросс-терминальные команды** (teammate живёт в другом терминале): A2A-мост loopback-only, а канал ответа — конверт в промпте (`a2a/rpc.ts:444-448`), без протокольных гарантий (ограничение №7 в a2a-map). Межтерминальная делегация уже покрыта спавнами `a2a:<name>`; членство в команде через терминалы требует сквозной идентичности `teamId` между реестрами разных процессов — отложено.
- **@mention-парсинг в телах сообщений** (подход B): точная адресация по `agent://<id>` уже работает и обучена этикетом в `# Peers`; парсер упоминаний — отдельное маленькое усиление, не блокирует команду.
- **Инструмент «общий task list с атомарным claim»**: в wave 2 — только файловая конвенция в общем пространстве команды (см. §10.4); семантика конкурентного захвата задач (кто первый записал `owner:`) остаётся соглашением в промпте, не инструментом с блокировками.
- **Горячая перезагрузка файла команды / редактирование состава на лету**: пересоздание команды = `/team stop` + `/team start`.
- **Mailbox-файлы на диске**: в памяти уже есть mailbox на 100 сообщений (`irc/bus.ts:57`, `MAILBOX_CAP = 100`) с пробуждением/ревайвом; дублировать файлами незачем.
- **Наследование plan mode в teammates**: план-режим и так ограничивает спавны (`assertPlanControlsAllowed`, `task/structured-subagent.ts:498`); отдельная семантика не нужна.

### 3.1 Почему отложено — сводка

| Отложено | Причина |
|---|---|
| Split-pane UI | Новый TUI-сефейс ~тысячи строк; Agent Hub уже рисует реестр |
| Кросс-терминальные команды | A2A loopback-only + prompt-based reply; нужен сквозной teamId |
| @mentions | Не блокирует; точная адресация уже есть |
| Task-list-инструмент с claim | Файловой конвенции достаточно для вертикального среза |
| Mailbox-файлы | In-memory mailbox + артефакты `<id>.md` уже покрывают |
| Hot reload состава | Обходится stop/start |

## 4. Анти-цели (Anti-goals)

- **НЕ** строить команду на workflow-VM (подход C): детерминизм и журнал принципиально конфликтуют с живыми долгоживущими сессиями — см. §6.3.
- **НЕ** менять семантику `AgentRegistry`/`IrcBus` под «командность»: видимость остаётся процессно-глобальной (`listVisibleTo`, `registry/agent-registry.ts:171`), команды — надстройка, не изоляция.
- **НЕ** заводить отдельный канал сообщений для команд: весь трафик идёт через существующие `executeSend` → `IrcBus.send` с ingress-гардом (rate 30/500мс, dedup 30с, hops 28).
- **НЕ** создавать параллельную систему определений агентов: участники — это `AgentDefinition` из существующего discovery (`.omp/agents/*.md` и т.д.), файл команды только ссылается на них по имени и добавляет хэндл/роль.
- **НЕ** делать UI-панель команды в wave 2.

## 5. Ограничения и опора на код (Constraints)

Проверено по исходникам (все пути от `packages/coding-agent/src/` если не указано иначе):

| Факт | Где |
|---|---|
| `AgentRef` не имеет teamId; видимость = все живые не-advisor агенты | `registry/agent-registry.ts:66-85`, `listVisibleTo` :171 |
| `IrcBusApi`: `send` (fire-and-forget, receipt `injected\|woken\|revived\|failed`), `wait`, `take`, `unreadCount`, `sentSince` | `irc/bus.ts:74-98` |
| `executeSend`: валидация, broadcast только main, revive parked через `ensurePersistedRoster`, маршрутизация в bus | `irc/messaging.ts:50-121` |
| `write agent://<id>` → `executeSend`; bare `agent://` = ростер (local registry + A2A bridge) | `internal-urls/agent-protocol.ts:175-210`, `:212-251` |
| Шов спавна: `spawnSubagentForSession`/`spawnSubagentViaExecutor` — `detached: true`, `retainArtifacts: true`, `keepAlive: true`, общий spawn-semaphore, `SpawnPendingError` (15 c) | `task/spawn-subagent.ts:64-131` |
| `SpawnSubagentOptions = { agent?, prompt, context? }` | `extensibility/extensions/types.ts:1823-1830` |
| Шов уже инжектирован: расширения (`modes/runtime-init.ts:141`), A2A-сервер (`main.ts:2731`, потребитель `a2a/rpc.ts:463`) | — |
| Id спавна = `sanitizeAgentId(identity?.label) ?? generateTaskName()`; коллизии → суффикс `-2` | `task/structured-subagent.ts:711-719`, `task/name-generator.ts:1573`, суффиксы — `task/output-manager.ts` (`AgentOutputManager`) |
| Разрешение имени агента: `[...discovery.agents, ...sessionAgents, ...a2aAgents]` | `task/structured-subagent.ts:501-505` |
| `buildExecutorOptions` — единая точка сборки опций ребёнка: `enableIrc` :830, `additionalDirectories` :782, `a2aPeers` :785, `parentAgentId` :878 | `task/structured-subagent.ts:767-882` |
| `ExecutorOptions.additionalDirectories` (мульти-корневое пространство) существует | `task/executor.ts:463-465` |
| Ростер пиров: `collectIrcPeerRoster` (running→idle→новизна, лимит 32, parked-счётчик) | `task/executor.ts:421-456`, `DEFAULT_PEER_ROSTER_LIMIT` в `packages/tui/src/tools/irc.ts:4` |
| `# Peers`-блок + этикет в промпте сабагента (ircSelfId/ircPeers/a2aPeers/ircParkedCount) | `prompts/system/subagent-system-prompt.md:29-61` |
| Пробуждённый idle-агент **автоматически отправляет финальный ответ разбудившему** (`wakeRelay: true`, `replyTo`) | `task/executor.ts:3226-3272` (`relayWakeTurnOutput`) |
| Регистрация в реестр ДО сборки system prompt (участники параллельного батча видят друг друга) | `sdk.ts:4544-4560` |
| Discovery: project `.omp/agents` > user `~/.omp/agents` > extension-пакеты > claude-plugins > bundled, first-wins по имени | `task/discovery.ts:77-123`, `docs/task-agent-discovery.md` |
| `AgentDefinition`: name/description/systemPrompt/tools/spawns/model/thinkingLevel/output/blocking/structured/autoloadSkills/readSummarize/prewalk/advisor/source/filePath | `task/types.ts:321-342` |
| `parseAgentFields` отвергает `main`/`sub` | `discovery/helpers.ts:317-333` |
| Workflow-раннер: `enableIrc: false`, `detached: false`, structured: false | `workflow/tool.ts:80-91` (`createWorkflowAgentRunner`) |
| VM: запрет `Date/Math.random/import/eval`, 30 c sync-таймаут, один fan-out | `workflow/vm.ts:239-333` |
| A2A: loopback-only, bearer, реестр `a2a-bridges.json`, reply-конверт в промпте | `a2a/server.ts`, `a2a/rpc.ts:433-457` |
| Настройки A2A/IRC/task: паттерн `register({ id, type, default, ui: { tab, group, … } })` | `task/settings.ts:702-803` (a2a.*), `irc/settings.ts` |
| Шаблон task-параметра `name?` (хэндл спавна) | `task/types.ts:75-98` |

**Вывод:** примитивы для подхода A готовы: именованный долгоживущий IRC-сабагент спавнится швом `spawnSubagentForSession` без единого изменения ядра; общий каталог — через `additionalDirectories`; финальный ответ лиду — через `relayWakeTurnOutput`.

## 6. Три подхода

### 6.1 Подход A — декларативный конфиг команды (`.omp/teams/*.md`) + team-loader поверх discovery

**Суть.** Новый юнит дискавери `.omp/teams/<team>.md` рядом с `.omp/agents/`. Frontmatter команды: `name`, `description`, `workspace` (каталог, относительно файла), `members:` — массив записей `{ agent: <имя AgentDefinition>, handle: <хэндл>, role: <описание роли> }`, `context:` — общий блок, рендерящийся каждому участнику. Body файла — инструкция команде. Загрузчик `task/teams.ts` парсит файл, резолвит каждого участника через существующий `discoverAgents()` (ошибка «unknown agent» с доступным списком — как в `structured-subagent.ts:506-512`), команда запускается слэш-командой `/team start <name> [задание]`, которая через `spawnSubagentForSession` поднимает участников как detached+keepAlive+IRC сабагентов с хэндлами из файла.

**Трейд-оффы**

| Ось | Оценка |
|---|---|
| Persistence | Полная: участники — настоящие сабагент-сессии (транскрипты, park/revive, `history://`, артефакты `<id>.md`). Команда как файл — в git, как запуск — в реестре |
| Кросс-терминальность (A2A) | Участники in-session (IrcBus). Лид и участники видят `a2aPeers` в промпте (`buildExecutorOptions:785`, шаблон `:39-41`) и могут делегировать на `a2a:<name>` других терминалов; сами участники в другой терминал не переезжают (non-goal) |
| Token-стоимость | Максимальная из трёх (полная сессия на участника) — но это и есть семантика фичи; кап `team.maxTeammates` + общий `task.maxConcurrency` (default 32) держат её в узде |
| UI-поверхность | Ноль нового UI: строки в Agent Hub, pinned `Subagents`-блок, `/team status` — текст |
| Blast radius | Средний, почти весь аддитивный: 1 новый модуль (`task/teams.ts`), 1 новая слэш-команда (+1 строка в реестре), 1 опция в `SpawnSubagentOptions`, 2-3 сеттинга, блок в Handlebars-шаблоне промпта. Семантика существующих путей не меняется |
| Оценка объёма | ~700-1000 строк кода + тесты; 5-7 файлов затронуто |

**Файлы:** создать `task/teams.ts`, `slash-commands/builtin-teams.ts`, `prompts/system/team-teammate-preamble.md` (или расширить существующий рендер контекстом); изменить `task/settings.ts` (секция `team.*`), `slash-commands/builtin-registry.ts`, `task/spawn-subagent.ts` + `extensibility/extensions/types.ts` (опция `handle`/`additionalDirectories`), опционально `task/structured-subagent.ts` (инъекция team-контекста).

### 6.2 Подход B — peer-cohort в реестре + только маршрутизация сообщений

**Суть.** Без нового файла: команды образуются ad-hoc. Добавить `teamId?: string` в `AgentRef`/`RegisterInput` (`registry/agent-registry.ts:66, 115`), распознавание `@handle` перед `executeSend` (`internal-urls/agent-protocol.ts` write-путь), рендер роли/handle в `# Peers` (`collectIrcPeerRoster` + шаблон). Лид «назначает» команду, говоря участникам их роль.

**Трейд-оффы**

| Ось | Оценка |
|---|---|
| Persistence | Слабая: `teamId` живёт в реестре процесса; после парковки/рестарта команда — только текст в транскриптах |
| Кросс-терминальность | Лучшая из трёх по дешевизне: `@handle` может резолвиться и в `a2a:`-имена через bridge; но это адресация, не членство |
| Token-стоимость | Минимальная (никого не спавнит) |
| UI-поверхность | Ноль |
| Blast radius | Малый: 3-4 файла, ~200-300 строк |
| Покрытие чек-листа CC | ~20%: нет конфига с members, нет общего пространства, нет shutdown-флоу, нет переиспользования определений. Это улучшение ростера, не команда |

**Файлы:** `registry/agent-registry.ts` (teamId), `internal-urls/agent-protocol.ts` + `irc/messaging.ts` (mention→id), `task/executor.ts` (`collectIrcPeerRoster`), `prompts/system/subagent-system-prompt.md`.

### 6.3 Подход C — оркестрованная команда через workflow tool (`team()` рядом с `agent()`)

**Суть.** Хелпер `team(members, {assignment})` в `WORKFLOW_PRELUDE` (`workflow/vm.ts:239` рядом с `agent()`): участники = спавны с IRC-обвязкой, лид = сам workflow-скрипт, координация — фазы скрипта, durability — journal + `resumeFrom`.

**Почему это бьёт по архитектуре (фатально):**

1. **Журнал кэширует значения, а не сущности.** `WorkflowJournal` (`workflow/journal.ts`) пишет `{runId, index, promptHash, agent, result, tokens, status}`; `resumeFrom` подменяет вызов закэшированным результатом. Живой handle участника несериализуем — его нельзя закэшировать и переиграть. Либо хелпер возвращает только id (и теряет смысл), либо ломает модель кэша.
2. **Детерминизм против диалога.** VM запрещает `Date/Math.random/import` и живёт по `clock()`; переписка участников — это недетерминированные события реального времени. Каждый `IrcBus.send/wait` пришлось бы журналировать как вызов агента — а replay повторно отправит сообщения, которые ingress-гард dedup'нет через 30 c или которые уже неактуальны.
3. **Раннер сегодня `enableIrc: false`, `detached: false`** (`workflow/tool.ts:88-89`) — семантика «скрипт завершается, участники живут дальше» противоречит «workflow завершён = все agent()-вызовы завершены».
4. **Один fan-out за раз** (`vm.ts:290-297`, `poolDepth`) — произвольный граф командных коммуникаций не выражается.

| Ось | Оценка |
|---|---|
| Persistence | Журнал есть, но модель не подходит для живых сессий (пункты выше) |
| Кросс-терминальность | `assertNotRemoteA2aAgent` в VM уже отвергает `a2a:` — хуже всех |
| Token-стоимость | Как A, плюс накладные на журнал |
| UI | Ноль |
| Blast radius | Высокий риск: трогает инварианты workflow (детерминизм, журнал, kill-resume — всё покрыто тестами `workflow.test.ts` с SIGKILL-смоуком) |
| Вердикт | **Отклонён** |

**Файлы (если бы делали):** `workflow/vm.ts`, `workflow/tool.ts`, `workflow/journal.ts`.

### 6.4 Сводное сравнение

| Критерий | A: конфиг команды | B: cohort+mentions | C: workflow-team |
|---|---|---|---|
| Persistence участников | ✅ полная | ⚠️ в памяти процесса | ❌ ломает журнал |
| Кросс-терминальный reach | ⚠️ делегация через `a2a:` | ✅ дешёвые упоминания | ❌ гвард A2A |
| Token-стоимость | высокая (=фича) | минимальная | высокая |
| Новый UI | нет | нет | нет |
| Blast radius | средний, аддитивный | малый | высокий, рискованный |
| Чек-лист CC (§8) | ~75% | ~20% | ~35% |
| Объём | ~700-1000 строк | ~200-300 | ~500-800 + риск |

## 7. Коммуникационная история по подходам

- **A (рекомендуемый):** внутри команды — чистый **IrcBus**: teammate↔teammate напрямую (`write agent://<handle>` —siblings видят друг друга через `listVisibleTo`), lead↔teammate тем же путём. Уведомление лида об idle с финальным ответом — **уже существует**: `relayWakeTurnOutput` (`task/executor.ts:3226`) автоматически отправляет итог пробуждённого хода разбудившему (`wakeRelay: true`, `replyTo`, дедуп `sentSince`). Кросс-терминальная часть остаётся у A2A-моста как есть: участники видят `a2aPeers` в промпте и могут спавнить агентов других терминалов; участник в другом терминале — non-goal (§3).
- **B:** тот же IrcBus; `@handle` расширяется до `a2a:`-имён — межтерминальная адресация дешёвая, но нет ни команды, ни пространства, ни lifecycle.
- **C:** сообщения пришлось бы тащить через IrcBus внутрь VM с журналированием каждого send — конфликт с детерминизмом (§6.3).

## 8. Сверка с чек-листом Claude Code Agent Teams

| Возможность CC | В omp сегодня | При подходе A (после wave 2) |
|---|---|---|
| Lead + teammates, свой контекст у каждого | ✅ есть: любой спавн = полная сессия (`createAgentSession`, `sdk.ts:4544`+); «лид» = main-сессия | без изменений; лид = main |
| Прямые сообщения teammate↔teammate | ✅ есть: `IrcBus` + `write agent://<id>` между сиблингами, `# Peers`-этикет в промпте | без изменений |
| Общий task list с claim | ❌ нет | ⚠️ частично: файл `TASKS.md` в workspace команды + конвенция в промпте (§10.4); атомарный claim-инструмент — non-goal |
| Mailbox-файлы | ⚠️ эквивалент: in-memory mailbox (cap 100) + артефакты `<id>.md` | без изменений (файлы не делаем) |
| Конфиг команды с members | ❌ нет | ✅ `.omp/teams/*.md` |
| Переиспользование subagent-определений для teammates | ✅ базис: `AgentDefinition` + discovery; ❌ связи с командой нет | ✅ members ссылаются на agent-имена, фронтмэтч (tools/model/effort) действует как есть |
| Устойчивые хэндлы участников | ⚠️ `task`-параметр `name` уже даёт хэндл спавну; шов `spawnSubagentForSession` хэндл не принимает | ✅ опция `handle` в шве, хэндл из файла команды |
| Idle-уведомление с финальным ответом | ✅ есть: `relayWakeTurnOutput` — пробуждённый агент отправляет ответ будильщику | без изменений |
| Shutdown request/approve | ⚠️ есть kill/revive по одному (Agent Hub `x`/`r`, `AgentLifecycleManager.release` с tombstone) | ✅ `/team stop` — пакетный release всех участников; approve-диалог не нужен (не интерактивный запрос) |
| In-process vs split-pane | ⚠️ in-process уже есть (Agent Hub); split-pane нет | in-process; split-pane — non-goal |
| Экспериментальный гейтинг | — | ✅ `team.enabled` (default false) |

## 9. Решение: подход A

**Рекомендация — A (декларативный конфиг + team-loader), с элементом B (@mentions) как кандидат на wave 3.**

Обоснование по ограничениям форка:

1. **Loopback-only A2A** и prompt-based reply-канал (`a2a/rpc.ts:444-448`) делают кросс-терминальное членство ненадёжным по конструкции — A честно держит команду in-session, а межтерминальную делегацию оставляет существующим `a2a:`-спавнам, которые участники видят в своём промпте уже сегодня (`a2aPeers`).
2. **Примитивы IrcBus готовы целиком**: адресная доставка, receipts, wake/revive, ingress-гард, ростер в промпте, автоматический финальный ответ (`relayWakeTurnOutput`). A не добавляет ни одного нового механизма сообщений — только множит существующий.
3. **UI-поверхность нулевая**: Agent Hub и pinned-блок уже рисуют всё, что регистрируется в `AgentRegistry`; TUI-панель (2600+ строк класса `AgentHubOverlayComponent`) не нужна.
4. **Blast radius мал и аддитивен**: ядро (registry/bus/executor) не трогается; новый модуль `task/teams.ts` + слэш-команда + одна опция в `SpawnSubagentOptions` + сеттинги.
5. **Шов `spawnSubagentForSession` переиспользуется напрямую**: он уже инжектирован в трёх местах (`modes/runtime-init.ts:141`, `main.ts:2731`, A2A), уже даёт `detached/keepAlive/retainArtifacts` и общий spawn-semaphore (`task.maxConcurrency`, `task.concurrencyPolicy` — включая refuse-режим из FORK-RU §4). Команда ложится на этот путь без нового хоста.
6. **B отвергнут как основной** — не закрывает чек-лист CC (нет persistence/конфига/lifecycle); **C отвергнут** — ломает инварианты workflow (детерминизм/журнал, §6.3).

## 10. Как: минимальный вертикальный срез wave 2

### 10.1 Формат файла команды

`.omp/teams/<team>.md` (project) и `~/.omp/agent/teams/<team>.md` (user), project-first, first-wins по имени команды — зеркально правилам `discoverAgents` (`task/discovery.ts:77-123`):

```markdown
---
name: audit
description: Команда аудита логов и отчёта
workspace: ./teams/audit-workspace   # относительно файла; отсутствует = cwd сессии
members:
  - agent: scout        # имя из discovery (.omp/agents и т.д.)
    handle: Scout       # хэндл = id в реестре/agent://
    role: Сбор логов и метаданных
  - agent: reviewer
    handle: Reviewer
    role: Проверка находок
context: |
  Общее пространство команды: .omp/teams/audit-workspace.
  Задачи заявляйте в TASKS.md (owner: <handle>), результаты — в отчёты.
---
Инструкция команде: аудит охватывает сервисы X и Y; финальный отчёт собирает лид.
```

Парсинг — тем же `parseFrontmatter`/ленIENT-путём, что и агенты (`discovery/helpers.ts`); плохой файл команды — warning + skip (один файл не валит дискавери, как в `loadAgentsFromDir`, `task/discovery.ts:53-74`). Участник с неизвестным `agent` — ошибка на `/team start` со списком доступных агентов (формат ошибки из `structured-subagent.ts:506-512`). `handle` прогоняется через `sanitizeAgentId` (`task/name-generator.ts:1573`), коллизии id решает `AgentOutputManager` суффиксом `-2` (существующий контракт).

### 10.2 Файлы

**Создать:**

| Файл | Содержимое |
|---|---|
| `packages/coding-agent/src/task/teams.ts` | `TeamDefinition`, `TeamMember`, `parseTeamFile()`, `discoverTeams(cwd, home)`, `resolveTeamMembers(team, agents)` (валидация ссылок на `AgentDefinition`) |
| `packages/coding-agent/src/slash-commands/builtin-teams.ts` | `/team start <name> [задание]`, `/team list`, `/team status`, `/team stop <name\|all>` |
| `packages/coding-agent/src/prompts/system/team-member-context.md` | Handlebars-шаблон командного контекста участника (имя команды, роль, workspace, ссылка на TASKS.md-конвенцию) |
| `packages/coding-agent/test/teams.test.ts` | Тесты по §11 |
| `docs/agent-teams.md` | Пользовательская документация (§12) |

**Изменить:**

| Файл | Изменение |
|---|---|
| `packages/coding-agent/src/task/settings.ts` | Секция `team.*` (§10.3) |
| `packages/coding-agent/src/slash-commands/builtin-registry.ts` | `...BUILTIN_TEAMS_SLASH_COMMANDS` в `BUILTIN_SLASH_COMMAND_REGISTRY` (по образцу `BUILTIN_A2A_SLASH_COMMANDS`, `:47`) |
| `packages/coding-agent/src/extensibility/extensions/types.ts` | `SpawnSubagentOptions` += `handle?: string`, `additionalDirectories?: string[]` |
| `packages/coding-agent/src/task/spawn-subagent.ts` | Прокинуть `handle` → `identity.label` (вместо `options.agent` как label) и `additionalDirectories` в `runStructuredSubagent`-запрос |
| `packages/coding-agent/src/task/structured-subagent.ts` | `StructuredSubagentRequest` += `additionalDirectories?: string[]`; merge в `buildExecutorOptions` (`:782`: `additionalDirectories: [...(session.additionalDirectories ?? []), ...(request.additionalDirectories ?? [])]`) |
| `packages/coding-agent/src/prompts/tools/task.md` | Не требуется (участники не рекламируются в task tool как агенты; спавн идёт через `/team`) |
| `FORK-RU.md`, `README-EN.md`, `README-RU.md`, `packages/coding-agent/CHANGELOG.md` | §12 |

### 10.3 Настройки (`task/settings.ts`, стиль `a2a.*`)

| Setting | Default | Назначение |
|---|---|---|
| `team.enabled` | `false` | Экспериментальный гейт: `/team start` без него отказывает с сообщением, называющим настройку |
| `team.maxTeammates` | `4` | Кап участников на команду; отказ с числами (как refuse-сообщение concurrency в FORK-RU §4) |

UI-вкладка `tasks`, группа `Teams` — по образцу группы `A2A` (`task/settings.ts:702-713`). Общие лимиты наследуются: `task.maxConcurrency` (32), `task.concurrencyPolicy`, spawn-semaphore шва.

### 10.4 Поведение среза

1. `/team start audit "проведи аудит"`: гейт → дискавери → резолв участников → для каждого `spawnSubagentForSession(session, { agent: m.agent, prompt: teamBody + задание, context: teamContext + role, handle: m.handle, additionalDirectories: [teamWorkspace] })` — последовательно (cap check перед каждым), с тем же semaphore/permit-путём.
2. Участники регистрируются в `AgentRegistry` до сборки их system prompt (`sdk.ts:4544-4560`) → видят друг друга в `# Peers` сразу; хэндлы из файла = id = `agent://<handle>`.
3. Общение: существующий `write agent://<handle>`; лид получает финальные ответы автоматическим wake-relay'ем; участник-участнику — напрямую (broadcast по-прежнему только main, `irc/messaging.ts:65-68`).
4. `/team status` — таблица хэндл/статус/активность из реестра; `/team stop` — для каждого участника `AgentLifecycleManager.global().release(id, ref, { tombstone: true })` (тот же путь, что kill из Hub, `task/executor.ts:3761`) — транскрипты остаются, revive доступен.
5. TASKS.md — файловая конвенция в `context` команды; никакого инструмента.

## 11. Тест-план (контракты → тесты, `test/teams.test.ts`)

По правилам AGENTS.md (bun:test, contract-level, без `mock.module()`, `vi.spyOn` + `vi.restoreAllMocks()`, `Settings.isolated()`, `AgentRegistry.resetGlobalForTests()` / `IrcBus.resetGlobalForTests()` / `AgentLifecycleManager.resetGlobalForTests()`, `TempDir.createSync("@teams-")`).

| # | Потребительский контракт | Тест |
|---|---|---|
| 1 | Пользователь запускает команду из файла: все участники появляются в реестре с хэндлами из файла | `/team start` по tempfile-команды из 2 участников → `AgentRegistry.global().get("Scout")` и `get("Reviewer")` живы, `kind === "sub"`, spawn через фейковый executor (`SpawnSubagentExecutor`-сейм, как в a2a-тестах) |
| 2 | Плохой файл команды не ломает остальные | 2 файла в tempdir, один с невалидным frontmatter → второй дискаверится, первый skipped, warning в логе |
| 3 | Участник с неизвестным агентом даёт внятную ошибку | members ссылается на `nosuch` → start возвращает ошибку со списком доступных агентов (формат как `structured-subagent.ts:510-512`) |
| 4 | Гейт `team.enabled: false` | start отказывает, сообщение называет `team.enabled` |
| 5 | Кап `team.maxTeammates` | команда из 3 участников при max=2 → стартуют 2, отказ называет числа и настройку |
| 6 | Коллизия хэндлов | два участника с handle `Scout` → второй получает `Scout-2` (контракт `AgentOutputManager`); повторный start той же команды → суффиксы не конфликтуют со живыми |
| 7 | Общее пространство команды | после спавна с workspace → в опциях executor'а (`SpyOn` на executor.run) присутствует `additionalDirectories` с абсолютным путём workspace |
| 8 | `/team stop` переводит участников в aborted и сохраняет revive | после stop рефы `aborted`/tombstone, `isResumable(ref)` true (`registry/agent-registry.ts:101-104`), повторный start той же команды возможен |
| 9 | `/team list` и `status` отображают реальное состояние | список = имена из дискавери; status = хэндлы со статусами из реестра |
| 10 | Хэндл-проп шва | `spawnSubagentViaExecutor` с `handle: "Bob"` резервирует id `Bob` (spyOn `executor.reserveId`) — без handle поведение неизменно (label = agent) |

Существующее покрытие, на которое опираемся и НЕ дублируем: доставка/roster/wake-relay (`irc-bus.baseline.test.ts`, `task/peer-message-after-report`, `irc-guard.test.ts`), инвариант name==id (`irc-name-id-invariant.test.ts`), spawn-отказы (`spawn-refusal.test.ts`), seams (`a2a-server.test.ts` spawnSubagentViaExecutor).

Команды прогона: `cd packages/coding-agent && bun test test/teams.test.ts`; полные — `bun run test` (см. tests-docs-map §6).

## 12. Док-план

- **`docs/agent-teams.md`** (новый, EN, стиль `docs/collab.md`/`docs/agent-hub.md`): шапка-цитата, `## Source` (src/test/fork-notes — по паттерну `docs/tools/workflow.md`), формат файла команды, команды `/team`, networking-семантика (IrcBus, wake-relay), ограничения, настройки. Внимание: `scripts/generate-docs-index.ts` глобит `docs/**/*.md` — файл автоматически попадёт в docs-индекс бинарника (как и этот спека; согласовано с существующей практикой `docs/ERRATA-*.md`).
- **`FORK-RU.md`**: новая §9 «Команды агентов (Agent Teams)» — формат файла, пример, таблица network-семантики; строки в «Настройки — сводка» (`team.enabled`, `team.maxTeammates`); строка в «Отличия от upstream»; пункт в «Известные ограничения» (нет split-pane, нет кросс-терминального членства, claim — конвенция).
- **`README-EN.md` / `README-RU.md`**: по одному буллету в списке фич.
- **`packages/coding-agent/CHANGELOG.md`**: `[Unreleased] → Added` — одна строка, user-facing.
- Проверка сборки: `bun run build` (реген docs-индекса подхватит новый файл).

## 13. Что осталось строителю (open decisions)

1. **Точка инъекции team-контекста в промпт участника**: чистый вариант — собрать всё в `context`-параметр шва (zero новых рендеров); альтернатива — отдельный Handlebars-блок в `subagent-system-prompt.md`. Срез (§10.2) выбирает `context`; если промпт-тесты покажут дублирование с `# Peers`, перенести блок в шаблон.
2. **Резервирование id участников до спавна**: сейчас `spawnSubagentViaExecutor` резервирует по одному; для атомарности `/team start` можно зарезервировать все хэндлы upfront (`reserveStructuredSubagentId` для каждого) и передать `identity.id` — тогда частично упавший start не займёт чужие хэндлы. Решить при имплементации; контракт-тест №6 покрывает оба варианта.
3. **`/team start` из сабагента (lead ≠ main)**: шов доступен любому `ToolSession`; нужен ли вложенным командам depth-гард сверх `task.maxRecursionDepth` (default 2) — предложить оставить как есть (наследуется) и покрыть тестом отказа.
4. **Имена конфликта handle vs. существующие id сессии**: `AgentOutputManager` уже даёт `-2`; убедиться, что `task`-параметр `name` и team-handle живут в одном пространстве аллокаций (один `agentOutputManager` на сессию) — тест №6.
5. **Wave 3 (не в этом срезе):** @mention-парсинг (элемент B), split-pane, кросс-терминальное членство через A2A (после протокольного reply-канала), claim-инструмент.

## 14. Корректировки к картам

1. **subagent-infra-map §4(d)** — «roster ids auto-generated, not user-chosen handles»: **уточнение**. Пользовательские хэндлы уже существуют: task-параметр `name` (`task/types.ts:76` `"name?": "string"`) доходит до `identity.label` (`task/index.ts:2040`) и становится id через `sanitizeAgentId(identity?.label) ?? generateTaskName()` (`task/structured-subagent.ts:718`). Отсутствует не создание хэндлов, а (a) приём хэндла швом `spawnSubagentForSession` (там label = имя агента, `task/spawn-subagent.ts:98`) и (b) парсинг упоминаний — оба закрывает срез §10.2.
2. **subagent-infra-map §5.2** — `buildExecutorOptions` указан на `:799`: фактически `structured-subagent.ts:767`.
3. **subagent-infra-map §2** — `class IrcBus` на `:107`: фактически `irc/bus.ts:100`.
4. **a2a-map §3** — `#runA2aSpawn` на `:2140`: фактически `task/index.ts:2136`; `deps.spawn` вызывается в `a2a/rpc.ts:463` (карта: `:458`). `#ownA2aIdentity` подтверждён на `:2114`.
5. **subagent-infra-map §5.3** — «fuzzy `notFoundError` matching at agent-protocol.ts:63»: подтверждено косвенно (Did-you-mean документирован в `docs/blob-artifact-architecture.md:187`); точную строку не проверял — не критично для решения.
6. **tests-docs-map §1 (вербатим «workflow enableIrc»)** — подтверждено: `createWorkflowAgentRunner` ставит `enableIrc: false` (`workflow/tool.ts:88`); это усиливает отклонение подхода C.

---

**Итог:** рекомендуемый подход — **A** (`.omp/teams/*.md` + team-loader + `/team`-команды поверх шва `spawnSubagentForSession`), коммуникации — существующий IrcBus, UI — существующий Agent Hub, гейт — `team.enabled`. Вертикальный срез: 5 новых файлов, 5 правок, 10 контракт-тестов, 5 док-файлов.

## 15. Поправка 2026-11-09: протокол Agent Teams

**§9 остаётся в силе:** выбран подход A — декларативные `.omp/teams/*.md`,
обычные долгоживущие сабагенты через `spawnSubagentForSession`, существующие
IrcBus и Agent Hub, экспериментальный гейт `team.enabled` (по умолчанию `false`).
Команда остаётся внутри одного процесса; split-pane и кросс-терминальное
членство не добавлены. Ведущий — фактическая сессия запуска, не обязательно Main.
Эта поправка заменяет противоречащие ей утверждения исторических §§3–13.
Полный пользовательский контракт и примеры — в [руководстве Agent Teams](../agent-teams.md).

### Расширения

- **Атомарные задачи вместо файловой конвенции (§§3, 8, 10.4).**
  Main-owned `TeamRuntime` проверяет сессию, поколение команды и текущий ref;
  worker-потоки обращаются к нему через thread-сервис. `read team://<team>/tasks`
  возвращает строки `{id, title, owner, status, note}`. Ведущий добавляет задачу
  через `write team://<team>/tasks`; `tasks/<id>/claim` определяет владельца по
  вызывающей сессии, возвращает идемпотентный успех тому же владельцу или конфликт
  с именем другого владельца. `tasks/<id>/release` и `tasks/<id>/done` доступны
  владельцу или ведущему; тело `done` — заметка.
- При `workspace` источник истины — `tasks.json`, а `TASKS.md` генерируется,
  не редактируется участниками. Необязательный `tasks:` задаёт начальные названия
  только нового реестра; существующий сохраняет задачи и владельцев. Без
  `workspace` реестр живёт в памяти поколения команды, не в cwd. Старый
  `TASKS.md` без `tasks.json` вызывает отказ с инструкцией переноса, без потери
  его содержимого; повреждённый JSON также не заменяется молча.
- Мьютекс по каноническому пути `tasks.json` объединяет чтение, проверку,
  атомарную замену реестра и генерацию представления, в том числе для двух
  команд с одним workspace. **Защита действует только внутри одного процесса
  omp** и не предотвращает внешнюю правку `tasks.json`; другие процессы не
  должны одновременно использовать этот workspace. Ошибка генерации после
  фиксации реестра явно сообщает, что изменение уже сохранено; следующий
  доступ восстанавливает представление.
- **Управление:** `/team stop [--force] <name|handle|all>` без `--force`
  отправляет запрос с `requestId`. Только адресованный участник отвечает через
  `write team://<team>/stop/<requestId>`: `ack` освобождает его текущий ref с
  tombstone; `decline: <причина>` или таймаут уведомляют ведущего без
  принудительной остановки. `team.stopAckTimeoutMs` по умолчанию `120000`;
  минимум — 1000 мс. `--force` освобождает сразу; уже aborted вне `/team stop`
  участник также освобождается сразу. Намерение остановки pending-спавна
  сохраняется до регистрации. Полная остановка команды завершает поколение
  после удаления участников; остановка по handle его сохраняет. Запросы
  остановки и runtime-уведомления об одобрении/отклонении плана обходят только
  списание ingress rate budget. Запросы остановки проходят dedup; уведомления
  о плане, как прочие progress-сообщения, уже освобождены от dedup. Подача плана
  участником, idle и decline/timeout-уведомления остаются rate-limited.
  Hop/delivery-проверки сохраняются для всех этих сообщений.
- **План:** `planApproval: true` у команды или участника включает отдельный
  шлюз; явный `false` участника перекрывает значение команды. План подаётся
  участником через `write team://<team>/plan`; ведущий использует
  `/team approve <handle>` или `/team reject <handle> <причина>`.
  До одобрения доступны только чтение/поиск, read-only действия LSP, `wait`,
  координационные записи и завершение хода через `yield`/`handback`.
  Шлюз не включает session plan mode и не расширяет права роли после одобрения.
  Подача, одобрение и отклонение плана — уведомления-не-запросы.
  Даже при недоступном или устаревшем поколении `yield`/`handback` доступны:
  они не меняют состояние команды. Ведущий с живым поколением команды не
  паркуется по idle TTL: таймер перевзводится, участники и полномочия `/team stop`
  сохраняются. После завершения всех поколений обычная парковка возобновляется.
  Настоящее закрытие сессии по-прежнему завершает её поколения; очистка участников
  при выходе Main остаётся ответственностью lifecycle manager.

### Исправления, не новые возможности исходного дизайна

- Противоречивая сборка промпта исправлена: `team-prompt` — относительный файл
  внутри каталога определения агента; bundled scout/reviewer имеют встроенные
  командные варианты с сохранением запрета менять репозиторий. Read-only
  определения и `team: false` без командного промпта не допускаются к запуску.
  Добавленный `write` ограничен координацией `agent://` и `team://` независимо
  от xdev; существующее полное право `write` сохраняется. Обычные спавны
  по-прежнему используют основной промпт.
- Утверждение §§7–8, что `relayWakeTurnOutput` уже даёт уведомление о простое,
  было неверным: wake-relay возвращает ответ разбудившему, а не наблюдает
  переходы состояния команды. Теперь отдельная подписка на `running → idle`
  отправляет фактическому ведущему уведомление со ссылкой на участника и
  доступными первыми строками результата (не более трёх строк и 500 символов).
  При отсутствии текста используются аргументы финального `yield`/`handback`;
  пустая строка без результата не добавляется. Повторное idle не дублируется,
  но текстовый stop и отдельный ход после yield-reminder могут дать два уведомления.
  Командные уведомления отображаются как «team notice; no reply needed» и могут
  завершать адресованный получателю `wait`, не создавая обязательства автоответа
  или wake-relay-цикла. Обычные progress-сообщения не завершают `wait`.
- Вывод `FAILED` только по времени ожидания регистрации — дефект, а не
  допустимая семантика. **Исправление pending-spawn `FAILED` относится к W3**
  [дизайна исправлений](2026-11-08-review-fixes-design.md#w3-a2a-ожидающий-спавн),
  а не к реализации плана протокола Teams: A2A-спавн остаётся `SUBMITTED`,
  пока не разрешится промис регистрации; отказ регистрации завершает его
  ошибкой. Teams сохраняют уже существующее различие pending/failed,
  не объявляют спавн неудачным только из-за истечения ожидания.