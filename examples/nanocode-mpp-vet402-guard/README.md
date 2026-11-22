# Nanocode MPP × vet402 payment guard

This crate wraps Nanocode’s [`Exchange`](https://github.com/nanocodexyz/nanocode/blob/e376d6d/crates/integrations/mpp/src/flow.rs) so **vet402’s key-less seller check** runs immediately before the stock `check_challenge` hook on the MPP payment path.

## What it does

1. Records the HTTPS URL of the outbound request when `Exchange::send` runs.
2. On `check_challenge`, calls `GET https://vet402.com/api/v1/check?url=<that URL>` (via a swappable `Vet402Checker` trait).
3. **BLOCK** → returns `HttpFault` with vet402 `reason_codes` and the payment URL; payment does not proceed.
4. **ALLOW** → runs Nanocode’s original `check_challenge`.
5. **WARN** or `not_in_catalog: true` → same as ALLOW unless `block_on_warn` is set.
6. vet402 unreachable, timeout, or malformed JSON → **stop by default** (`on_unreachable: Block`). Set `on_unreachable: Allow` to fall back to Nanocode’s check only.

Fail-closed defaults apply because this sits on the payment path.

## Usage

```rust
use std::sync::Arc;

use nanocode_mpp::flow::Exchange;
use nanocode_mpp_vet402_guard::{Vet402Guard, Vet402GuardConfig, Vet402Checker /* + your checker impl */};

let exchange: impl Exchange = /* nanocode_http::Client or your adapter */;
let checker: Arc<dyn Vet402Checker> = /* production HTTP client or test double */;
let guarded = Vet402Guard::new(exchange, checker, Vet402GuardConfig::default());
// Use `guarded` anywhere an `Exchange` is required (e.g. `send_with_exchange`).
```

Implement `Vet402Checker` in production to perform the HTTP GET and parse the body with `parse_vet402_check_body`. Tests should inject a stub and must not call live vet402 or real Tempo payments.

## Pin

Nanocode git dependency is pinned to revision **e376d6d** (`nanocode-mpp`).