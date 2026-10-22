# Контракт API и SDK

[Оглавление](README.md)

Контракт v1 реализуется в локальном API. [OpenAPI](openapi.json) и типы SDK генерируются из общих runtime-схем; актуальность проверяется `pnpm check:api`. Полнота реализации и проверки отражены в [матрице приёмки](ACCEPTANCE_RESULTS.md). Примеры сумм синтетические.

## Общие правила

### Центральный расчёт и окончательная цена

Новые single-call профили могут выбирать `pricing_mode: quoted_final`. Quote возвращает `settlement: quoted_final` и `price_units` строкой целых кредитных единиц. Совместимые поля `estimated_units` и `max_units` при этом содержат ту же сумму. Клиент показывает `price_units` до подтверждения; успешный результат списывает согласованную цену. Изменение входа требует нового quote. Legacy actual_usage и фиксированные таблицы сохраняют прежний контракт.

`POST /v1/admin/model-versions/preview` требует `config:write`. Он принимает выбранную сохранённую модель либо несохранённую методику с версией ставок и тестовым входом. Ответ содержит количества и стоимость составляющих, оценку себестоимости, коэффициенты и окончательную цену. Preview не вызывает поставщика и не требует заполненных контрольных примеров; публикация требует успешных примеров. Версия ставок проверяется в области текущего приложения.

Публичный каталог раскрывает схему параметров модели и правила подготовки вложений. Методика расчёта, внутренние ставки, запас и наценка остаются административными данными. Подробный контракт методики описан в [спецификации](MODEL_PRICING_SPEC.md).

Base path: /v1. Сервер использует HTTPS в рабочей среде. JSON-поля имеют snake_case. Дата и время передаются в UTC ISO 8601. Идентификаторы непрозрачны, клиент не извлекает из них права доступа.

Все суммы *_units передаются строками неотрицательных целых чисел. Signed amounts допускаются только в представлении postings. Quantity и rates, требующие дробной части, также передаются decimal strings. Display credits являются производными значениями.

GET не запускает генерацию, повтор, оплату или изменение конфигурации. POST над командой сообщает о принятии, а не обязательно о завершении. Для заданий используется 202; чтение ресурса сообщает окончательный статус.

## Авторизация

Authorization: Bearer передаёт service token. Scope токена задаётся платформой. organization_id и application_id выводятся из авторизации. Account ID из тела проверяется на принадлежность и права, а не принимается как доказательство доступа.

| Scope | Возможности |
|---|---|
| accounts:write | Создать и сопоставить аккаунт своего приложения |
| accounts:spending | Приостановить/возобновить расход аккаунта по решению платёжного сервиса или оператора |
| ai:quote | Получить оценку разрешённого действия |
| ai:execute | Принять операцию, создать запрос, отменить |
| ai:read | Читать результаты и события в своей области |
| content:write | Подтверждать передачу и удалять содержимое своей области |
| wallets:read | Читать свой разрешённый баланс и журнал |
| credits:grant | Начислять в разрешённые wallets, с серверными пределами |
| credits:refund | Возвращать ранее списанный расход в своей области |
| credits:revoke | Готовить и подтверждать отзыв конкретного grant |
| config:write | Управлять каталогом, ценами, маршрутами и рецептами |
| operations:admin | Разрешать инциденты и управлять исполнением |

Обычный ключ приложения не содержит credits:grant. Платёжный сервис получает ограниченный ключ начислений без доступа к prompts и provider credentials. Admin UI использует пользовательские сессии с ролями и аудитом.

В external-режиме сессией владеет родительское приложение. Дополнительный service scope `identity:assert` разрешает проверенный заголовок `x-uai-context` версии 1. User-контекст ограничивает account и запрещает административные/финансовые привилегии; staff-контекст имеет роль `admin` или `viewer`, не расширяя scopes токена. Viewer доступен только явный реестр безопасных чтений. Standalone-сборка сохраняет парольный вход владельца. Формат, настройка адаптера и персональная атрибуция описаны в [контракте внешней авторизации](EXTERNAL_AUTH.md). `/health` объявляет `capabilities.external_identity: 1`; SDK и внешний административный backend проверяют совместимость.

## Идемпотентность

Все создающие финансовый эффект и платную работу POST требуют Idempotency-Key. Ключ ограничен длиной и допустимыми символами; рекомендуемое значение является UUID. Область уникальности: organization + application + endpoint command + key.

Сервер сохраняет hash канонического входа. Повтор того же тела возвращает прежний resource ID и результат команды. Тот же ключ с другим телом возвращает 409 idempotency_conflict. Конкурентные повторы не выполняют команду дважды.

Источник grant дополнительно уникален по issuer + external_reference. Request дополнительно уникален по operation + client_request_key. У capture/refund есть доменные уникальные ссылки. Истечение кеша HTTP-ответов не удаляет эти ограничения.

Idempotency records финансовых эффектов сохраняются весь срок хранения финансовой истории. Для прочих команд нужен документированный срок; клиент после него читает ресурс по ID и не предполагает безопасность повторного создания.

## Основные ресурсы

