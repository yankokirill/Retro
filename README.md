# Retro

Доска для ретроспектив в реальном времени. Учебный проект курса «Современные
методы разработки программных продуктов с помощью методов ИИ». Архитектура,
инварианты и план работ — в [`CLAUDE.md`](./CLAUDE.md) и
[`docs/spec/consistency-model.md`](./docs/spec/consistency-model.md).

## Запуск с нуля

Нужны Node.js 24+ (см. `.nvmrc`) и Docker.

```bash
npm install
docker compose up -d db
npm run dev:server   # в отдельном терминале: npm run dev:web
```

Сервер поднимется на `http://localhost:3000` (`GET /healthz` → `{"status":"ok"}`),
фронтенд — на адресе, который выведет Vite (обычно `http://localhost:5173`).

Переменные окружения сервера — в `apps/server/.env.example`; скопируйте в
`apps/server/.env` при первом запуске.

## Проверки

```bash
npm run check
```

Одна команда: форматирование и линт (Biome), типы (`tsc -b`), трассируемость
требований (`check:trace`: каждое REQ из `docs/spec/requirements.md` входит в
задачу `docs/tasks.md`, у выполненных задач есть тесты с ID требования), тесты
(Vitest по всем workspace-пакетам, включая property-тесты fast-check в
`packages/crdt`). Красный прогон — работа не считается готовой (см. `CLAUDE.md`,
правило 2).

Спецификация: `docs/brief.md` → `docs/spec/requirements.md` →
`docs/spec/consistency-model.md` и `docs/spec/protocol.md` → `docs/tasks.md`.

## Миграции базы данных

```bash
docker compose up -d db
npm run db:migrate   # применить миграции из apps/server/drizzle/
npm run db:generate  # сгенерировать новую миграцию из apps/server/src/db/schema.ts
```

## Структура репозитория

```
apps/server/    Fastify + WebSocket + REST + SSR
apps/web/       React SPA
packages/crdt/       ядро CRDT доски (заготовка — см. docs/spec/consistency-model.md)
packages/protocol/   общие схемы протокола WS/REST (заготовка)
docs/           бриф, спецификация, ADR, отчёты
.claude/        скиллы, агенты и хуки для агентной разработки
```

## Статус

Веха В1 «Продукт поднимается» (курс, неделя 2). Полный план — `CLAUDE.md` § 8.
