# Sources and limitations

[Contents](README.md)

Prepared on 2026-09-18. The official pages below were read during the architecture discussion. This is documentation verification, not successful access to financial APIs for user accounts. Before implementing an adapter, recheck its schema, access requirements and current terms.

These documents do not provide a live price list for any specific model. All numerical operation examples are synthetic. The credit-unit coefficient is our project decision.

## OpenAI

- [Usage API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage) describes aggregated usage types and breakdowns by available dimensions. Aggregate usage is not a user wallet.
- [Costs API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs) describes costs; the version reviewed supports daily buckets and grouping within the available scope. This does not promise a real-time prepaid account balance.
- [Rate limits](https://developers.openai.com/api/docs/guides/rate-limits) describes organization and project limits, shared model groups, Retry-After and remaining/reset headers. A temporary rate limit differs from quota and payment issues.

These sources do not establish that any ordinary API key can read financial reports or that any request ID can recover a result. Such capabilities must be verified separately for each endpoint and account.

## Anthropic

- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) describes cache_read_input_tokens, cache_creation_input_tokens and input_tokens, which excludes those two categories. Cache writes have different TTLs.
- [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) describes organization reports and separate credential requirements. In the reviewed version, usage/cost usually appears within five minutes of a request; costs are available at daily granularity. The document also identifies coverage limitations for particular billing modes.

An adapter must not assume that input_tokens has the same meaning as another provider's counter. Financial scope is checked when connecting; missing permissions do not mean zero cost.

## OpenRouter

- [Get remaining credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits) describes total_credits and total_usage. The reviewed page also shows a restriction to management keys for this operation.

An API of this kind at OpenRouter does not imply an equivalent method exists at every provider. An external account balance is not the credit balance of an individual user on our platform.

## Cartesia

- [Get Credit Usage](https://docs.cartesia.ai/api-reference/usage/credits) describes aggregate credit usage over time and available dimensions, including model and API key.

Consumed provider credits must be converted to cost under the terms of the corresponding connection. They cannot automatically be equated to ai-credit-usd-v1. Allowance included in a provider subscription and paid overages must be explicitly represented by the chosen cost model.

## Applying provider plans

Some providers sell subscriptions with included usage. For such a connection, the administrator selects a documented provider costing model: an effective allocated rate or the marginal rate of the next use. The rate card specifies the source and method.

The subscription fee is accounted for separately in the provider cost report. Do not both include the entire fee in each request's effective rate and add the same amount again to total costs. Without an established model, the cost remains unknown.

The cost used for customer rating must be published and understandable. A one-off change to subscription-fee allocation during reconciliation does not create retroactive wallet debits.

## Current Logo Panel

Source paths in this section belong to the separate Logo Panel project. Its code is not part of UAI; these structural references are retained as migration context, not as files in this repository.

The source code was reread when preparing this documentation:

- `server/providers/contracts.ts`.
- `server/engine.ts`, including job execution and usage persistence after fn.
- `server/store.ts`, including project jobs, totalCost calculation and project deletion behavior.
- `server/index.ts`.

These observations are used only for the migration plan. The new documentation does not change the current product's implemented `SPEC.md` or declare the universal platform ready.

## Interface stack

- [Installing shadcn/ui for TanStack Start](https://ui.shadcn.com/docs/installation/tanstack) describes the officially supported setup for this combination.
- [TanStack Start overview](https://tanstack.com/start/latest/docs/framework/react/overview) describes the server layer and routing. During the 2026-09-18 discussion, the page identified its status as Release Candidate. This is an observation as of that review date; implementation requires checking the current version, pinning dependencies and validating build/startup in the selected environment.

Component selection does not replace the design and browser acceptance requirements in [OPERATIONS](OPERATIONS.md).