| Метод и путь | Результат |
|---|---|
| POST /accounts | Аккаунт приложения и необязательный кошелёк |
| POST /accounts/{id}/spending/suspend | Запретить новые расходы; остановить неотправленные requests |
| POST /accounts/{id}/spending/resume | Разрешить новую работу после внешнего решения |
| GET /models | Разрешённые модели и capabilities |
| GET /profiles | Профили маршрутизации, доступные приложению |
| GET /recipes | Доступные опубликованные рецепты и input schemas |
| POST /assets/uploads | Разрешение загрузить файл |
| POST /assets/{id}/complete | Завершение загрузки и проверка файла |
| GET /assets/{id} | Metadata и временный доступ к разрешённому файлу |
| POST /invocations | Одиночный вызов: встроенная оценка, резерв, operation и request |
| POST /quotes | Предварительная оценка без резерва |
| GET /quotes/{id} | Условия оценки и срок действия |
| POST /operations | Принятие quote и атомарный резерв |
| GET /operations/{id} | Статус, результаты, бюджет и settlement |
| POST /operations/{id}/amend | Принять дополнительную оценку и изменить разрешённый предел |
| POST /operations/{id}/complete | Закрыть приём новых requests; ранее принятые продолжаются, settlement независим |
| POST /operations/{id}/finish-partial | Закрыть приём и отменить ещё не отправленные requests; сохранить готовое |
| POST /operations/{id}/cancel | Отменить новые и по возможности текущие запросы |
| POST /operations/{id}/requests | Создать ограниченный запрос component |
| GET /requests/{id} | Статус, metadata и готовый результат |
| POST /requests/{id}/cancel | Запросить отмену |
| POST /requests/{id}/acknowledge | Подтвердить сохранение результата приложением и удалить временную копию |
| POST /content-deletions | Удалить содержимое operation либо поколения внешнего проекта |
| GET /content-deletions/{id} | Состояние удаления и tombstone |
| GET /events | SSE в разрешённой области с фильтром operation или wallet |
| GET /wallets/{id} | Авторитетный остаток и ревизия |
| GET /wallets/{id}/transactions | История проводок с пагинацией |
| GET /wallets/{id}/lots | Пакеты, остатки и сроки |
| POST /wallets/{id}/grants | Начислить отдельный пакет |
| POST /wallets/{id}/refunds | Вернуть часть конкретного capture |
| POST /wallets/{id}/grant-revocations | Подготовить отзыв доступной части grant |
| POST /grant-revocations/{id}/commit | Подтвердить отзыв после внешнего решения |
| POST /grant-revocations/{id}/cancel | Отменить подготовленный отзыв |

Пагинация использует непрозрачный cursor и limit с серверной верхней границей. Денежные и технические списки имеют стабильный порядок с дополнительным ID при одинаковом времени.

Audio assets принимают `audio/wav` и `audio/mpeg`. Загрузка и выдача provider output используют общий декодер и проверку целостности до сохранения. Пределы: 16 MiB encoded bytes и 16 777 216 декодированных значений каналов. Поддерживаемые WAV codecs, MP3 metadata и границы проверки описаны в `packages/execution/src/audio-validation.ts`. Повреждённый input получает `invalid_asset`, дефектный provider output оплачивается платформой по Q3/Q5.

Команды complete, finish-partial и cancel возвращают 200 с текущим OperationResponse. После терминального результата они не меняют итог и не повторяют финансовые эффекты или событие закрытия, в том числе при новом Idempotency-Key. Пока ранее принятые requests ещё активны, отмену можно усилить в порядке complete → finish-partial → cancel; обратный переход не действует. Повторный ключ с прежним телом читает текущее состояние исходной операции. Проверки ai:execute и области доступа выполняются и для команд без изменений. Семантика описана в [жизненном цикле выполнения](EXECUTION.md).

## Создание аккаунта

~~~json
{
  "external_account_id": "customer_42",
  "create_wallet": { "credit_unit_id": "ai-credit-usd-v1" }
}
~~~

External account ID уникален внутри приложения. Произвольное существующее account_id другого приложения нельзя присоединить через этот метод. Общий wallet access выдаётся административной командой.

Spending suspend/resume требуют accounts:spending, Idempotency-Key, reason и external_reference. Suspend атомарно запрещает admission и будущий dispatch данного account, закрывает ещё не отправленные requests с release; уже отправленные проходят cancel/settlement. Resume разрешает новую работу, но не повторяет отменённые requests и не снимает provider lock. Обычный frontend не получает эти полномочия.

## Простой вызов

POST /invocations использует scopes ai:quote и ai:execute. Клиент передаёт разрешённую модель либо profile, ограниченный input и максимальный расход. Регистрировать собственный recipe не требуется:

~~~json
{
  "account_id": "account_123",
  "wallet_id": "wallet_123",
  "profile": "text.medium",
  "kind": "text.generate",
  "input": {
    "messages": [{ "role": "user", "content": "Подготовь краткий ответ." }]
  },
  "parameters": { "max_output_tokens": 1500 },
  "budget": { "credit_unit_id": "ai-credit-usd-v1", "max_credits": "180" },
  "metadata": { "external_project_id": "project_42", "project_generation": "gen_1" }
}
~~~

max_credits является точной decimal string и авторизованным пределом, а не присланной ценой. Сервер рассчитывает верхнюю границу по встроенному immutable single-call recipe. Если она выше предела, возвращается 409 budget_conflict с оценкой; платная работа не начинается. Иначе одна транзакция сохраняет внутренний quote, operation с закрытым admission, резерв рассчитанного максимума, request и outbox. Более дорогой клиентский предел не требует резервировать его целиком.

Ответ 202 содержит operation_id, request_id, quote_id, accepted_max_units, execution_status, deadline_at и events_url. Повтор с тем же ключом возвращает те же ресурсы. Нет промежутка, в котором падение SDK оставило резерв без созданного запроса. Одиночный image вызов создаёт одну картинку; для пакета используются составные операции.

