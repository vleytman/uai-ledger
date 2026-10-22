# Cerebras, Groq и Google Cloud

[Оглавление](README.md) · [План](ALTERNATIVE_MODEL_IMPLEMENTATION_PLAN.md)

## Подключение

Реестр содержит `cerebras@1`, `groq@1`, `google_cloud@1`. Допустимы только пять IDs из [набора конфигураций](../configurations/ai/alternatives/). Импорт модуля и обновление репозитория не публикуют их в БД. Для установки используются обычные команды [файловой конфигурации](FILE_CONFIGURATION.md), отдельные bindings connections и budget `alternative-models`.

Cerebras и Groq используют ключ из зашифрованного credential vault. Google Cloud использует JSON service account или authorized-user ADC в том же vault. `account_scope` подключения Google должен содержать `project` и `location: global`. Worker получает краткоживущий OAuth token через google-auth-library. Конкурентные попытки одного worker разделяют обновление токена; ошибка обновления не отправляет генерацию. После 401/403 уже отправленная генерация не повторяется адаптером. Токены и JSON credentials не входят в quote, API read или browser bundle.

Маршрут Google требует `service_mode: standard`. В запросе фиксируется `X-Vertex-AI-LLM-Request-Type: shared`, заголовок выбора Flex/Priority не отправляется. Priority отклоняется при публикации и исполнении. Requested mode хранится в route/attempt snapshot и usage evidence, actual mode остаётся неизвестным, пока API его не сообщит. Billing/IAM/API владелец включает отдельно.

## Возможности и история tools

TextFeatures описывает tools, forced choice, parallel/history, schema-streaming, tool-streaming, output limit и usage counters. Неизвестное сочетание не подразумевается общим флагом tools. Schema и tools одновременно запрещены. Schema-streaming Cerebras/Groq в этой поставке закрыт. У Google доступен native streamGenerateContent.

`tool_choice` принимает required, named, auto и none. Required/named сохраняют контракт ровно одного вызова. Для нескольких вызовов нужны auto и `parallel_tool_calls: true`, а модель должна поддерживать parallel. Результат одного вызова имеет type tool_call, нескольких — tool_calls с массивом calls. ID провайдера сохраняется и используется в последующем tool_result.

Пример входа второго запроса:

```json
{
  "messages": [
    {"role":"user","content":[{"type":"text","text":"Найди синий цвет"}]},
    {"role":"assistant","content":[{"type":"tool_call","id":"call-1","name":"lookup_color","arguments":{"color":"blue"}}]},
    {"role":"user","content":[{"type":"tool_result","call_id":"call-1","result":{"hex":"#0000ff"}}]}
  ]
}
```

Для ошибки инструмента tool_result содержит `is_error: true`. Дубликаты IDs, результаты без вызова и незавершённые группы вызовов отклоняются. UAI не исполняет пользовательские инструменты.

Google thought signature находится в `continuation` конкретного tool_call с provider, model и thought_signature. Приложение сохраняет это поле без изменений. Оно не входит в текст ответа. История с подписью другого поставщика или модели делает fallback недопустимым уже при quote. OpenAI/Anthropic пока отклоняют новые history blocks, их существующий одиночный forced-call контракт сохранён.

## Расчёт и тарифы

Все пять примеров используют estimated_actual. Режим допускается по capabilities адаптера, а не whitelist имён поставщиков. Expected output задаёт прогноз, max_output_tokens задаёт отдельно отправляемый лимит. Новый capped-профиль с приблизительной оценкой отклоняется, пока нет доказанной границы provider exposure.

Оценщик считает UTF-8 полного контекста после существующего schema compiler, framing и изображения. Это локальная приблизительная оценка, не tokenizer Qwen/Harmony/Gemini и не измеренная точность. На Groq Qwen изображение учитывается как 2048 токенов по карточке модели. Для Cerebras/Gemini применяется явно приблизительная величина 4096. Ошибка измерена на 34 живых ответах в ходе функциональной проверки, включая vision и reasoning. Корпус мал, статус approximate сохранён; input прогноз сильно завышает короткие prompts. Это не репрезентативная калибровка. [Документация CountTokens](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/get-token-count), проверенная 26.09.2026, перечисляет Gemini 3.8 Flash и бесплатный подсчёт; та же страница указывает максимум 3000 запросов в минуту. Для изображений это оценка, которая может отличаться от итогового billed usage. Доступность в целевом аккаунте не проверялась. CountTokens не вызывается неявно при quote.

Chat completion_tokens уже включают reasoning, поэтому reasoning не прибавляется повторно. В Gemini candidatesTokenCount и thoughtsTokenCount учитываются раздельно, затем суммируются. Cached input вычитается из полного prompt count. Отсутствующие обязательные input/output counters оставляют usage неизвестным. Нулевой cache при отсутствии необязательного счётчика не сохраняется как измеренное значение. Для Google HTTP 4xx/5xx сохраняются нулевые billable quantities по опубликованным правилам тарификации и основание billing_basis; фактические token counters остаются неизвестными. Потеря транспорта и HTTP 200 без usage не превращаются в бесплатный запрос.

Groq GPT-OSS 20B cache-read стоит 0.0375 USD за миллион токенов. Кэширование Groq Qwen не заявлено. Cloud rate card относится только к Standard/global и заканчивается 2027-01-01T00:00:00Z. Новую опубликованную ставку нужно добавить отдельной версией. После окончания периода публикация, quote и новая отправка без применимой ставки останавливаются. Уже известный расход не исчезает из учёта.

