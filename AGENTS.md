# Repository Guidelines

## Current Scope

UAI contains the specification and a local implementation of API, PostgreSQL accounting, workers, scheduler, SDK, admin and demo. Use `docs/LOCAL_RUN.md` for commands and `docs/ACCEPTANCE_RESULTS.md` for verified coverage. Local fixtures do not establish real-provider or production readiness. Implementation phases and acceptance scenarios remain defined in `docs/IMPLEMENTATION.md`; Logo Panel integration and full production preparation are outside the current scope.

## Compatibility before the first launch

By the owner's decision of 2026-09-25, UAI and LogoPanel are being developed in parallel and will launch together. Backward compatibility is not a requirement before that launch. When changing contracts, update the affected API, SDK, configuration, tests and documentation together; do not add legacy branches, adapters, separate format versions or transitional modes solely to remain compatible with an earlier implementation. This rule applies to UAI and its LogoPanel integration, not to all of the owner's projects. Financial invariants and idempotency remain mandatory. See the [decisions](docs/DECISIONS.md).

## Architecture and Ownership

Use `docs/README.md` as the specification index. Read `docs/DECISIONS.md` before changing behavior: it distinguishes agreed product decisions from proposed configuration values. Keep changes consistent across accounting, quoting, execution, API, and acceptance scenarios rather than updating only one description.

Accounting owns credit lots, reservations, postings, and financial invariants. Quoting determines authorized work and spending limits. Execution owns attempts, queues, provider routing, recovery, and cancellation. API contracts must preserve all three sets of rules. Provider costs, customer charges, and external payment revenue are separate records.

The intended deployment is one independent installation per owner-operated application. Logo Panel is the first planned client, not a dependency of this repository. References to its source paths in migration documentation describe that external project; do not create placeholder source files to satisfy them.

## Documentation Changes

Keep documentation in English and use relative links between repository documents. JSON examples must parse, monetary integer values travel as strings, and examples must not imply that synthetic prices are current provider prices. Preserve stable requirement and acceptance IDs when extending their coverage.

Check Markdown fences, local links, JSON examples, and cross-document policy consistency after edits. Distinguish documentation validation from implementation tests. Store no credentials, provider responses containing private content, or application databases in Git.

## Repository Operations

Preserve unrelated changes. Ask before creating additional branches or pull requests. Repository publication does not authorize deploying the service, changing provider configuration, or running paid model requests.