Для цепочки вызовов, которые появляются по ходу работы, POST /quotes принимает kind=pool, а каждый вызов передаёт operation_id принятого пула в POST /invocations; ответ тот же, request_id относится к этому вызову. Правила — в [оценке](QUOTING.md#резерв-на-составную-работу).

Для предварительной цены POST /quotes принимает kind=single_call и те же profile/model, input, parameters, budget. Возвращаемый quote может быть передан POST /invocations вместо исходных полей. Сервер связывает полный нормализованный input и его hash; quote нельзя использовать с подменённым prompt. Черновой input хранится лишь до принятия или expiry quote. Для generic invocation применяются те же правила cancellation, retry, дефектов, передачи и финансового закрытия.

## Оценка

POST /quotes:

~~~json
{
  "account_id": "account_123",
  "wallet_id": "wallet_123",
  "recipe": { "key": "logopanel.discussion", "version": 1 },
  "inputs": {
    "participants": 4,
    "passes": 2,
    "context_tokens_upper": 30000
  },
  "metadata": { "external_project_id": "project_42", "project_generation": "gen_1" }
}
~~~

Ответ включает id, input hash, версии рецепта/маршрутов/цен, estimated_units, max_units, credit_unit_id, confidence, breakdown, expires_at и warnings. Он также фиксирует partial_policy=successful_parts, cancellation policy, retry policy, execution deadlines и content_ttl_seconds. Полный пример суммы находится в [QUOTING](QUOTING.md).

Оценка не резервирует credits и не обещает слот у провайдера. Если нет подходящей цены, верхней границы или capability, возвращается структурированная ошибка. metadata имеет ограниченный размер и не влияет на авторизацию.

Если передан external_project_id, поле project_generation обязательно и валидируется сервером. Эта пара задаёт привязку содержимого, наследуемую operation и её requests; дочерний запрос не может убрать или заменить её. Остальные произвольные metadata не управляют удалением. Отсутствие проектной привязки допускается для общего API; такой контент удаляется через operation scope или TTL. Интеграция Logo Panel всегда передаёт проектную привязку.

## Принятие операции

POST /operations:

~~~json
{
  "quote_id": "quote_123",
  "client_operation_key": "discussion-project42-round7"
}
~~~

Ответ:

~~~json
{
  "id": "op_123",
  "execution_status": "accepted",
  "settlement_status": "open",
  "accepted_max_units": "180000000",
  "captured_units": "0",
  "reserved_units": "180000000",
  "wallet": {
    "id": "wallet_123",
    "revision": 8,
    "balance_units": "1000000000",
    "reserved_units": "180000000",
    "available_units": "820000000"
  }
}
~~~

Операция создаётся только после успешного резерва. При нехватке средств возвращается 402 insufficient_credits без частично созданного разрешения. Истёкший quote возвращает 409 quote_expired.

Amend принимает новый quote, связанный с данной operation. Новый общий максимум не может быть меньше captures и активных claims. Увеличение требует атомарного дополнительного резерва. Старые captures не пересчитываются.

## Выполнение запроса

POST /operations/op_123/requests:

~~~json
{
  "client_request_key": "pass-1-participant-1",
  "component": "participants",
  "kind": "text.generate",
  "input": {
    "instructions": "Верни ответ по указанной схеме.",
    "messages": [{ "role": "user", "content": "Входные данные приложения" }],
    "asset_ids": [],
    "response_schema": {
      "type": "object",
      "properties": { "message": { "type": "string" } },
      "required": ["message"],
      "additionalProperties": false
    }
  },
  "parameters": { "max_output_tokens": 1500 }
}
~~~

Сервер выводит route из component. Пользователь не может заменить его на более дорогую модель через поле body. Если рецепт допускает выбор, варианты и их цены входят в quote.

Для image.generate input содержит prompt и asset_ids, а parameters содержит count, size и quality в пределах рецепта. Для speech.synthesize input содержит text и разрешённый voice reference. Для search input содержит query и разрешённые фильтры. Для specialized.run передаётся зарегистрированный operation type со своей схемой.

В первой версии count image request равен 1; четыре картинки являются четырьмя отдельно учитываемыми requests. Техническая схема результата фиксируется до dispatch. Нельзя после получения валидного ответа поменять требования и объявить предыдущую работу бесплатной.

В asset_ids принимаются только загруженные input assets нужного владельца. Output asset предыдущего request не может использоваться напрямую: приложение сохраняет файл и загружает отдельный input asset. Нарушение отклоняется до dispatch как invalid_input. Это сохраняет независимость acknowledgement и активных входных файлов.

Ответ 202:

~~~json
{
  "id": "req_123",
  "operation_id": "op_123",
  "execution_status": "queued",
  "settlement_status": "open",
  "events_url": "/v1/events?operation_id=op_123"
}
~~~

Повтор с тем же client_request_key и входом возвращает req_123. Изменённый input возвращает conflict. Повтор для восстановления результата не создаёт provider attempt.

Новая генерация после неизвестного исхода выполняется через новый разрешённый запрос с retry_of_request_id и явным acknowledged_duplicate_risk, только если у principal есть соответствующее разрешение и принят дополнительный бюджет. Boolean из браузера без авторизованного серверного действия не является достаточным основанием.

## Чтение результата

~~~json
{
  "id": "req_123",
  "execution_status": "succeeded",
  "settlement_status": "settled",
  "result": { "type": "json", "value": { "message": "Готовый ответ" } },
  "model": { "provider": "example", "model_id": "example-text-v1" },
  "usage_state": "final",
  "cost_state": "calculated",
  "charged_units": "50000000",
  "wallet_revision": 9,
  "delivery": {
    "result_version": "result_v1",
    "manifest_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "status": "available",
    "ready_at": "2026-09-18T12:02:00Z",
    "content_expires_at": "2026-09-18T13:02:00Z"
  }
}
~~~

Usage и provider cost в полном объёме могут быть доступны только административному principal. Клиент получает пользовательское списание, состояние точности и разрешённую информацию о модели. Ошибочные запросы не раскрывают сырые ответы с ключами или приватными данными другой области.

У succeeded request может быть settlement_status=pending, если результат доступен, но usage недостаточен. Такой ответ не помечается settled и не сообщает charged_units как подтверждённый ноль. Финансовое закрытие спорной части происходит не позднее одного часа от первого unresolved_at, даже если polling продолжается.

`attempt_timeout_seconds` в execution policy обрывает один молчащий вызов раньше дедлайна запроса, чтобы в оставшееся время поместился повтор. Оборванная попытка отмечается `timed_out_at`, её стоимость остаётся неизвестной. Повтор выполняется автоматически, если адаптер поддерживает идемпотентность (тот же ключ) или политика задаёт `timeout_retry: "accept_duplicate_cost"`; иначе запрос получает outcome_unknown в момент таймаута, а не дедлайна.

Отказ поставщика до начала работы (401/403, 402 или insufficient_quota, 429), который адаптер помечает `billable: false`, не считается неизвестной стоимостью: попытка получает cost 0, окончательно отказанный запрос сразу получает settlement_status=settled без часового ожидания. Адаптер без такой отметки сохраняет прежнее часовое закрытие.

При waiting_recovery ответ содержит recovery_incident_id, cycle_index, attempt_count, next_retry_at, deadline_at и reason. Эти metadata не раскрывают чужие requests, выбранные контрольными. После locked новые вызовы получают provider_locked; ранее принятые requests без доступного пути получают терминальный provider_recovery_exhausted и отдельный settlement.

Запрос, срок которого истёк до первой попытки, получает execution_status=canceled, attempt_count=0 и причину, указывающую, что вызов модели не начинался: `rate_limit_starved`, если он ждал concurrency или окна лимитера поставщика, и `admission_timeout` в остальных случаях ожидания допуска. Причина `deadline_exceeded` остаётся для запросов, у которых уже была попытка, а также для paused и waiting_recovery. Такой запрос не оплачивается.

## Передача и удаление содержимого

После сохранения текста и всех файлов в собственном долговечном хранилище приложение вызывает POST /requests/req_123/acknowledge с Idempotency-Key:

~~~json
{
  "result_version": "result_v1",
  "manifest_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
~~~

Manifest идентифицирует весь результат: текст/JSON и content hashes файлов. API результата возвращает manifest_hash. Подтверждение только скачивания одного файла не удаляет остальные. Acknowledge атомарно фиксирует receipt, закрывает чтение этой версии и ставит purge в очередь. Повтор возвращает прежний receipt; несовпадающая версия или hash дают 409 result_version_conflict. Подтверждение не создаёт capture/refund и не требуется для списания за доступный валидный результат.

После acknowledge, expiry или удаления GET /requests/{id} возвращает metadata с result=null, delivery.status=acknowledged|expired|deleted и временем события. Доступ к удалённому asset возвращает 410 content_unavailable. Повтор исходной команды с прежним ключом возвращает прежний ID и этот статус, без генерации и без старого payload из idempotency cache. После удаления контента сохраняются только допустимые hashes и финансовые metadata. Новый запрос на тот же результат является новой явно оплачиваемой работой.

POST /content-deletions принимает scope и reason. Scope может быть operation_id либо пара external_project_id/project_generation в области авторизованного приложения. Сервер создаёт tombstone и задачу удаления; ответ 202 содержит deletion_id. Повторы идемпотентны. Новый request, в том числе внутри старой operation, проверяет tombstone и не может записать результат в удалённое поколение проекта. Финансовый settlement уже отправленного вызова продолжается. GET deletion показывает accepted/purging/completed и проблемы физической очистки. Завершение не утверждается до проверки всех принадлежащих scope копий.

Предлагаемый content TTL без receipt равен одному часу от ready_at, согласно опубликованной конфигурации установки. Это отдельный таймер от финансового unresolved_at. Приложение получает оба срока и не предполагает возможность загрузить результат спустя несколько дней. Ссылки на assets и события не продлевают TTL.

## Начисление

POST /wallets/wallet_123/grants:

~~~json
{
  "credit_unit_id": "ai-credit-usd-v1",
  "amount_units": "3000000000",
  "source": "purchase",
  "external_reference": "billing:payment_456",
  "terms_version": "pack-2026-09-v1",
  "expires_at": null
}
~~~

Это 3 000 кредитов и $3 внутреннего бюджета. Стоимость продажи не требуется. Сервис сам фиксирует бюджет одного кредита из immutable unit registry; клиент не может прислать другой коэффициент.

expires_at обязателен: null явно создаёт бессрочный пакет. Для месячных кредитов без переноса платёжный сервис передаёт source=subscription, отдельную ссылку на период и точное expires_at, например 2026-10-18T00:00:00Z. Истечение не удаляет lot из истории. GET wallet учитывает уже наступивший срок даже при задержке фонового expire. Новый grant следующего периода не оживляет старый остаток.

Ответ содержит grant_id, lot_id, неизменяемые исходные значения и wallet snapshot. Повтор external_reference с другим amount конфликтует даже при другом Idempotency-Key. Административные начисления требуют reason и аудита.

## Возврат и отзыв

POST /wallets/wallet_123/refunds:

~~~json
{
  "capture_id": "capture_123",
  "amount_units": "50000000",
  "reason": "delivery_failure",
  "external_reference": "support:case_789"
}
~~~

Сумма не превышает некомпенсированную часть capture. Refund возвращает новый transaction ID, wallet revision, lot allocations и их expires_at. Компенсация в уже истёкший пакет использует отдельный refund lot по зафиксированной политике; стартовая длительность 30 дней. Простое освобождение резерва после expiry не является refund и не создаёт новый пакет.

POST /wallets/wallet_123/grant-revocations:

~~~json
{
  "grant_id": "grant_123",
  "amount_units": "1000000000",
  "external_reference": "billing:refund_456",
  "reason": "purchase_refund"
}
~~~

Prepare блокирует доступную часть конкретного grant и возвращает revocation_id и reconcile_after. Commit и cancel являются идемпотентными командами. reconcile_after запускает сверку/инцидент, а не автоматический release. Уже consumed или зарезервированный для AI бюджет не отзывается автоматически. Состояние внешнего платежа AI-сервис не угадывает. Часовой timeout неизвестного AI-расхода не применяется к revocation hold.

## События

SSE и webhook используют общий envelope:

~~~json
{
  "id": "event_123",
  "sequence": "1042",
  "type": "wallet.updated",
  "occurred_at": "2026-09-18T12:02:00Z",
  "application_id": "app_123",
  "account_id": "account_123",
  "resource": { "type": "wallet", "id": "wallet_123" },
  "data": {
    "revision": 9,
    "balance_units": "950000000",
    "reserved_units": "130000000",
    "available_units": "820000000"
  }
}
~~~

Основные типы: operation.accepted, operation.paused, operation.completed, operation.settled, request.queued, request.waiting_rate_limit, request.waiting_recovery, request.started, request.output_delta, request.succeeded, request.settled, request.failed, request.outcome_unknown, result.ready, result.acknowledged, content.deleted, usage.updated, wallet.updated, provider.health_changed, provider.budget_low, provider.failover_started, provider.recovery_started, provider.recovery_exhausted, provider.recovered, reconciliation.discrepancy.

Request.output_delta является временным SSE-потоком без долговечного payload. Остальные долговечные события содержат references/metadata и не копируют prompts, текст результата или bytes файлов. После удаления контента повтор outbox не должен его раскрывать.

Окончание выполнения и финансовое закрытие могут приходить отдельными событиями. Клиент применяет только более новые wallet revisions. При пропуске событий он читает snapshot. События разных ресурсов не являются гарантией единого порядка во всех каналах доставки.

Webhook содержит подпись тела, timestamp и event ID. Получатель проверяет подпись и окно времени, устраняет дубли и отвечает после надёжного принятия. Отправитель повторяет доставку с backoff. Бизнес-эффект не выполняется повторно при повторной доставке.

## Административные методы

Все конфигурации имеют draft и published versions. Редактирование draft использует revision/If-Match, чтобы два администратора не перезаписали изменения друг друга.

| Ресурс | Необходимые операции |
|---|---|
| /admin/connections | Создать, читать, изменить draft settings, enable/disable, проверить разрешённым неплатным методом |
| /admin/recovery-incidents | Scope, цикл, probe lease, next_retry_at, история, ручное включение затронутой области с reason |
| /admin/connections/{id}/credentials | Сохранить/ротировать secret через write-only вход |
| /admin/model-versions | Каталог возможностей и жизненный цикл |
| /admin/rate-cards | Создать draft с необязательным display_name, проверить расчёт, сравнить влияние, publish |
| /admin/rate-cards/{id}/display-name | PATCH: переименовать draft или опубликованный тариф; config:write, If-Match и Idempotency-Key обязательны |
| /admin/routes | Создать draft, проверить совместимость, publish |
| /admin/recipes | Создать draft, проверить пределы и схемы, publish |
| /admin/requests, /admin/attempts | Поиск, чтение, диагностика, разрешённые действия восстановления; `POST /admin/requests/{id}/resolve-unknown` разрешает неизвестный исход попытки по данным поставщика |
| /admin/provider-snapshots | Последние балансы, лимиты и свежесть |
| /admin/reconciliation-runs | Запустить read-only сверку, прочитать результат, оформить корректировку |
| /admin/incidents | Acknowledge, resolve, история доставок |
| /admin/notification-rules | Пороги, получатели, cooldown |
| /admin/audit-events | Просмотр аудита с фильтрами |
| /admin/credit-summary | Сводка кредитов всех кошельков приложения за период: выдано, списано, возвращено, сгорело, отозвано, текущий и истекающий остаток |

Просмотр секрета после сохранения не предусмотрен. Publish rate card не переписывает историю. Действие resolve unknown требует reason и допустимого финансового сценария из ACCOUNTING: тело содержит attempt_id, provider_charged и cost_units (только при provider_charged=true), клиенту ничего не списывается, попытка получает статус `abandoned` с известной стоимостью. Порядок действий описан в [операциях](OPERATIONS.md#слоты-лимитера-и-неизвестный-исход).

`GET /admin/execution-metrics` дополнительно возвращает `limiters` (`concurrency_limit`, `held_slots`, `unknown_held_slots`, `oldest_unknown_held_seconds`) и по очередям `rate_limit_starved_24h`, `admission_timeout_24h` и `attempt_timeouts_24h` (вызовы, оборванные таймаутом попытки). Сигнал уведомлений `limiter.unknown_slots_held` срабатывает, когда неизвестные исходы занимают слоты лимитера.

### Сводка кредитов приложения

`GET /v1/admin/credit-summary` (scope `operations:admin`, токен без `account_ids`) одним запросом считает кредиты всех кошельков приложения токена. Параметры: `period_start`, `period_end` (полуинтервал `[start, end)`, оба необязательны, `period_start` раньше `period_end`), `account_id` (сужает выборку до одного аккаунта; чужой аккаунт даёт 404) и `expiring_before` (по умолчанию `as_of` + 30 дней). Метод только читает: отложенные проводки `expire` не записываются, их сумма учитывается расчётом. Все суммы — units строками.

| Поле | Значение | Основа |
|---|---|---|
| issued_units, issued_by_source | Сумма `original_amount_units` пакетов, созданных в периоде, по `source`; компенсационные пакеты `refund` не входят | `lot_created_at` |
| consumed_units | Кредиты, перешедшие в consumed: capture и погашение долга | `journal_created_at` |
| refunded_units | Кредиты, возвращённые из consumed обратно в доступные | `journal_created_at` |
| revoked_units | Подтверждённые отзывы | `journal_created_at` |
| expired_units | Сгоревшее в пакетах с `expires_at` в периоде и не позже `as_of`, включая ещё не записанное `expire` | `lot_expires_at` |
| expired_held_units | Резервы и блокировки отзыва в этих пакетах; позже станут consumed, revoked или expired | `lot_expires_at` |
| available_units, reserved_units, revocation_reserved_units | Текущие суммы по действующим пакетам; reserved и блокировки — по всем пакетам | На `as_of` |
| debt_units | Непогашенный долг фактического расхода; доступный остаток кошелька равен available минус долг | На `as_of` |
| expiring_units | Доступное в пакетах, которые истекут после `as_of` и до `expiring_before` | На `as_of` |

`expired_precision` равен `partial`, пока `expired_held_units` больше нуля, иначе `final`. Сгоревшее отнесено к сроку пакета: освобождение резерва после срока увеличивает `expired_units` того периода, в котором пакет истёк. Списание здесь — движение кредитов из пакетов; начисленная клиенту сумма с учётом долга остаётся в `charged_units` [Overview](#административные-методы). Суммы совпадают с агрегатом `GET /v1/wallets/{id}/lots` по всем кошелькам выборки.

~~~json
{
  "filters": {"application_id": "app_logopanel", "account_id": null, "period_start": "2026-01-01T00:00:00.000Z", "period_end": "2026-02-01T00:00:00.000Z", "expiring_before": "2026-02-24T00:00:00.000Z"},
  "as_of": "2026-01-25T00:00:00.000Z",
  "wallet_count": 3,
  "issued_units": "4250",
  "issued_by_source": {"purchase": "1000", "subscription": "2000", "promotion": "500", "migration": "700", "internal": "50"},
  "consumed_units": "500",
  "refunded_units": "30",
  "expired_units": "1500",
  "expired_held_units": "400",
  "revoked_units": "200",
  "available_units": "1680",
  "reserved_units": "300",
  "revocation_reserved_units": "100",
  "debt_units": "0",
  "expiring_units": "630",
  "issued_basis": "lot_created_at",
  "flow_basis": "journal_created_at",
  "expired_basis": "lot_expires_at",
  "expired_precision": "partial"
}
~~~

SDK: `client.admin.creditSummary({period_start, period_end, account_id, expiring_before})`. Admin BFF: `view=credit_summary` с теми же параметрами.

## Ошибки

~~~json
{
  "error": {
    "code": "insufficient_credits",
    "message": "Недостаточно доступных кредитов для резерва.",
    "retryable": false,
    "correlation_id": "corr_123",
    "details": { "required_units": "180000000", "available_units": "100000000" }
  }
}
~~~

| HTTP | Коды |
|---|---|
| 400/422 | invalid_input, unsupported_capability, request_exceeds_recipe, pricing_unavailable |
| 401/403 | unauthenticated, scope_denied, account_denied |
| 402 | insufficient_credits |
| 404 | not_found, в том числе недоступный чужой ресурс |
| 409 | idempotency_conflict, quote_expired, quote_already_bound, budget_conflict, revocation_unavailable |
| 409 | result_version_conflict, operation_admission_closed, content_scope_deleted |
| 410 | content_unavailable |
| 429 | platform_rate_limited, с Retry-After при наличии |
| 503 | platform_unavailable, provider_unavailable_before_acceptance, provider_locked, platform_risk_budget_exhausted |

Provider rate limit уже принятого задания обычно отражается в состоянии очереди, а не заставляет клиент повторять создание operation. Поле retryable не является разрешением создавать новую финансовую операцию с новым ключом.

## Клиенты интерфейсов

Админка вызывает административные методы через серверный слой TanStack Start. Тестовое приложение использует SDK с backend; ключи сервиса не передаются браузеру. Форма тестового начисления вызывает существующий grant с отдельным разрешением и Idempotency-Key, не вводит обходной метод изменения balance. Ограничения окружения и аккаунта заданы в [ARCHITECTURE](ARCHITECTURE.md). Суммы продолжают передаваться строками; форматирование интерфейса не меняет API-контракт.

## SDK

SDK предоставляет ai.run/ai.quote для одиночного вызова и accounts, quotes, operations, requests, assets, wallets, content и events для составных действий. Ai.run вызывает POST /invocations, сохраняет IDs, ждёт результат через SSE/polling и возвращает result вместе с acknowledge(). Пользователь не регистрирует recipe для такого вызова. SDK поддерживает AbortSignal для явной команды отмены и typed errors.

Приложение сначала сохраняет result и файлы, затем вызывает acknowledge(). SDK может принять persist callback и подтвердить передачу только после успешного завершения callback. Ошибка записи не вызывает acknowledge. После сбоя SDK возобновляет ожидание прежнего request, учитывает content_expires_at и показывает недоступность удалённого содержимого без нового платного вызова. Примеры интеграции обязаны включать постоянное сохранение и удаление проектного контента.

Безопасные повторы SDK используют тот же Idempotency-Key и тот же payload. SDK не делает самостоятельный provider failover и не начисляет деньги. Закрытие HTTP/SSE не трактуется как отмена платной операции.

Модели и параметры выводятся из опубликованного контракта, а не хардкодятся в frontend каждого приложения. SDK version и API major совместимы; удаление поля или смена его семантики требует новой major version либо явного migration window.

## Установка остатка в тестовом окружении

`POST /v1/wallets/{id}/test-balance` доступен только при `UAI_ENV=test`, требует scope `credits:test-balance` и `Idempotency-Key`. Тело содержит `available_units` строкой и `expected_revision` целым числом. Целевой остаток ограничен `max_grant_units` токена; 0 допустим. При открытых резервах или несовпадении revision возвращается 409. Начисление либо отзыв по нескольким пакетам выполняются одной транзакцией через обычные проводки. Ответ содержит текущий `wallet`. Повтор принятой команды возвращает актуальный кошелёк без повторной корректировки. Вне тестового окружения маршрут отвечает 404.

Название тарифа хранится отдельно от его `payload`. PATCH `/v1/admin/rate-cards/{id}/display-name` принимает только `display_name`, строку от 1 до 200 символов после удаления крайних пробелов. Изменяется название и `revision`, но не `version`, ставки, ключ или ссылки рецептов. Конфликт `If-Match` возвращает `revision_conflict`; повтор с тем же Idempotency-Key безопасен. Старые записи возвращают `display_name: null` и отображаются по ключу.

## Прогнозный текст и отрицательный баланс

В ответе quote поля `estimate_only: true` и `overdraft_allowed: true` обозначают согласованное списание по фактическому usage с возможным долгом. В таком режиме `max_units` является первоначальным резервом, не потолком списания; клиент показывает примерный расход `estimated_units`. Параметр модели `expected_output_tokens` используется только оценщиком и не ограничивает генерацию. Прямой invoke по готовому quote сохраняет эти условия.

`Wallet.available_units` и `Wallet.balance_units` допускают отрицательные целочисленные строки. Суммы grant, refund, reserve и `reserved_units` остаются неотрицательными. Новые запросы при долге отклоняются с `insufficient_credits`; уже принятые завершаются по сохранённым условиям. Пополнение сначала погашает долг.

## Ограничения публикации и выполнения очередей

`GET /v1/admin/dispatch-policies` возвращает шесть политик установки. `PATCH /v1/admin/dispatch-policies/{kind}` изменяет выбранную политику, где `kind` — text, image, audio, tools, observe или maintenance. Доступ требует `operations:admin` и отсутствия account-ограничения у токена; изменение дополнительно требует `config:write` и `Idempotency-Key`. Область политики — вся установка, не application токена. Организация и приложение администратора сохраняются в аудите как источник изменения.

```json
{
  "revision": 1,
  "settings": {
    "account_limit": 2,
    "application_limit": 32,
    "queue_limit": 128
  },
  "reason": "Ограничить число одновременно опубликованных заданий"
}
```

Должно выполняться `1 <= account_limit <= application_limit <= queue_limit <= 100000`. Устаревшая ревизия возвращает HTTP 409. Изменение, увеличение ревизии и аудит before/after выполняются в одной транзакции. Повтор команды с прежним ключом не изменяет настройки повторно и возвращает текущую политику. Снижение предела не отменяет уже опубликованные задания: новые ждут освобождения места.

Для text/image/audio/tools поля `active_account_limit`, `active_application_limit`, `active_queue_limit` задают отдельные пределы активных lease. Они не ограничивают backlog. Выполняется `1 <= active_account_limit <= active_application_limit <= active_queue_limit <= 100000`. Не переданные active-поля сохраняют прежние значения; проверяется итоговая комбинация. Снижение предела не прерывает уже выполняющиеся запросы. Начальные значения 2/16/32 являются локальными настройками, не квотами провайдера.

Поля без префикса active ограничивают передачу работы в BullMQ для text/image/audio/tools. В observe эти поля ограничивают одновременные наблюдения и количество выбранных для доставки текущих poll revisions. Выбор фиксируется в PostgreSQL до публикации; повторная доставка уже выбранного poll не занимает новое место. Новая ревизия poll или завершение наблюдаемой работы освобождает место. Исторические и устаревшие записи транспорта не входят в этот счётчик; отдельные active-поля для observe и maintenance пока отвергаются с HTTP 422, поскольку их исполнители не используют такие настройки. Maintenance выполняется одним владельцем lease цикла. Эти ограничения не заменяют квоты провайдера или concurrency процесса worker. Рабочая demo остаётся на legacy до завершения приёмки и переключения.

### Отказ при заполненной очереди

При настроенной `execution_admission_policies` принятие quote и увеличение числа разрешённых вызовов через amendment проверяют backlog до финансового резерва. Новые приложения при первом принятии операции с backend BullMQ получают согласованные пределы 20 на account, 200 на application и возраст очереди 900000 мс. Legacy-приложения без явной политики сохраняют прежнее поведение.

Ответ HTTP 429 с `queue_backpressure` содержит причину `account_backlog`, `application_backlog` или `queue_age`, текущее число ожидающих вызовов и `retry_after_seconds: 5`. Это рекомендация повторить попытку позже, не обещание освобождения места через пять секунд. Резерв не создаётся и не увеличивается. Учитываются queued/waiting_retry/waiting_recovery и неиспользованные разрешения открытых операций до их deadline. Идемпотентный повтор ранее принятой операции возвращает прежний результат даже при заполненной очереди.

### Настройки admission policy приложения

`GET /v1/admin/admission-policy` возвращает ограничения только приложения текущего токена. Нужен `operations:admin`, токен с account-ограничением запрещён. Отсутствующая политика возвращается как `enabled: false`, `revision: 0` и согласованные начальные значения; GET не создаёт политику.

`PATCH /v1/admin/admission-policy` требует дополнительно `config:write`, `Idempotency-Key`, причину и revision в теле. Revision 0 означает первое включение. Настройки применяются к последующим проверкам приёма, уже принятая работа сохраняется. Допустимы account 1–100000, application от account до 1000000, max_queue_age_ms 1000–86400000.

```json
{
  "revision": 0,
  "settings": {
    "account_limit": 20,
    "application_limit": 200,
    "max_queue_age_ms": 900000
  },
  "reason": "Включить согласованные ограничения очереди"
}
```

Конкурирующее изменение возвращает HTTP 409. Сохранение и аудит `admission.policy.updated` с before/after выполняются атомарно. Повтор прежней команды не создаёт новый аудит и возвращает актуальную политику приложения. Приложение нельзя подменить в теле команды или URL.


### Операционные настройки квот

Административный список `GET /v1/admin/provider-quotas` возвращает группы организации, правила, привязки моделей и удерживаемые concurrency slots. `PATCH /v1/admin/provider-quotas/{id}` изменяет операционные настройки с `settings_revision`, idempotency key и обязательной причиной. Ревизия правил допуска отделена от ревизии этих настроек. Права, ограничения текущего редактора и семантика snapshot описаны в [операционной спецификации](OPERATIONS.md#настройки-групп-provider-quota); точные схемы находятся в [OpenAPI](openapi.json).

`PATCH /v1/admin/provider-quotas/{id}/rules` меняет лимиты существующих правил с `rules_revision`, idempotency key и причиной. `capacity` задаёт нашу долю; `provider_capacity` хранит известный предел провайдера либо null. Обе численные величины передаются целыми строками. Команда сохраняет окна и накопленный расход, а также уже выданные действующие допуски. Создание правил и изменение их метрик этим endpoint не поддерживается.

`GET /v1/admin/provider-quotas/{id}/snapshot` возвращает rules revision, дату чтения, статус достоверности и остатки по правилам. Количества передаются строками; даты в ISO 8601. При статусе, отличном от ready, rules пуст. Токен должен иметь operations:admin без account_ids; чужая организация недоступна. Redis читается после завершения SQL-транзакции. Метод не создаёт admission и не восстанавливает квоту. Семантика локального и консервативного provider remainder описана в [операционной спецификации](OPERATIONS.md#настройки-групп-provider-quota).

### Входящие webhook провайдера

`POST /v1/provider-webhooks/{requestId}` принимает исходное подписанное тело до 1 MiB с Content-Type application/json или application/octet-stream. Bearer token не требуется: адаптер соответствующей сохранённой попытки обязан проверить подпись, срок её действия и идентификатор remote job. Scope берётся из execution_request, поля организации из тела не используются. Дублирующиеся HTTP-заголовки отклоняются. JSON не пересобирается перед проверкой подписи.

После проверки используется тот же receiveNativeWebhook и settlement, что при внутреннем получении события. Повтор event_id уже сохранённого observation подтверждается без второго финансового эффекта. HTTP 200 с accepted=true подтверждает обработку; 401 означает недействительную подпись или привязку job, 404 неизвестный request/native job или отсутствие поддержки webhook адаптером, 503 временную невозможность обработки. Ответы не раскрывают контекст провайдера. При 503 провайдеру требуется повтор; незавершённые native jobs также остаются в контуре polling.

HTTP-вход проверен на подписанном synthetic native adapter. Текущие реальные адаптеры не реализуют verifyNativeWebhook, поэтому это не заявление о готовом webhook OpenAI/Cartesia. Конкретные заголовки, секреты и freshness/replay правила реализуются и проверяются вместе с native adapter провайдера; callback URL передаётся при его submitNative согласно контракту провайдера.

## Расширение платных API

Контракт PA-I01, единицы измерения, периоды, резервы allowance и границы совместимости описаны в [контракте платных API](PAID_API_CONTRACT.md). Статус реализации и стабильные сценарии PA-A01–PA-A25 приведены в [плане](PAID_API_PLAN.md). Проект контракта не подтверждает доступность новых HTTP handlers.

## Универсальная политика исполнения

`QuoteBody.execution` допускает частичное переопределение известных полей: deadline_seconds, max_attempts, backoff, retry_reasons, retry_after_output, recovery, attempt_timeout_seconds, timeout_retry. Пустой объект эквивалентен отсутствию блока. Списки заменяются целиком; null и неизвестные поля отклоняются. `billing.refused` принимает platform по умолчанию или actual_usage. Quote возвращает итоговые execution и billing, а request исполняет сохранённые условия. Изменение политики при передаче существующего quote_id отклоняется.

Автоматический single-call с estimated_actual допускается без фиксированного budget; другие режимы по-прежнему требуют бюджет или принятый quote. Изображения с человеческим подтверждением используют quote и принятие операции.

Upload принимает retention_seconds и metadata с external_project_id/project_generation. По умолчанию доступный input хранится семь дней после завершения upload или принятого использования. GET не продлевает хранение. POST /v1/assets/{id}/renew продлевает действующий input с идемпотентным ключом. Истёкший input загружается заново из оригинала приложения. ACK результата не удаляет общий input asset.

## Контракты LogoPanel

См. [контракт доработок LogoPanel](LOGOPANEL_FOLLOWUP_INTEGRATION.md): API/SDK, ограничения и неактивированные примеры конфигураций. Реальные вызовы требуют отдельного согласования по [правилам проверки провайдеров](REAL_PROVIDER_CHECKS.md).
