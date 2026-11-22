//! Wraps [`nanocode_mpp::flow::Exchange`] so vet402's key-less seller check runs before the
//! stock `check_challenge` (Nanocode `flow.rs`).

use std::cell::Cell;
use std::fmt::Display;
use std::future::Future;
use std::sync::Arc;

use nanocode_mpp::error::Fault;
use nanocode_mpp::flow::{Exchange, HttpFault};
use nanocode_mpp::protocol::Challenge;
use serde::Deserialize;

pub const DEFAULT_VET402_CHECK_BASE: &str = "https://vet402.com/api/v1/check";

/// When vet402 cannot be reached or returns an unexpected body, the default is to stop payment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OnUnreachable {
    #[default]
    Block,
    Allow,
}

#[derive(Debug, Clone)]
pub struct Vet402GuardConfig {
  /// Treat WARN and `not_in_catalog` like BLOCK when true.
  pub block_on_warn: bool,
  pub on_unreachable: OnUnreachable,
  pub check_base: String,
}

impl Default for Vet402GuardConfig {
    fn default() -> Self {
        Self {
            block_on_warn: false,
            on_unreachable: OnUnreachable::Block,
            check_base: DEFAULT_VET402_CHECK_BASE.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Vet402CheckResult {
    pub recommendation: String,
    pub not_in_catalog: bool,
    pub reason_codes: Vec<String>,
    pub evidence_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Vet402CheckError {
    Transport(String),
    InvalidBody(String),
}

/// HTTP vet402 check, swappable for tests (never hits production in unit tests).
pub trait Vet402Checker: Send + Sync {
    fn check(&self, url: &str) -> Result<Vet402CheckResult, Vet402CheckError>;
}

pub struct Vet402Guard<X> {
    inner: X,
    checker: Arc<dyn Vet402Checker>,
    config: Vet402GuardConfig,
    payment_target_url: Cell<Option<String>>,
}

impl<X> Vet402Guard<X> {
    pub fn new(inner: X, checker: Arc<dyn Vet402Checker>, config: Vet402GuardConfig) -> Self {
        Self {
            inner,
            checker,
            config,
            payment_target_url: Cell::new(None),
        }
    }

    pub fn config(&self) -> &Vet402GuardConfig {
        &self.config
    }

    /// Pin the HTTPS URL passed to vet402 before `check_challenge` (normally set from `send`).
    pub fn with_payment_target_url(self, url: impl Into<String>) -> Self {
        self.payment_target_url.set(Some(url.into()));
        self
    }

    fn payment_url(&self) -> Result<String, HttpFault> {
        let Some(url) = self.payment_target_url.take() else {
            return Err(HttpFault::Payment(Fault::Config(
                "vet402 guard: no payment target URL (wrap Exchange::send must run first)".into(),
            )));
        };
        self.payment_target_url.set(Some(url.clone()));
        if url.is_empty() {
            return Err(HttpFault::Payment(Fault::Config(
                "vet402 guard: empty payment target URL".into(),
            )));
        }
        if !url.starts_with("https://") {
            return Err(unreachable_fault(
                &url,
                "payment target must be https for vet402",
            ));
        }
        Ok(url)
    }

    fn vet402_gate(&self, payment_url: &str) -> Result<(), HttpFault> {
        let vet = match self.checker.check(payment_url) {
            Ok(v) => v,
            Err(error) => {
                return match self.config.on_unreachable {
                    OnUnreachable::Block => Err(unreachable_fault(payment_url, &error.to_string())),
                    OnUnreachable::Allow => Ok(()),
                };
            }
        };

        if vet.recommendation == "BLOCK" {
            return Err(block_fault(payment_url, &vet));
        }

        let warn_like = vet.recommendation == "WARN" || vet.not_in_catalog;
        if self.config.block_on_warn && warn_like {
            return Err(block_fault(payment_url, &vet));
        }

        Ok(())
    }
}

impl<X: Exchange> Exchange for Vet402Guard<X> {
    type Error = X::Error;

    fn check_challenge(&self, challenge: &Challenge) -> Result<(), HttpFault> {
        let payment_url = self.payment_url()?;
        self.vet402_gate(&payment_url)?;
        self.inner.check_challenge(challenge)
    }

    fn http_client(&self) -> Option<nanocode_http::Client> {
        self.inner.http_client()
    }

    fn send(
        &mut self,
        request: nanocode_http::Request,
    ) -> impl Future<Output = Result<nanocode_http::Response, Self::Error>> + Send {
        if let Some(url) = request.url().as_str().split('#').next() {
            self.payment_target_url.set(Some(url.to_string()));
        }
        self.inner.send(request)
    }
}

fn block_fault(payment_url: &str, vet: &Vet402CheckResult) -> HttpFault {
    let codes = if vet.reason_codes.is_empty() {
        vet.recommendation.clone()
    } else {
        vet.reason_codes.join(", ")
    };
    let evidence = vet
        .evidence_url
        .as_deref()
        .map(|u| format!(" evidence={u}"))
        .unwrap_or_default();
    HttpFault::Payment(Fault::Config(format!(
        "vet402 blocked payment to {payment_url}: {codes}{evidence}"
    )))
}

fn unreachable_fault(payment_url: &str, detail: &str) -> HttpFault {
    HttpFault::Payment(Fault::Config(format!(
        "vet402 unreachable for {payment_url}: {detail}"
    )))
}

impl Display for Vet402CheckError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(message) => write!(f, "transport: {message}"),
            Self::InvalidBody(message) => write!(f, "invalid body: {message}"),
        }
    }
}

/// JSON body for `GET /api/v1/check?url=…` (subset used by the guard).
#[derive(Debug, Deserialize)]
struct Vet402CheckBody {
    recommendation: Option<String>,
    #[serde(default)]
    not_in_catalog: Option<bool>,
    #[serde(default)]
    reason_codes: Option<Vec<String>>,
    evidence_url: Option<String>,
    record_url: Option<String>,
}

impl Vet402CheckBody {
    fn into_result(self) -> Result<Vet402CheckResult, Vet402CheckError> {
        let recommendation = self
            .recommendation
            .filter(|r| matches!(r.as_str(), "ALLOW" | "WARN" | "BLOCK"))
            .ok_or_else(|| Vet402CheckError::InvalidBody("missing recommendation".into()))?;
        let not_in_catalog = self.not_in_catalog.unwrap_or(false);
        Ok(Vet402CheckResult {
            recommendation,
            not_in_catalog,
            reason_codes: self.reason_codes.unwrap_or_default(),
            evidence_url: self.evidence_url.or(self.record_url),
        })
    }
}

/// Parse a vet402 check HTTP response body (for live integrations behind your own HTTP client).
pub fn parse_vet402_check_body(body: &[u8]) -> Result<Vet402CheckResult, Vet402CheckError> {
    let parsed: Vet402CheckBody = serde_json::from_slice(body)
        .map_err(|error| Vet402CheckError::InvalidBody(error.to_string()))?;
    parsed.into_result()
}