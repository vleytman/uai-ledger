# Контракты доработок LogoPanel

Дата: 2026-09-25. [План](LOGOPANEL_FOLLOWUP_PLAN.md).

## Embeddings

Все три модели используют `embeddings.generate`, `input.texts` и общий результат `type: embeddings`. Индексы нормализованы в порядке входных строк. Результат содержит `model`, `revision`, `dimensions`, `data`. У текущих адаптеров `revision: null`: алиас не доказывает точную ревизию и не позволяет обнаружить скрытое обновление модели.

| Модель | Размерности | По умолчанию | Токены: строка / пакет | Тип входа |
|---|---|---|---|---|
| OpenAI text-embedding-3-small | 1–1536 | 1536 | 8192 / 300000 | Не передаётся |
| OpenAI text-embedding-3-large | 1–3072 | 3072 | 8192 / 300000 | Не передаётся |
| Voyage voyage-4 | 256, 512, 1024, 2048 | 1024 | 32000 / 320000 | `query`, `document`, либо не задан |

Защитные пределы установки пересекаются с модельными: 128 строк, 16384 координаты суммарно, 512 КиБ сериализованного результата. Для Large 3072 это максимум пять строк за вызов. OpenAI дополнительно ограничен 32768 UTF-8 bytes на строку; общий подготовленный текст пакета — 128000 bytes. Опубликованные profiles/catalog возвращают `embedding_features` с модельными и общими пределами.

OpenAI использует `cl100k_base`. Для Voyage нет локального точного токенизатора: проверка использует число UTF-8 bytes и запас 64 на строку с `input_type`. Поэтому часть допустимых у провайдера текстов будет отклонена консервативно. Адаптер всегда передаёт `truncation: false`, `output_dtype: float`; `dimensions` переводится в `output_dimension`. Скрытой обрезки нет. В примере профиля прогноз добавляет общий запас 8192 токена на пакет; фактический учёт использует provider usage.

Пакет остаётся атомарной работой. Дефект одного вектора делает дефектным весь результат. Векторы постоянно хранит приложение; повтор команды с тем же ключом и повтор ACK не вызывают нового запроса и списания.

## Структурированные ответы и tools

Поддерживается ограниченное подмножество JSON Schema:

- `type`: object, array, string, number, integer, boolean, null, включая массив типов.
- `properties`, `required`, `additionalProperties: false`, `items`; необязательные свойства допускаются. Для преобразования в API провайдера все объекты должны явно запрещать неизвестные свойства.
- Скалярные `enum`, `const`; `anyOf`, `oneOf`. У union-узла допускаются только варианты, `$defs`, `title`, `description`; assertion-соседи отклоняются. `oneOf` проверяется на ровно один подходящий вариант локально.
- `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `pattern`; вложенные массивы объектов.
- `$defs` в корне и `$ref` вида `#/$defs/name` с JSON Pointer escaping. Циклы, внешние ссылки и siblings у `$ref`, кроме аннотаций, отклоняются без сетевых запросов.

Пределы: 64 КиБ схемы, глубина 16, 2048 развёрнутых узла, 256 свойств, 16 ветвей на union, 256 значений enum, pattern до 256 символов. Числовые длины/размеры — до 1000000. Regex — Unicode JavaScript, без групп, lookaround, alternation, backreferences и повторных квантификаторов. Допустим максимум один повторяемый атом; с повтором обязательны `^` и `$`; числовой повтор не более 10000. Например, `^[a-z]+$` поддерживается. Это намеренно ограниченный язык без опасного backtracking. Остальные keywords, в том числе `format`, `allOf`, `not`, `patternProperties`, отклоняются до отправки.

В wire schema optional-поле становится служебным объектом `{present:false}` или `{present:true,value:…}`. Клиент никогда не видит эту оболочку. После восстановления отсутствующее поле удаляется, а явный пользовательский `null` сохраняется. Ограничения проверяются по исходной схеме; провайдеру отправляется более простая строгая схема. Корневые скаляры/массивы и union также получают служебную оболочку.

Для преобразованной схемы промежуточные дельты буферизуются до полного восстановления и проверки. Для неизменённой схемы поток сохраняется. `delivery.field_paths` поддерживает объявленные строковые свойства объектов, включая вложенные; индексы и wildcard массивов не поддерживаются. Итоговый результат остаётся авторитетным. Дефект содержит `usage.attempts[].validation_error` с JSON Pointer `path` и коротким `reason`, без значения поля.

