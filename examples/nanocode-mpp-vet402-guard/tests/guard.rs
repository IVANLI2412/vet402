use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use nanocode_http::Request;
use nanocode_mpp::error::Fault;
use nanocode_mpp::flow::{Exchange, HttpFault};
use nanocode_mpp::protocol::Challenge;
use nanocode_mpp_vet402_guard::{
    OnUnreachable, Vet402CheckError, Vet402CheckResult, Vet402Checker, Vet402Guard,
    Vet402GuardConfig,
};

const PAYMENT_URL: &str = "https://api.example.com/paid";

#[derive(Clone)]
struct RecordingExchange {
    inner: Arc<RecordingState>,
}

struct RecordingState {
    check_calls: AtomicUsize,
    send_calls: AtomicUsize,
    fail_check: Mutex<bool>,
}

impl RecordingExchange {
    fn new() -> Self {
        Self {
            inner: Arc::new(RecordingState {
                check_calls: AtomicUsize::new(0),
                send_calls: AtomicUsize::new(0),
                fail_check: Mutex::new(false),
            }),
        }
    }

    fn check_count(&self) -> usize {
        self.inner.check_calls.load(Ordering::SeqCst)
    }

    fn send_count(&self) -> usize {
        self.inner.send_calls.load(Ordering::SeqCst)
    }
}

impl Exchange for RecordingExchange {
    type Error = String;

    fn check_challenge(&self, _challenge: &Challenge) -> Result<(), HttpFault> {
        self.inner.check_calls.fetch_add(1, Ordering::SeqCst);
        if *self.inner.fail_check.lock().unwrap() {
            return Err(HttpFault::UnsafeCredentialHeader);
        }
        Ok(())
    }

    fn http_client(&self) -> Option<nanocode_http::Client> {
        None
    }

    async fn send(&mut self, _request: Request) -> Result<nanocode_http::Response, Self::Error> {
        self.inner.send_calls.fetch_add(1, Ordering::SeqCst);
        Err("payment path must not run in these tests".into())
    }
}

struct StubChecker {
    outcome: Mutex<Result<Vet402CheckResult, Vet402CheckError>>,
    calls: AtomicUsize,
}

impl StubChecker {
    fn allow() -> Arc<Self> {
        Arc::new(Self {
            outcome: Mutex::new(Ok(Vet402CheckResult {
                recommendation: "ALLOW".into(),
                not_in_catalog: false,
                reason_codes: vec!["l0_pass".into()],
                evidence_url: Some("https://vet402.com/observatory/e/demo".into()),
            })),
            calls: AtomicUsize::new(0),
        })
    }

    fn block() -> Arc<Self> {
        Arc::new(Self {
            outcome: Mutex::new(Ok(Vet402CheckResult {
                recommendation: "BLOCK".into(),
                not_in_catalog: false,
                reason_codes: vec!["high_refund_rate".into()],
                evidence_url: None,
            })),
            calls: AtomicUsize::new(0),
        })
    }

    fn unreachable() -> Arc<Self> {
        Arc::new(Self {
            outcome: Mutex::new(Err(Vet402CheckError::Transport("timeout".into()))),
            calls: AtomicUsize::new(0),
        })
    }

    fn call_count(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl Vet402Checker for StubChecker {
    fn check(&self, _url: &str) -> Result<Vet402CheckResult, Vet402CheckError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.outcome.lock().unwrap().clone()
    }
}

fn sample_challenge() -> Challenge {
    let request_json = r#"{"amount":"0","currency":"0x0"}"#;
    let request = URL_SAFE_NO_PAD.encode(request_json.as_bytes());
    let json = format!(
        r#"{{
            "id": "test-challenge",
            "realm": "api.example.com",
            "method": "tempo",
            "intent": "charge",
            "request": "{request}"
        }}"#
    );
    serde_json::from_str(&json).expect("valid challenge json")
}

fn guard<X: Exchange>(
    inner: X,
    checker: Arc<dyn Vet402Checker>,
    on_unreachable: OnUnreachable,
) -> Vet402Guard<X> {
    Vet402Guard::new(
        inner,
        checker,
        Vet402GuardConfig {
            block_on_warn: false,
            on_unreachable,
            check_base: "https://vet402.com/api/v1/check".into(),
        },
    )
    .with_payment_target_url(PAYMENT_URL)
}

#[test]
fn block_returns_http_fault_without_inner_check_or_payment() {
    let inner = RecordingExchange::new();
    let checker = StubChecker::block();
    let guard = guard(inner.clone(), checker.clone(), OnUnreachable::Block);
    let challenge = sample_challenge();

    let err = guard.check_challenge(&challenge).unwrap_err();
    match err {
        HttpFault::Payment(Fault::Config(message)) => {
            assert!(message.contains(PAYMENT_URL));
            assert!(message.contains("high_refund_rate"));
        }
        other => panic!("expected payment config fault, got {other:?}"),
    }

    assert_eq!(inner.check_count(), 0, "inner check_challenge must not run");
    assert_eq!(inner.send_count(), 0, "payment send must not run");
    assert_eq!(checker.call_count(), 1);
}

#[test]
fn allow_delegates_to_inner_check_unchanged() {
    let inner = RecordingExchange::new();
    let checker = StubChecker::allow();
    let guard = guard(inner.clone(), checker.clone(), OnUnreachable::Block);
    let challenge = sample_challenge();

    guard.check_challenge(&challenge).expect("ALLOW passes");

    assert_eq!(inner.check_count(), 1);
    assert_eq!(checker.call_count(), 1);
}

#[test]
fn unreachable_blocks_by_default_and_allows_with_config() {
    let checker = StubChecker::unreachable();
    let blocked = guard(RecordingExchange::new(), checker.clone(), OnUnreachable::Block)
        .check_challenge(&sample_challenge())
        .unwrap_err();
    match blocked {
        HttpFault::Payment(Fault::Config(message)) => {
            assert!(message.contains("unreachable"));
        }
        other => panic!("expected unreachable block, got {other:?}"),
    }

    let inner2 = RecordingExchange::new();
    let allowed = guard(inner2.clone(), checker, OnUnreachable::Allow);
    allowed
        .check_challenge(&sample_challenge())
        .expect("fallback when on_unreachable Allow");
    assert_eq!(inner2.check_count(), 1);
}