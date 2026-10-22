# Интеграция универсальных вызовов

Контракты: [API](API.md), [исполнение](EXECUTION.md), [расчёт](QUOTING.md), [план и критерии](UNIVERSAL_INVOCATION_PLAN.md). Все цены в локальном стенде синтетические. Поддержку конкретной модели объявляют опубликованные `text_features` каталога, а не имя провайдера.

## Сервер приложения

Токен UAI хранится на сервере приложения. Браузер обращается к своему серверу; тот создаёт `UaiClient` с `baseUrl` и `token`, проверяет `/health` и передаёт проверенную identity через `forIdentity`. Нельзя брать account, project или identity из браузера без проверки прав владельца. См. [внешнюю авторизацию](EXTERNAL_AUTH.md).

Один пользовательский запуск получает постоянный ключ идемпотентности. Его сохраняют вместе с принятым `request_id`. После сетевой ошибки повторяют тот же вызов с теми же байтами и ключом либо подключаются к принятому request. Новый ключ означает новую работу и возможное новое списание.

```ts
const result = await client.ai.run({
  account_id: accountId,
  profile: 'configured-text-profile',
  input: {
    messages: [{role: 'user', content: [
      {type: 'text', text: 'Опиши изображение.'},
      {type: 'image', asset_id: inputAssetId},
      {type: 'text', text: 'Ответь кратко.'}
    ]}]
  },
  parameters: {max_output_tokens: 512},
  execution: {max_attempts: 4},
  billing: {refused: 'platform'}
}, {
  key: savedInvocationKey,
  onAccepted: async accepted => saveRequestId(accepted.request_id),
  onAttempt: async () => clearProvisionalOutput(),
  onDelta: async delta => appendProvisionalOutput(delta.text),
  persist: async snapshot => saveResultDurably(snapshot)
});
```

Профиль, параметры и предел бюджета выбирает приложение по опубликованной конфигурации. Пример не является готовой конфигурацией модели. Для `estimated_actual` исходный резерв следует оценке; фактическое списание может отличаться, включая долг после cache miss. `isInsufficientCredits(error)` позволяет показать пополнение без создания повторного invocation.

## Поток и выдача

`ai.stream(body, {key, signal})` возвращает события `accepted`, `attempt`, `delta`, `result`. У delta есть request, attempt, generation, sequence и необязательный `field_path`. SDK отбрасывает дубликаты и устаревшие попытки. На `attempt` приложение очищает предварительный вывод. `live_incomplete` означает пропуск части потока; итоговый объект остаётся источником результата.

`delivery.field_paths`, например `['/reply']`, передаёт выбранные строковые поля JSON по мере поступления. Такие фрагменты предварительны до полной проверки схемы. При tools валидируется ровно один вызов; UAI возвращает имя и аргументы, а решение об исполнении инструмента остаётся у приложения.

Разрыв соединения или abort прекращает просмотр. Для остановки работы вызывают `requests.cancel(requestId, key)` явно. Для восстановления используют `ai.resumeStream(requestId)`; это не создаёт новую отправку провайдеру. Старые delta не хранятся как финансовые события; при восстановлении возможен gap и выдача только финального результата.

`ai.run` сначала вызывает `persist`, затем ACK. Если сохранение завершилось ошибкой, ACK не отправляется. При низкоуровневом `ai.stream` приложение само сохраняет результат и вызывает `requests.acknowledge` с `result_version` и `manifest_hash` из `delivery`. После ACK временный результат UAI может быть удалён: приложение должно показывать собственную сохранённую копию.

`execution_status` описывает результат работы; `settlement_status` — завершённость финансового расчёта. Отказ `refused` не повторяется. По умолчанию расход отказа несёт платформа; приложение может явно выбрать `actual_usage`. Неизвестный provider usage не становится нулевым. В `usage.attempts` доступны отдельные модели и расходы; `usage.summary.scope='all_attempts'` включает все попытки.