Каталог может объявить `text_features.forced_tool_choice: false` или `tools: false, schema: true`. UAI автоматически запрашивает структурированный envelope одного tool call, проверяет имя, аргументы и число вызовов и возвращает обычный `tool_call` с `execution_method: schema`. Для native tools значение — `native`. У зарегистрированных Anthropic семейств Opus 5.5, Fable 5.1, Mythos 5.1 принудительный вызов переводится в schema-режим. Нужна опубликованная возможность structured output. Refusal остаётся отказом; эмуляция не создаёт дополнительной попытки и не исполняет сам инструмент.

## Приоритет и запас параллельности

`priority: interactive | background` принимается в quote/invocation; по умолчанию `background`. Приложение явно маркирует запрос пользователя. При использовании готового quote изменить его приоритет нельзя.

Начальный `interactive_reserve` — один слот. Фон может занять не более `max(1, total - reserve)` слотов. Запас действует для исполняемых задач очереди, приложения и аккаунта, публикации jobs очереди/приложения/аккаунта, provider quota group и legacy limiter. Общая активная ёмкость аккаунта продолжает ограничивать оба класса. Настройки очереди, группы и limiter доступны через существующие admin API и формы. Legacy lease API принимает `interactive_reserve`; worker-процесс использует `UAI_WORKER_INTERACTIVE_RESERVE` (по умолчанию 1), `UAI_WORKER_CONCURRENCY` — общую ёмкость.

При ёмкости 1 отдельного слота для interactive нет. Уже запущенная работа не вытесняется. Отказ локального worker gate оставляет durable request в очереди; reconciler вновь публикует его. Возраст задачи повышает порядок выбора; разница между новыми interactive/background — десять минут ожидания. Fairness между аккаунтами сохраняется. Это не обещание времени начала при непрерывном превышении доступной мощности.

Приоритет не меняет budget, authorization, rate windows, backpressure, deadline, attempt cap или неизвестный исход. Он не позволяет обойти provider quota. Введены миграции `0070_logopanel_validation.sql`, `0071_interactive_capacity.sql`.

## Прогноз списка вызовов

`POST /v1/forecasts`, scope `ai:quote`, SDK `client.ai.forecast(body)`. Вызов читает опубликованные single-call профили; новый рецепт не регистрируется. Кошелёк, reserve, allowance, operation, execution request и provider call не создаются. Account authorization сохраняется.

```json
{
  "account_id": "account-example",
  "calls": [
    {
      "profile": "files.logopanel.text-embedding-3-large",
      "count": 20,
      "parameters": {"dimensions": 3072},
      "volumes": [
        {"dimension": "input.uncached", "unit": "tokens", "quantity": "500", "low": "400", "high": "700"}
      ]
    }
  ]
}
```

`quantity/low/high` — ожидаемый объём одного вызова; `count` умножает его. Все денежные величины и количества передаются строками. Лимиты: 100 позиций, 1000 повторений позиции, 32 dimensions. Нужны все тарифицируемые dimensions профиля; пустой список, нулевой суммарный объём, дубли, неизвестные dimensions и неупорядоченный диапазон отклоняются. Поддерживаются профили с quantity components или объявленными `maximum_items`; USD-formula и multi-component recipe требуют конкретного ввода и здесь явно отклоняются.

Ответ разделяет `provider_cost` и `customer_charge`, каждый с `expected_units/low_units/high_units`, фиксирует версии profile/route/catalog/rate card, время и `method_version: lf-forecast-1`. Для tokens без пользовательских границ используется эвристика от половины до удвоенного объёма, confidence `low`. Иначе confidence `modeled`; `approximate` расчёт также даёт `low`. Процент точности не заявляется. Причины и предположения возвращаются в ответе. Не учитываются дополнительные attempts, fallback, бесплатный allowance и скрытые скидки. Safety применяется к цене quoted-final профиля, markup — по его политике; при actual pricing safety не увеличивает фактическое списание.

`range_is_charge_cap: false`: верхняя граница прогноза не разрешает расход и не гарантирует максимум. Отдельная quote/invocation по-прежнему авторизует работу.

## Recraft и Quiver SVG

| Провайдер / модель | Capability | Вход |
|---|---|---|
| Replicate recraft-ai/recraft-v4-styles-svg | image.generate | prompt, 1–10 raster references |
| Replicate recraft-ai/recraft-v4-styles-pro-svg | image.generate | prompt, 1–10 raster references |
| Replicate recraft-ai/recraft-vectorize | image.vectorize | Ровно один raster asset, без prompt |
| Quiver arrow-2, arrow-2-telos | image.generate | prompt, до 16 references |
| Quiver arrow-2, arrow-2-telos | image.vectorize | Ровно один raster asset, без prompt |

