# Раздельное размещение UAI

[Оглавление](README.md) · [Операции](OPERATIONS.md) · [План распределённого выполнения](DISTRIBUTED_EXECUTION_PLAN.md)

Шаблоны в `deploy/` разделяют backend на три узла. Это проверенная основа запуска, а не завершённая production-приёмка. Публичный продукт LogoPanel и его объединённая административная оболочка собираются своим проектом. Runtime-образ ниже содержит API, scheduler, workers и миграции UAI; браузерная админка и demo в него не входят.

## Роли

| Узел | Шаблон | Процессы |
|---|---|---|
| Данные | `deploy/compose.data.yaml` | PostgreSQL 17, Redis 7.4 с AOF и noeviction |
| Приложение | `deploy/compose.app.yaml` | API, scheduler; отдельная ручная команда миграций |
| Исполнение | `deploy/compose.workers.yaml` | generation, observation, maintenance |

API слушает только loopback хоста на порту 4310. Внешний HTTPS и доступ продуктовой админки организует reverse proxy проекта. PostgreSQL/Redis требуют явного `UAI_DATA_BIND_IP`, адреса частной сети или VPN. Откройте их порты только для нужных серверов через firewall. Пароли не заменяют шифрование связи; шаблон рассчитан на защищённую частную сеть/VPN, TLS в нём не настраивается.

## Образ и конфигурация

Соберите образ из корня репозитория:

```sh
docker build -f Dockerfile.runtime -t uai-runtime:release .
```

Установка использует pnpm 9.15.0 и `--frozen-lockfile`. Runtime запускает TypeScript через tsx без dev/watch server. Пользователь контейнера `node`; Compose включает read-only filesystem, tmpfs, удаление capabilities и запрет повышения привилегий. Контекст сборки допускает только нужные исходники и manifests, исключая `.data`, `.env`, keys и node_modules. Для воспроизводимого релиза закрепите базовый образ и опубликованный runtime-образ по digest в своей release-процедуре. Публикация образа в registry здесь не выполняется.

На application и worker узлах задайте `UAI_IMAGE` и абсолютный `UAI_RUNTIME_ENV_FILE`. Файл содержит:

- `DATABASE_URL` и `REDIS_URL` с адресом узла данных и отдельными паролями.
- Одинаковый `UAI_INSTALLATION_ID` для API, scheduler и всех workers данной установки.
- Действующий `UAI_VAULT_KEY` этой установки. Не создавайте новый ключ вместо существующего при обновлении, иначе зашифрованные credentials останутся недоступны.
- S3 bucket, region, endpoint при необходимости, credentials и одинаковый `UAI_S3_PREFIX`. Compose принудительно выбирает `UAI_BLOB_BACKEND=s3`, поскольку локальные файлы разных серверов не общие. Нужен private bucket без versioning/ObjectLock согласно ограничениям BlobStore.
- `UAI_ALLOW_REAL_PROVIDERS=false` до отдельной проверки настроек и разрешения платных вызовов.
- Настройки пулов PostgreSQL и таймаута Redis из [операционной инструкции](OPERATIONS.md).

Env-файлы хранятся вне Git с ограниченными правами доступа. На узле данных отдельно задаются `UAI_POSTGRES_PASSWORD`, `UAI_REDIS_PASSWORD`, `UAI_DATA_BIND_IP`. Compose требует непустые значения. Не публикуйте вывод `docker compose config`, он может содержать подставленные секреты; для проверки используйте `config --quiet`.

## Порядок запуска

На узле данных:

```sh
docker compose -f deploy/compose.data.yaml up -d
```

После проверки соединений и резервной копии существующей БД, на узле приложения:

```sh
docker compose -f deploy/compose.app.yaml --profile ops run --rm migrate
docker compose -f deploy/compose.app.yaml up -d api scheduler
```

На узле исполнения:

```sh
docker compose -f deploy/compose.workers.yaml up -d
```

Миграции запускаются явно, а не каждым worker при старте. Scheduler публикует задания; maintenance worker выполняет обслуживание. Несколько scheduler допустимы только с тем же installation ID и БД. У generation concurrency 4 на каждую из очередей text/image/audio/tools; это не общий предел 4. Доменные ограничения account/application/queue и provider quota дополнительно ограничивают фактический запуск.

Для увеличения числа исполнителей используйте `--scale generation=N`. Учитывайте суммарное число соединений PostgreSQL всех реплик. Compose ждёт остановку 45 секунд, worker имеет внутренний grace period 30 секунд. Принудительная остановка не означает отмену запроса у провайдера.

## Обновление и откат

Подготовьте новый image digest, проверьте его на staging, сделайте проверяемую резервную копию PostgreSQL и убедитесь в доступности общего S3. Примените аддитивные миграции, затем обновляйте scheduler/API/workers по ролям. Не запускайте старый и новый backend на одном request без предусмотренной смены поколения. Порядок перехода backend и отката описан в [плане](DISTRIBUTED_EXECUTION_PLAN.md).

Redis AOF не заменяет резервную копию PostgreSQL или S3. Нельзя восстанавливать только финансовые таблицы без согласованных operation/attempt/storage данных. Автоматизированный restore drill, правила S3 backup и полный многохостовый rollback ещё требуют приёмки. Шаблоны не делают эти операции автоматически.

## Пробное восстановление PostgreSQL

Для синтетической локальной базы есть `scripts/check-backup-restore.ts`. Скрипт принимает только имя `uai_load_*` и явный opt-in; production-базы не допускаются. Нужен локальный Docker-контейнер PostgreSQL, в котором `pg_dump`/`pg_restore` подключаются к той же базе, что указана в `DATABASE_URL`.

```sh
UAI_RESTORE_TEST_ONLY=1 UAI_RESTORE_TEST_CONTAINER=uai-postgres-1 pnpm exec tsx scripts/check-backup-restore.ts
```

Скрипт экспортирует repeatable-read snapshot и передаёт его pg_dump, поэтому сверка таблиц и dump относятся к одному состоянию даже при записях в источник. Восстановление выполняется в новую уникальную `uai_restore_*`; существующие базы не удаляются и не перезаписываются. Проверяются hashes/число строк всех public tables, баланс каждой journal transaction и соответствие lot balances проводкам. Отдельные пробы подтверждают, что восстановленные triggers запрещают изменение истории и несбалансированную запись. Все пробы откатываются.

Dump и отчёт остаются в `/tmp/uai-restore-*.dump` и `.json` с правами 0600, новая база сохраняется для осмотра. Это временные артефакты проверки, не политика хранения резервных копий. Runtime на восстановленной базе не запускается, Redis и blob content не восстанавливаются. Согласованность PostgreSQL/S3 и безопасное возобновление неизвестных внешних запросов требуют отдельной проверки.

## Что проверено локально

Проверены ARM64 build, все 39 миграций на отдельной базе, ответ API `/health` 200, публикация maintenance scheduler и исполнение production BullMQ worker. Контейнеры запускались с read-only filesystem, API и worker завершились по SIGTERM с кодом 0. `/health` сейчас означает живой HTTP-процесс, не проверяет готовность PostgreSQL, Redis или S3.

При сборке необязательный `msgpackr-extract` не собрался без native toolchain; BullMQ прошёл проверку с JS fallback. Тест не измеряет производительность fallback на VPS. Образ для AMD64, production secrets, HTTPS, отдельные VPS, private S3 и админка в этой контейнерной проверке не проверялись.