## Изображения и кошелёк

`assets.upload` загружает исходный файл с SHA-256, типом и размером. Порядок image-блоков задаёт место изображения в сообщении. Preserve сохраняет исходные байты; преобразование включается в конфигурации явно. Неиспользованные в блоках изображения для реального текстового адаптера отклоняются.

Принятое использование input продлевает срок хранения и удерживает файл для активного request. GET и ACK результата срок не продлевают и общий input не удаляют. Для продления есть `assets.renew(id, key)`. Если файл уже истёк или удалён, приложение повторно загружает собственный оригинал; `reupload` помогает только пока старое содержимое доступно. Постоянную медиатеку хранит приложение.

`wallets.subscribe(walletId, {signal})` выдаёт начальный снимок, затем изменения с возрастающей `revision`; после разрыва перечитывает снимок. `available_units` уже исключает резервы. Приложение хранит целые денежные значения строками, применяет только более новую revision и отдельно показывает `reserved_units` и отрицательный available.

## Локальная проверка и перенос

Стенд `scripts/universal-fixture.ts` запускается только с `UAI_ENV=test`, отключёнными реальными провайдерами, отдельной тестовой БД и `UAI_FIXTURE_ROOT`, содержащим `.data/demo-config.json` от seed. Порт браузера — `127.0.0.1:4348`. Исходные токены в HTML не передаются. Результаты сохраняются в `UAI_FIXTURE_ROOT/results` до ACK. `scripts/universal-latency.ts` измеряет только этот loopback-стенд; число выборок задаёт `UAI_LATENCY_SAMPLES`, файл отчёта — `UAI_LATENCY_OUTPUT`.

Для LogoPanel необходима отдельная задача в родительском репозитории: обновить `vendor/uai`, применить миграции, пересобрать сервер и клиент, проверить identity и persist-before-ACK, затем настроить утверждённые реальные ресурсы. Этот документ не означает, что submodule или работающий сервис уже обновлены.

## Эмбеддинги

Capability `embeddings.generate` использует общий `ai.run`/`ai.stream`, но не выдаёт предварительных векторов. Вход — `input: {texts: ['первая строка', 'вторая строка']}`, параметр `dimensions` опционален. Зарегистрированы OpenAI `text-embedding-3-small`, `text-embedding-3-large` и Voyage `voyage-4`; локальная реализация не подтверждает live-доступность.

Профиль публикует расчёт `input_mode: 'embedding_batch'`, без image assets. OpenAI использует `cl100k_base`, Voyage — консервативный UTF-8 bound. Принятый пакет — одна работа и один резерв. Выход содержит `model`, `revision: null`, `dimensions`, `data`; порядок нормализован по индексам. Подробности и причины неизвестной ревизии — в [контракте доработок](LOGOPANEL_FOLLOWUP_INTEGRATION.md).

Общие пределы: 128 строк, 16384 координаты и 512 КиБ результата; размерности и токенные пределы задаются моделью. Large допускает 3072, Voyage — 256/512/1024/2048 и query/document без truncation. См. [таблицу моделей и ограничений](LOGOPANEL_FOLLOWUP_INTEGRATION.md). Неполные или повторные индексы, неверная размерность и нечисловые координаты означают дефект всего пакета. Векторы постоянно хранит приложение после persist-before-ACK.

Протокол сверялся с [официальным embeddings API](https://developers.openai.com/api/reference/resources/embeddings/methods/create) 2026-09-25. Синтетические тарифы тестов не являются ценами OpenAI.

## Дополнения LogoPanel

[Контракт follow-up](LOGOPANEL_FOLLOWUP_INTEGRATION.md) описывает optional/null JSON Schema и локальные refs, эмуляцию forced tool choice, `priority`, `ai.forecast`, Recraft Styles/Vectorize и Quiver. Прогноз не резервирует средства; новые Quiver-профили имеют cap без overdraft.