Картинки предварительно загружаются стандартным assets API, затем передаются как `input.asset_ids`. При подготовке SVG-профилей требуется `mode: preserve`; байты не уменьшаются и не перекодируются незаметно для клиента. Допускаются PNG/JPEG/WebP, один кадр, до 4096 по стороне и 16777216 пикселей. Replicate — до 5000000 bytes на файл, Quiver — до 12 МиБ, подготовленный пакет UAI — до 20000000 bytes. Recraft Vectorize требует минимум 256 по каждой стороне. Проверка декодирует точные отправляемые байты до provider call. Prompt — до 10000 bytes.

Replicate получает `style_reference_images`, именно так поле названо в input schema; README провайдера использует другое имя. Styles допускает `size` из опубликованного списка и `style_match: precise | flexible`; Pro использует удвоенные размеры. Создаётся native prediction, его ID сохраняется до polling; lookup и cancel используют фиксированный API host. Результат скачивается только с HTTPS `replicate.delivery` и поддоменов, без redirect и передачи Authorization. `style_id` не сохраняется в результате или usage и не принимается во входе.

Цена успешного результата: `output.image/images=1`, для Styles дополнительно `style.creation/calls=1`. В проверенной цене 25.09.2026 Styles — $0.05, Pro — $0.12, Vectorize — $0.01 за output image; отдельная надбавка за создание стиля не опубликована. В файлах она **явно включена** нулевой отдельной ставкой, а не забыта. Если применимый тариф изменится, нужна новая rate card с нужной надбавкой. Failed/canceled prediction не доказывает нулевой расход: usage остаётся unknown.

Quiver использует прямые `/v1/svgs/generations` и `/v1/svgs/vectorizations`, `n:1` при генерации и обязательный `max_output_tokens` (1–65536). Для генерации доступны `reasoning_effort`, `temperature`, `top_p`; для vectorize — `auto_crop`, `temperature`, `top_p`. Результат — один `image/svg+xml`.

Для реальной генерации нужен production-ключ Quiver. Ключи `sk_test_` возвращают синтетический SVG без запуска модели и расходов; адаптер отклоняет их до отправки с `quiver_sandbox_key`. Ответ с `x-quiver-environment: test` также не выдаётся как реальная генерация. [Документация sandbox](https://docs.quiver.ai/developers/guides/sandbox-and-test-keys).

| Quiver, USD / 1M tokens | Обычный вход | Cache read | Cache write | Выход |
|---|---|---|---|---|
| arrow-2 | 4 | 0.4 | 5 | 20 |
| arrow-2-telos | 6 | 0.6 | 7.5 | 30 |

`input_tokens` включает кэш: обычный вход = input − cached − cache_write; все три части тарифицируются один раз. Reasoning входит в `output_tokens` и сохраняется только как breakdown, без второго начисления. Несогласованные counters или только один из двух cache counters дают `unknown`, а не стоимость ноль. **Native SVG reference Quiver не гарантирует поля cache breakdown**; их имена подтверждены в документации Responses API. По [решению от 20.10.2026](DECISIONS.md#запросы-logopanel-от-20102026) ответ совсем без разбивки тарифицирует весь вход по ставке cache write, самой высокой ставке входа, с отметкой `input_cache_split=absent_priced_as_cache_write` в breakdown. Расход становится известным, и вызов рассчитывается. Это верхняя граница, а не точная цена Quiver.

Проверка Quiver выявила отсутствие разбивки кэша в usage. Сумма из интерфейса поставщика не заменяет счётчики тарификации. Политика расчёта входа по ставке cache write описана в [решениях](DECISIONS.md).

Новые Quiver-профили используют `actual_capped`: резервируется явный customer cap, actual usage тарифицируется с markup, capture ограничен принятым максимумом. Право overdraft передаётся отдельным признаком только для `estimated_actual`; наличие token pricing само по себе его не включает. Фактическая себестоимость сохраняется целиком, даже если она выше customer cap. Сбой транспорта/5xx/408 после отправки — unknown без автоматического повторения. Quiver не объявляет native lookup/cancel: abort после отправки не доказывает отмену у провайдера.

SVG проходит существующий storage/manifest/ACK/TTL и локальную проверку. Запрещены script, foreignObject, style, animation, event handlers, внешние href/src, `url()`, `@import`, entities/DOCTYPE и processing instructions. Поддержка `<style>` не расширена без реального проверенного формата. Безопасность подтверждается отказом от неподдерживаемого SVG, а не его молчаливой «починкой».

## Конфигурации

В `configurations/ai/logopanel/` находятся десять отдельных неактивированных bundles: три embeddings, три Replicate и по generate/vectorize для двух Quiver. Symbolic bindings `primary` и `period` задаются владельцем установки при публикации. Эти файлы не меняют действующие подключения. Цены имеют источник и дату; перед применением их нужно пересверить. Markup 0 и один attempt в примерах — настройки примера, не универсальная продуктовая политика. Генератор: `pnpm exec tsx scripts/generate-logopanel-examples.ts`.
