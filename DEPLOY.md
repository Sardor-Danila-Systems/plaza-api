# Деплой backend (plaza-api)

Инструкция для развёртывания API на Render + Neon — той связке, что уже
используется. Всё, что ниже, выполняется из этого репозитория
(`plaza-api`). Фронтенд деплоится отдельно, см. `plaza-web/DEPLOY.md`.

Порядок операций жёсткий: **БД → миграции → API → фронтенд**. API стартует
даже при недоступной БД (`GET /health` отдаст 503), поэтому «сервис
поднялся» не значит «всё работает» — проверяйте именно `/health`.

---

## 1. База данных (Neon)

1. Создайте проект в [neon.tech](https://neon.tech), регион — ближайший к
   региону Render-сервиса.
2. Скопируйте **Pooled connection string** (в нём уже есть
   `?sslmode=require`). Отдельный `DIRECT_URL` не нужен: приложение
   использует `@prisma/adapter-pg` с одной строкой подключения и для
   миграций, и для рантайма.
3. Эта строка пойдёт в `DATABASE_URL`.

Бэкапы: на бесплатном тарифе Neon хранит историю ~7 дней (point-in-time
restore). Для продакшена включите платный тариф — иначе восстановить
данные после ошибочной миграции будет нечем.

## 2. Переменные окружения

Полный список с описаниями — в `.env.example` и в таблице README. Минимум,
без которого приложение не стартует:

| Переменная          | Значение для продакшена                                              |
| ------------------- | -------------------------------------------------------------------- |
| `NODE_ENV`          | `production`                                                         |
| `PORT`              | Render подставляет сам; не задавайте вручную                         |
| `DATABASE_URL`      | pooled-строка из Neon                                                |
| `JWT_ACCESS_SECRET` | ≥32 случайных символа: `openssl rand -base64 48`                     |
| `JWT_ISSUER`        | `euro-plaza-backend`                                                 |
| `JWT_AUDIENCE`      | `euro-plaza-frontend`                                                |
| `CORS_ORIGIN`       | **точный** origin фронтенда, например `https://plaza.example.com`    |
| `SWAGGER_ENABLED`   | `false`                                                              |
| `LOG_LEVEL`         | `log`                                                                |
| `COOKIE_SAMESITE`   | `lax` или `none` — см. ниже                                          |
| `COOKIE_DOMAIN`     | **обязательно**, если API и фронтенд на разных поддоменах — см. ниже |

Отдельно про три пункта, на которых ломается чаще всего:

- **`CORS_ORIGIN`.** Пустое значение отключает CORS полностью — браузер
  тогда режет каждый запрос фронтенда ещё до попадания в роуты, и в UI это
  выглядит как «всё грузится вечно / пустые списки», а не как ошибка. Origin
  указывается без завершающего слэша и с тем же протоколом, что в адресной
  строке. Несколько origin — через запятую.
- **`JWT_ACCESS_SECRET`.** Смена секрета мгновенно инвалидирует все выданные
  access-токены: все пользователи будут разлогинены. Это нормальная реакция
  на утечку, но не делайте этого «заодно» с обычным релизом.
- **`COOKIE_SAMESITE`.** Refresh-токен живёт в cookie. При `lax` (значение
  по умолчанию) браузер вернёт эту cookie только если фронтенд и API
  находятся в пределах одного регистрируемого домена — `app.example.com` и
  `api.example.com` подходят, `plaza.vercel.app` и `plaza-api.onrender.com`
  **нет**. Во втором случае симптом коварный: вход проходит, а через 15
  минут (TTL access-токена) пользователя молча выбрасывает на логин, потому
  что `/auth/refresh` не получает cookie. Лечение — либо посадить оба
  сервиса на поддомены одного домена (предпочтительно), либо выставить
  `COOKIE_SAMESITE=none`; во втором случае оба сервиса обязаны работать по
  HTTPS. Защиту от CSRF это не ослабляет: она построена на отдельной паре
  cookie + заголовок, а не на SameSite.
- **`COOKIE_DOMAIN`.** Отдельная и **обязательная** настройка, даже если вы
  уже сделали «предпочтительный» вариант выше (api.example.com +
  app.example.com на одном домене). Без неё у cookie вообще нет атрибута
  `Domain` — она host-only, видна **только** хосту, который её выставил
  (`api.example.com`), а не соседним поддоменам. `SameSite=Lax` тут не
  спасает: он лишь разрешает браузеру ОТПРАВИТЬ cookie при обычном
  cross-site запросе, но не делает cookie видимой на другом хосте через
  `document.cookie`. А именно так фронтенд читает `csrf_token` (через
  скрытый iframe/страницу на своём же пути `/auth/csrf-bridge`) — без
  `COOKIE_DOMAIN` это чтение всегда возвращает пусто, `/auth/refresh`
  получает пустой `X-CSRF-Token`, отвечает 403, и пользователя молча
  разлогинивает при каждом обновлении страницы (access-токен живёт только
  в памяти браузера). Значение — домен с ведущей точкой или без (браузеры
  трактуют одинаково), например `COOKIE_DOMAIN=.example.com` — тогда cookie
  видна на `api.example.com`, `app.example.com` и любом другом поддомене.

### Вложения (attachments)

По умолчанию `STORAGE_DRIVER=local`, то есть файлы пишутся на диск
контейнера. **На Render это означает потерю всех вложений при каждом
редеплое** — файловая система эфемерна. Для продакшена обязательно:

```
STORAGE_DRIVER=s3
S3_ENDPOINT=...            # для AWS S3 можно не задавать
S3_REGION=...
S3_BUCKET=...
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=true   # для MinIO / Supabase Storage
```

Бакет должен быть приватным: файлы отдаются только через
`GET /projects/:id/attachments/:id/download` с проверкой прав.

## 3. Сервис на Render

Тип — **Web Service**, окружение Node, регион рядом с Neon.

```
Build Command:  npm ci && npm run build
Start Command:  npm run start:prod
Health Check Path: /health
```

Замечания:

- `npm ci` запускает `postinstall: prisma generate` — клиент Prisma
  генерируется в `src/generated/prisma/` и в репозиторий не коммитится, так
  что без этого шага сборка упадёт.
- Node 24+ (задайте `NODE_VERSION=24` в переменных окружения, если Render
  предлагает более старый).
- Health check: `/health` возвращает 503, пока БД недоступна. Это то, что
  нужно — Render не переведёт трафик на инстанс с мёртвой БД.

## 4. Миграции

Миграции **не запускаются автоматически** при старте приложения — это
осознанно: два инстанса, стартующих одновременно, мигрировали бы БД
параллельно.

Перед первым запуском и при каждом релизе, где в `prisma/migrations/`
появились новые папки:

```bash
DATABASE_URL="<pooled-строка-из-Neon>" npx prisma migrate deploy
```

Запускать локально (с прод-строкой в переменной окружения) либо через
Render Shell. Никогда не используйте `prisma db push` и `migrate dev`
против продакшена — только `migrate deploy`.

Текущий релиз содержит миграцию `20260923120000_writeoff_optional_floor`
(списание материала на блок целиком, без этажа). Она обратно совместима:
делает `StockWriteOff.floorId` необязательным, существующие строки не
меняет. Откат (если понадобится) — только при отсутствии списаний с
`floorId IS NULL`:

```sql
ALTER TABLE "StockWriteOff" DROP CONSTRAINT "StockWriteOff_floor_snapshot_consistency_check";
ALTER TABLE "StockWriteOff" DROP CONSTRAINT "StockWriteOff_projectId_blockId_fkey";
ALTER TABLE "StockWriteOff" ALTER COLUMN "floorId" SET NOT NULL;
ALTER TABLE "StockWriteOff" ALTER COLUMN "floorLabelSnapshot" SET NOT NULL;
```

## 5. Проекты и пользователи

Самостоятельной регистрации нет и эндпоинта создания проекта или
пользователя нет тоже (ADR 0014). Всё заводится через один и тот же
операторский CLI, который **обязан** работать из собранного `dist/`
(ADR 0015) — и, в отличие от `prisma/seed.ts`, прекрасно работает при
`NODE_ENV=production`, это и есть его назначение:

```bash
npm run build

# Проект и первые учётные записи:
npm run provision -- create-project --name "Euro Plaza" --code euro-plaza

CREATE_USER_PASSWORD='длинная случайная фраза' \
  npm run provision -- create-user \
  --role OWNER --email owner@example.com --name "Имя Фамилия"

CREATE_USER_PASSWORD='другая случайная фраза' \
  npm run provision -- create-user \
  --role PROJECT_MANAGER --email manager@example.com --name "Имя Фамилия" \
  --project euro-plaza

# Изменить роль/проект уже существующего пользователя — set-role/assign-manager:
npm run provision -- set-role --user someone@example.com --role ACCOUNTANT

# Полная справка:
npm run provision -- --help
```

`create-user` — единственный production-safe способ создать первую
учётную запись (`prisma/seed.ts` отказывается работать при
`NODE_ENV=production`, и это осталось так же). Пароль читается **только**
из переменной окружения `CREATE_USER_PASSWORD` — никогда не передаётся
флагом, чтобы не остаться в истории shell — и нигде не логируется. Минимум
12 символов. Для `PROJECT_MANAGER` обязателен `--project`; назначение
вытесняет текущего активного менеджера этого проекта, как и
`assign-manager`.

Пароли пользователь меняет сам в разделе «Профиль».

## 6. Проверка после деплоя

```bash
curl -s https://<api-host>/health
# {"status":"ok","database":"up","timestamp":"..."}

curl -s -X POST https://<api-host>/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"manager@example.com","password":"..."}'
# {"accessToken":"...","user":{...}}
```

Если `/health` отдаёт `database: "down"` — проблема в `DATABASE_URL`
(чаще всего забыт `?sslmode=require` или взята non-pooled строка).
Если логин работает из curl, но в браузере ничего не грузится — это
`CORS_ORIGIN`.

## 7. Откат

Render хранит предыдущие сборки: «Rollback» в панели возвращает код.
Миграции при этом **не откатываются** — поэтому каждая миграция должна
быть обратно совместимой хотя бы на один релиз назад (текущая — является).
Если релиз содержал несовместимую миграцию, откатывать нужно
восстановлением БД из Neon point-in-time, а не кодом.