Себестоимость, списание клиента и внешняя оплата остаются раздельными. Предварительный cache forecast холодный; подтверждённый cache hit сохраняется. Cache identity включает account, connection, model, prefix, tools/schema и параметры, кроме прогноза/лимита выхода. Explicit cache lifecycle не создаётся.

## Квоты и наблюдение

Для рабочего запуска подключения связываются с существующими account/model quota groups. Несколько ключей одного аккаунта связываются с одной группой. Реальные лимиты установки не включены в JSON-примеры. Для Google 3.8 Flash fixed quota не заявлена, численный Standard throughput целевого аккаунта не подтверждён. В консоли видны QCD варианты, их лимиты нельзя переносить на Standard. Общая таблица соседних моделей не заменяет проверку аккаунта.

Адаптеры не повторяют генерацию самостоятельно. Общий execution policy, deadline, fencing, idempotency и outcome_unknown действуют без отдельной очереди. Token admission новых моделей использует консервативный полный context limit и max output. Это может потребовать меньшего профиля или проверенного оценщика для низких account quotas. Retry-After и доступные rate-limit headers поступают существующему admission. Ошибки auth, quota, transient, invalid, refusal, defect и unknown остаются разными исходами.

Существующие метрики очереди и request timings дают queue wait, active requests, TTFT и полное время. Usage observations содержат terminal counters, finish reason, requested/actual service mode и признак provider stream. Сравнение quote и actual выполняется по сохранённому calculation snapshot и provider cost. Это локальный расчёт, не сверка со счётом поставщика; reporting API новых поставщиков не заявлен.

## Живой прогон

Исторический smoke manifest содержал 33 вызова, пять IDs, сценарии, input/output/image limits и максимальный расход. Общий предел — 9.850552320 USD (9850552320 внутренних денежных единиц). Сумма provider budgets равна этому пределу. Верхняя финансовая оценка использует полные документированные context/output limits моделей, а не expected output. Она намеренно намного выше ожидаемого расхода коротких prompts.

```sh
pnpm exec tsx scripts/check-alternative-models.ts manifest
pnpm exec tsx scripts/check-alternative-models.ts fixture /tmp/ami-fixture-report.json
```

Runner требует отдельную локальную БД с именем uai_ami_test… или uai_ami_live…. Для live дополнительно нужны явное одобрение SHA256 manifest в UAI_AMI_APPROVED_MANIFEST_SHA256, пути UAI_AMI_CEREBRAS_CREDENTIAL_FILE, UAI_AMI_GROQ_CREDENTIAL_FILE, UAI_AMI_GOOGLE_CLOUD_CREDENTIAL_FILE и UAI_AMI_GOOGLE_PROJECT, а также реальные account scope в UAI_AMI_CEREBRAS_ACCOUNT и UAI_AMI_GROQ_ACCOUNT. Не передавайте содержимое credentials в чат. Прогон создаёт отдельную установку, использует только её scoped worker, max_attempts=1 и последовательные запросы. При неизвестном usage/исходе или отказе он останавливается и сохраняет IDs для разбора. В конце флаг реальных вызовов выключается и созданные подключения отключаются. Результат ACK выполняется только после проверки завершённого запроса. В отчёте сохраняются IDs до dispatch, стоимость отказов с известным usage и оставшиеся резервы. При неизвестной стоимости cost_state=incomplete, а cost_units содержит только известную часть суммы. Разница прогноза и факта приводится для input/output/cost; relative_error_ppm измеряется в миллионных долях и равна null при нулевом факте. Fixture помечен not_calibrated, живой smoke даёт только небольшую выборку sample_only. Рабочие маршруты и внешний LogoPanel не активируются.

Локальный browser fixture: `pnpm exec tsx scripts/run-alternative-fixture.ts`, при DATABASE_URL отдельной uai_ami_test… БД. Пароль fixture — ami-local-fixture, admin на 4336, demo на 4337. Реальные провайдеры выключены.

Сводка завершённых прогонов приведена в [проверках провайдеров](REAL_PROVIDER_CHECKS.md). Для нового manifest используется UAI_AMI_CONTINUATION_REPORT с предыдущим JSON-отчётом; команда manifest вычисляет новый SHA. Live требует отдельного разрешения этого SHA. UAI_AMI_DEFER_PROVIDERS позволяет явно отложить поставщика без отправки, результат будет deferred, а не passed.

UAI_AMI_RESUME_REPORT задаёт подтверждённый prefix ранее начатого manifest. Runner сверяет статусы и стоимость с БД, требует закрытые резервы, пропускает все уже отправленные запросы, включая failed, и сохраняет исходный SHA разрешения. Начать со второго шага tools без сохранённого первого шага нельзя. Это продолжение оставшихся разрешённых сценариев, а не разрешение повторить ошибочный вызов. Для неизвестного финансового результата resume запрещён. Позднее подтверждение стоимости terminal failed attempt выполняется через `confirmFailedAttemptCost` только по существующей рассчитанной cost entry, с actor/reason и аудитом; оно не меняет исход, не запускает генерацию и не списывает деньги у клиента после закрытия.

В пяти bundles live_validation=passed ссылается на функциональную приёмку 26.09.2026. Credentials, доступ и квоты новой установки проверяются отдельно; публикация этих файлов не включает основной маршрут автоматически.
